import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { interrupt } from '@langchain/langgraph';
import type { Connection } from '@solana/web3.js';
import type { AgentConfig } from '../../config/loader.js';
import type { Database, PositionState } from '../../positions/db.js';
import { buildExecutionPlan } from '../../executor/index.js';
import { validateNewPosition, PositionStateMachine } from '../../positions/statemachine.js';
import type { TransitionOptions } from '../../positions/statemachine.js';
import { buildCooldownUntil, shouldStartPoolCooldown } from '../../portfolio/cooldown.js';
import { getLiveCapitalContext } from '../../portfolio/live-capital.js';
import { extractBaseMintFromRawData } from '../../portfolio/token-memory.js';
import type { ScoredOpportunity } from '../../scoring/engine.js';
import { getDecisionSource, logPositionDecisionEpisode } from '../../rag/decision-logger.js';
import type { RAGStore } from '../../rag/store.js';
import { trackPositionOutcome } from '../../rag/outcome-tracker.js';
import { logger } from '../../utils/logger.js';
import { buildExecutionOpportunity } from '../../positions/dlmm-sync.js';
import { claimAndExit, createOneSidedPosition } from '../../executor/active-dlmm.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sc = <T extends z.ZodRawShape>(s: z.ZodObject<T>): any => s;

export function createExecutorTools(config: AgentConfig, db: Database, connection: Connection, ragStore: RAGStore) {
  const sm = new PositionStateMachine(db, config);
  const paperApprovalTiers = new Set(config.risk_tiers.paper_approval_tiers);

  function parseNotes(notes: string | null): Record<string, unknown> {
    if (!notes) {
      return {};
    }
    try {
      const parsed = JSON.parse(notes) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  function isActiveDlmmPosition(position: { protocol: string; deployment_mode?: string | null }): boolean {
    return position.protocol === 'meteora_dlmm' && position.deployment_mode === 'active';
  }

  function buildSyntheticDlmmRange(totalBins: number, positionStyle: string, volatility?: number): { lowerBinId: number; upperBinId: number; binsBelow: number; binsAbove: number } {
    if (positionStyle === 'bid_ask') {
      // bid_ask: one-sided downward range captures volatility on pump/dump cycles.
      // bins_below = clamp(35 + (volatility/5)*34, 35, 69), bins_above = 0.
      // Default volatility=5 → 69 bins below (max range) when unknown.
      const vol = typeof volatility === 'number' && volatility > 0 ? volatility : 5;
      const binsBelow = Math.min(69, Math.max(35, Math.round(35 + (vol / 5) * 34)));
      return {
        lowerBinId: -binsBelow,
        upperBinId: 0,
        binsBelow,
        binsAbove: 0,
      };
    }

    if (positionStyle === 'one_sided_sol') {
      const binsBelow = Math.max(1, Math.floor(totalBins * 0.25));
      const binsAbove = Math.max(1, totalBins - binsBelow);
      return {
        lowerBinId: -binsBelow,
        upperBinId: binsAbove,
        binsBelow,
        binsAbove,
      };
    }

    const half = Math.max(1, Math.floor(totalBins / 2));
    return {
      lowerBinId: -half,
      upperBinId: totalBins - half,
      binsBelow: half,
      binsAbove: Math.max(1, totalBins - half),
    };
  }

  async function persistActiveDlmmOpenMetadata(
    positionId: string,
    position: Awaited<ReturnType<Database['getPosition']>>,
    executionResult: Awaited<ReturnType<typeof createOneSidedPosition>>,
    rawData: Record<string, unknown>,
  ): Promise<void> {
    if (!position || !executionResult.success) {
      return;
    }

    const notes = parseNotes(position.notes);
    const strategy = position.position_style === 'bid_ask' ? 'BidAsk' : 'Spot';
    const totalBins = Number(rawData['totalBins'] ?? executionResult.totalBins ?? 0);
    const syntheticRange = buildSyntheticDlmmRange(totalBins, position.position_style ?? 'two_sided');
    notes['activeDlmm'] = {
      synthetic: executionResult.simulated,
      minBinPrice: executionResult.minBinPrice,
      maxBinPrice: executionResult.maxBinPrice,
      currentPrice: executionResult.currentPrice,
      lastKnownPrice: executionResult.currentPrice,
      takeProfit: rawData['takeProfit'] ?? null,
      stopLoss: rawData['stopLoss'] ?? null,
      maxHoldHours: rawData['maxHoldHours'] ?? null,
      tokenSymbol: executionResult.tokenSymbol,
      poolAddress: executionResult.poolAddress,
    };

    await db.updatePositionExecutionMetadata(positionId, {
      entry_price_sol: executionResult.currentPrice,
      notes: JSON.stringify(notes),
    });

    const existingDlmm = await db.getDlmmPosition(positionId);
    if (!existingDlmm) {
      await db.insertDlmmPosition({
        position_id: positionId,
        position_pubkey: executionResult.positionId,
        pool_pubkey: executionResult.poolAddress,
        lower_bin_id: syntheticRange.lowerBinId,
        upper_bin_id: syntheticRange.upperBinId,
        active_bin_at_deploy: 0,
        strategy,
        bins_below: syntheticRange.binsBelow,
        bins_above: syntheticRange.binsAbove,
        amount_x_deployed: executionResult.depositedSol,
        amount_y_deployed: executionResult.depositedUsdc,
        initial_value_usd: executionResult.depositedUsd,
        bin_step: executionResult.binStep,
        volatility_at_deploy: null,
        fee_tvl_ratio_at_deploy: null,
        organic_score_at_deploy: null,
        base_mint: position.base_mint,
        deployed_at: new Date(executionResult.entryTime).toISOString(),
      });
    }
  }

  const listPositions = tool(
    async ({ state }: { state?: string }) => {
      const positions = state ? await db.getPositionsByState(state as PositionState) : await db.getAllPositions();
      return JSON.stringify({ count: positions.length, positions });
    },
    {
      name: 'list_positions',
      description: 'List positions, optionally filtered by state.',
      schema: sc(z.object({
        state: z.enum(['PENDING_OPEN', 'ACTIVE', 'PENDING_REBALANCE', 'PENDING_CLOSE', 'CLOSED']).optional(),
      })),
    }
  );

  const createPosition = tool(
    async ({
      opportunityId,
      sizeUsd,
      book,
      tier,
      deploymentMode,
      positionStyle,
    }: {
      opportunityId: string;
      sizeUsd: number;
      book?: 'core' | 'scout';
      tier?: number;
      deploymentMode?: 'passive' | 'active';
      positionStyle?: 'two_sided' | 'one_sided_sol' | 'bid_ask';
    }) => {
      // Accept either the DB opportunity UUID or the pool_id (signal payload uses pool_id)
      const directOpportunity = await db.getOpportunity(opportunityId);
      const opportunity = directOpportunity ?? (await db.getLatestOpportunities(100)).find((o) => o.pool_id === opportunityId);
      if (!opportunity) return JSON.stringify({ success: false, error: `Opportunity ${opportunityId} not found — try using the pool_id from the signal or a recent opportunity id` });

      const baseMint = extractBaseMintFromRawData(opportunity.raw_data);
      const validation = await validateNewPosition(sizeUsd, config, db, opportunity.protocol, opportunity.pool_name, opportunity.pool_id, baseMint);
      if (!validation.success) return JSON.stringify({ success: false, error: validation.error });

      if (config.paperTrading) {
        const portfolio = await db.getPaperPortfolio();
        if (portfolio) {
          const deployedUsd = [...(await db.getPositionsByState('ACTIVE')), ...(await db.getPositionsByState('PENDING_OPEN'))]
            .reduce((s, p) => s + p.size_usd, 0);
          const availableCash = portfolio.starting_balance_usd - deployedUsd;
          if (sizeUsd > availableCash) {
            return JSON.stringify({ success: false, error: `Insufficient paper balance: need $${sizeUsd.toFixed(2)}, available $${availableCash.toFixed(2)}` });
          }
        }
      } else if (config.allocator.live_enabled) {
        const liveCapital = await getLiveCapitalContext(config, connection);
        if (sizeUsd > liveCapital.availableCashUsd) {
          return JSON.stringify({
            success: false,
            error: `Insufficient live wallet capital: need $${sizeUsd.toFixed(2)}, available $${liveCapital.availableCashUsd.toFixed(2)}`,
          });
        }
      }

      const requiresHumanApproval = !config.paperTrading || (tier !== undefined && paperApprovalTiers.has(tier as 8 | 9));
      if (requiresHumanApproval) {
        const humanDecision = interrupt({
          action: 'create_position', opportunityId, protocol: opportunity.protocol,
          poolName: opportunity.pool_name, apyPct: opportunity.apy_used, sizeUsd, book: book ?? 'core', tier,
          deploymentMode: deploymentMode ?? 'passive', positionStyle: positionStyle ?? 'two_sided',
          message: `Open ${opportunity.protocol}/${opportunity.pool_name} at ${opportunity.apy_used.toFixed(2)}% APY for $${sizeUsd} in ${book ?? 'core'} book?`,
        });
        if (humanDecision !== 'approved') return JSON.stringify({ success: false, reason: 'rejected_by_human' });
      }

      const position = await db.insertPosition({
        opportunity_id: opportunity.id, protocol: opportunity.protocol,
        pool_id: opportunity.pool_id, pool_name: opportunity.pool_name,
        state: 'PENDING_OPEN', book: book ?? 'core', base_mint: extractBaseMintFromRawData(opportunity.raw_data),
        tier: tier ?? null, deployment_mode: deploymentMode ?? null, position_style: positionStyle ?? null,
        size_usd: sizeUsd, entry_apy: opportunity.apy_used,
        entry_price_sol: null, opened_at: null, closed_at: null, close_reason: null, notes: null,
      });

      // In paper trading mode, auto-transition to ACTIVE immediately — no real tx needed.
      // This prevents positions from getting stuck in PENDING_OPEN if the trader skips
      // the build_execution_plan → transition_state follow-up steps.
      const shouldAutoActivatePaperPosition =
        config.paperTrading &&
        deploymentMode !== 'active' &&
        !(tier !== undefined && paperApprovalTiers.has(tier as 8 | 9));
      if (shouldAutoActivatePaperPosition) {
        const sm = new PositionStateMachine(db, config);
        const txSignature = `PAPER-${position.id.slice(0, 8)}-${Date.now()}`;
        await sm.transition(position.id, 'ACTIVE', { txSignature });
      }

      await logPositionDecisionEpisode({
        db,
        position,
        action: 'open',
        signalTypes: ['LANGGRAPH_EXECUTOR'],
        reasoning: `Opened ${opportunity.protocol}/${opportunity.pool_name} via executor tool [${position.book ?? 'core'}].`,
        marketRegime: null,
        solPriceUsd: null,
        source: getDecisionSource(config.paperTrading),
      });

      const finalState = shouldAutoActivatePaperPosition ? 'ACTIVE' : position.state;
      return JSON.stringify({
        success: true,
        positionId: position.id,
        state: finalState,
        requiresApproval: tier !== undefined && paperApprovalTiers.has(tier as 8 | 9),
      });
    },
    {
      name: 'create_position',
      description: 'Create a position in PENDING_OPEN state. In paper trading mode most flows auto-approve, but tier 8/9 active entries still interrupt for HITL. Accepts either the DB opportunity id or the pool_id from signal payloads.',
      schema: sc(z.object({
        opportunityId: z.string(),
        sizeUsd: z.number(),
        book: z.enum(['core', 'scout']).optional(),
        tier: z.number().int().optional(),
        deploymentMode: z.enum(['passive', 'active']).optional(),
        positionStyle: z.enum(['two_sided', 'one_sided_sol', 'bid_ask']).optional(),
      })),
    }
  );

  const buildExecutionPlanTool = tool(
    async ({ positionId, action }: { positionId: string; action: 'open' | 'close' | 'rebalance' | 'claim_fee' }) => {
      const position = await db.getPosition(positionId);
      if (!position) return JSON.stringify({ success: false, error: `Position ${positionId} not found` });

      const opp = await db.getOpportunity(position.opportunity_id);
      const scoredProxy: ScoredOpportunity = buildExecutionOpportunity(position, opp);

      if (isActiveDlmmPosition(position)) {
        const rawData = ((opp?.raw_data ?? scoredProxy.raw_data ?? {}) as Record<string, unknown>);

        if (action === 'open') {
          const executionResult = await createOneSidedPosition({
            poolAddress: position.pool_id,
            tokenSymbol: String(rawData['tokenSymbol'] ?? position.pool_name),
            tier: position.tier ?? 0,
            positionStyle: (position.position_style ?? String(rawData['positionStyle'] ?? 'one_sided_sol')) as 'two_sided' | 'one_sided_sol' | 'bid_ask',
            depositToken: (String(rawData['depositToken'] ?? 'sol')) as 'sol' | 'usdc' | 'both',
            amountUsd: position.size_usd,
            binStep: Number(rawData['binStep'] ?? 100),
            totalBins: Number(rawData['totalBins'] ?? 70),
            rangeType: (String(rawData['rangeType'] ?? 'tight')) as 'wide' | 'medium' | 'tight' | 'ultra_tight',
            takeProfit: Number(rawData['takeProfit'] ?? 0.2),
            stopLoss: Number(rawData['stopLoss'] ?? 0.12),
            maxHoldHours: Number(rawData['maxHoldHours'] ?? 12),
          });

          const logEntry = await db.insertExecutionLog({
            position_id: positionId,
            action,
            tx_base64: null,
            simulation_result: JSON.stringify(executionResult),
            executed: executionResult.simulated ? 0 : 1,
            tx_signature: executionResult.simulated ? null : executionResult.txSignature ?? null,
          });

          const requiresHumanApproval = !config.paperTrading || (action === 'open' && position.tier !== null && position.tier !== undefined && paperApprovalTiers.has(position.tier as 8 | 9));
          if (requiresHumanApproval) {
            const humanDecision = interrupt({
              action: 'execute_transaction', positionId, txAction: action,
              protocol: position.protocol, poolName: position.pool_name, logId: logEntry.id,
              tier: position.tier ?? null, deploymentMode: position.deployment_mode ?? null, positionStyle: position.position_style ?? null,
              message: `Execute ${action} for ${position.protocol}/${position.pool_name}? (Sim: ${executionResult.success ? 'PASS' : 'FAIL'})`,
            });
            if (humanDecision !== 'approved') return JSON.stringify({ success: false, reason: 'rejected_by_human', plan: executionResult });
          }

          if (executionResult.success) {
            await persistActiveDlmmOpenMetadata(positionId, position, executionResult, rawData);
          }

          const paperTxSignature = config.paperTrading ? `PAPER-${positionId.slice(0, 8)}-${Date.now()}` : executionResult.txSignature;
          return JSON.stringify({
            success: executionResult.success,
            plan: {
              logId: logEntry.id,
              positionId,
              action,
              txBase64: null,
              txSignatures: executionResult.txSignature ? [executionResult.txSignature] : [],
              simSuccess: executionResult.success,
              simLogs: [JSON.stringify(executionResult.metadata)],
              isDryRun: config.dryRun || config.paperTrading,
            },
            ...(paperTxSignature ? { paperTxSignature } : {}),
            activeDlmmResult: executionResult,
          });
        }

        if (action === 'close') {
          const latestPnl = await db.getLatestPnlSnapshot(positionId, 'mark_to_market');
          const currentValueUsd = latestPnl?.current_value_usd ?? position.size_usd;
          const exitResult = await claimAndExit(
            positionId,
            position.pool_id,
            String(rawData['tokenSymbol'] ?? position.pool_name),
            position.close_reason ?? 'manual',
            position.size_usd,
            currentValueUsd,
          );

          const logEntry = await db.insertExecutionLog({
            position_id: positionId,
            action,
            tx_base64: null,
            simulation_result: JSON.stringify(exitResult),
            executed: exitResult.simulated ? 0 : 1,
            tx_signature: exitResult.simulated ? null : exitResult.txSignature ?? null,
            exit_reason: exitResult.exitReason,
          });

          const paperTxSignature = config.paperTrading ? `PAPER-${positionId.slice(0, 8)}-${Date.now()}` : exitResult.txSignature;
          return JSON.stringify({
            success: exitResult.success,
            plan: {
              logId: logEntry.id,
              positionId,
              action,
              txBase64: null,
              txSignatures: exitResult.txSignature ? [exitResult.txSignature] : [],
              simSuccess: exitResult.success,
              simLogs: [JSON.stringify(exitResult)],
              isDryRun: config.dryRun || config.paperTrading,
            },
            ...(paperTxSignature ? { paperTxSignature } : {}),
            activeDlmmResult: exitResult,
          });
        }
      }

      const plan = await buildExecutionPlan(scoredProxy, positionId, action, connection, config, db);

      const requiresHumanApproval = !config.paperTrading || (action === 'open' && position.tier !== null && position.tier !== undefined && paperApprovalTiers.has(position.tier as 8 | 9));
      if (requiresHumanApproval) {
        const humanDecision = interrupt({
          action: 'execute_transaction', positionId, txAction: action,
          protocol: position.protocol, poolName: position.pool_name, logId: plan.logId,
          tier: position.tier ?? null, deploymentMode: position.deployment_mode ?? null, positionStyle: position.position_style ?? null,
          message: `Execute ${action} for ${position.protocol}/${position.pool_name}? (Sim: ${plan.simSuccess === true ? 'PASS' : plan.isDryRun ? 'DRY_RUN' : 'FAIL'})`,
        });
        if (humanDecision !== 'approved') return JSON.stringify({ success: false, reason: 'rejected_by_human', plan });
      }

      // In paper trading mode, provide a synthetic txSignature so the Trader can transition
      // the position from PENDING_OPEN → ACTIVE without a real blockchain transaction.
      const paperTxSignature = config.paperTrading
        ? `PAPER-${positionId.slice(0, 8)}-${Date.now()}`
        : undefined;

      return JSON.stringify({
        success: true,
        plan,
        ...(paperTxSignature !== undefined && {
          paperTxSignature,
          note: 'Paper trade auto-approved. Use paperTxSignature as txSignature to transition position to ACTIVE.',
        }),
      });
    },
    {
        name: 'build_execution_plan',
        description: 'Build and simulate a transaction. Tier 8/9 active entries can still interrupt for human approval even in paper mode.',
        schema: sc(z.object({
          positionId: z.string(),
          action: z.enum(['open', 'close', 'rebalance', 'claim_fee']),
        })),
      }
  );

  const transitionPosition = tool(
    async ({ positionId, targetState, txSignature, closeReason }: {
      positionId: string; targetState: string; txSignature?: string; closeReason?: string;
    }) => {
      const currentPosition = await db.getPosition(positionId);
      if (!currentPosition) {
        return JSON.stringify({ success: false, error: `Position ${positionId} not found` });
      }

      const opts: TransitionOptions = {};
      if (txSignature !== undefined) opts.txSignature = txSignature;
      if (closeReason !== undefined) opts.closeReason = closeReason as Exclude<TransitionOptions['closeReason'], undefined>;
      const result = await sm.transition(positionId, targetState as PositionState, opts);

      if (!result.success) {
        return JSON.stringify(result);
      }

      const isCloseTransition =
        targetState === 'PENDING_CLOSE' ||
        (targetState === 'CLOSED' && currentPosition.state !== 'PENDING_CLOSE');

      if (isCloseTransition) {
        await logPositionDecisionEpisode({
          db,
          position: currentPosition,
          action: 'close',
          signalTypes: ['LANGGRAPH_EXECUTOR'],
          reasoning: `Closed ${currentPosition.protocol}/${currentPosition.pool_name} via executor tool (${closeReason ?? 'manual'}).`,
          marketRegime: null,
          solPriceUsd: null,
          source: getDecisionSource(config.paperTrading),
        });
      }

      // Feedback loop: when a position reaches CLOSED, track the outcome
      if (targetState === 'CLOSED') {
          const position = await db.getPosition(positionId);
        if (position) {
          const cooldownReason = closeReason;
          if (cooldownReason && shouldStartPoolCooldown(cooldownReason)) {
            await db.upsertPoolCooldown({
              pool_id: position.pool_id,
              reason: cooldownReason,
              cooldown_until: buildCooldownUntil(
                new Date().toISOString(),
                config.allocator.cooldown_hours_after_bad_exit,
              ),
              source_position_id: position.id,
            });
          }

          try {
            await trackPositionOutcome(
              db,
              ragStore,
              position,
              closeReason ?? 'manual',
              null, // regime will be fetched if available
              null  // SOL price will be fetched if available
            );
          } catch (err) {
            logger.warn({ err, positionId }, 'Failed to track position outcome — non-critical');
          }
        }
      }

      return JSON.stringify(result);
    },
    {
      name: 'transition_position',
      description: 'Transition a position to a new state. PENDING_OPEN→ACTIVE requires txSignature.',
      schema: sc(z.object({
        positionId: z.string(),
        targetState: z.enum(['ACTIVE', 'PENDING_REBALANCE', 'PENDING_CLOSE', 'CLOSED']),
        txSignature: z.string().optional(),
        closeReason: z.enum([
          'manual',
          'rebalance',
          'circuit_breaker',
          'apy_drop',
          'stop_loss',
          'take_profit',
          'trailing_take_profit',
          'time_stop',
          'out_of_range',
          'rug_detected',
          'oor_timeout',
          'fee_yield_low',
          'pumped_past_range',
        ]).optional(),
      })),
    }
  );

  return { listPositions, createPosition, buildExecutionPlanTool, transitionPosition };
}

export type ExecutorTools = ReturnType<typeof createExecutorTools>;
