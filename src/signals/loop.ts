import type { Connection } from '@solana/web3.js';
import { createSolanaRpc } from '@solana/rpc';
import { v4 as uuidv4 } from 'uuid';
import type { AgentConfig } from '../config/loader.js';
import type { Database } from '../positions/db.js';
import type { TelegramReporter } from '../reporter/telegram.js';
import { logger } from '../utils/logger.js';
import { buildExecutionPlan } from '../executor/index.js';
import { getOpenAllocationIntents, planCapitalIntents } from '../portfolio/capital-planner.js';
import { getLiveCapitalContext } from '../portfolio/live-capital.js';
import { executePaperAllocationPlan } from '../portfolio/paper-allocation.js';
import { extractBaseMintFromOpportunity } from '../portfolio/token-memory.js';
import { monitorDlmmPositions, dynamicManagementInterval } from '../positions/dlmm-monitor.js';
import { PortfolioRebalancer } from '../positions/portfolio-rebalancer.js';
import { getActivePortfolio } from '../config/portfolio-config.js';
import { DataPoller } from './poller.js';
import { detectSignals } from './detector.js';
import { ActiveDlmmDetector } from './active-dlmm-detector.js';
import { SignalQueue } from './queue.js';
import { SignalDispatcher, type DispatchHandler } from './dispatcher.js';
import { SIGNAL_PRIORITY, type Signal } from './types.js';
import type { MarketSnapshot } from './snapshot.js';
import type { MarketSnapshot as MS } from './snapshot.js';
import { computeCashFlowPnl } from '../positions/pnl.js';
import type { ScoredOpportunity } from '../scoring/engine.js';

type KitRpc = ReturnType<typeof createSolanaRpc>;

function toNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildDiscoveryOpportunity(signal: Signal, portfolioConfig: ReturnType<typeof getActivePortfolio>): ScoredOpportunity | null {
  if (signal.type !== 'VOLUME_SPIKE' && signal.type !== 'MEME_POOL_DISCOVERED') {
    return null;
  }

  const payload = signal.payload as Record<string, unknown>;
  const tier = toNumber(payload['recommendedTier']);
  if (tier <= 0 || !portfolioConfig.active_tiers.includes(tier as 2 | 5 | 8 | 1 | 3 | 4 | 6 | 7 | 9)) {
    return null;
  }

  const tierConfig = portfolioConfig.getTierConfig(tier as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9);
  const confidence = Math.max(0, Math.min(1, toNumber(payload['confidenceScore'])));
  const volume24hUsd = toNumber(payload['volume24hUsd'], toNumber(payload['volume1hUsd']) * 24);
  const tvlUsd = toNumber(payload['liquidityUsd']);
  const priceChange1hPct = toNumber(payload['priceChange1hPct']);
  const ilRiskScore = Math.max(0, Math.min(1, 1 - confidence / 1.25));
  const apyUsed = Math.max(tierConfig.min_fee_apr_pct, Math.min(tierConfig.target_apy_pct * (0.8 + confidence), tierConfig.target_apy_pct * 2));
  const apyNorm = Math.min(apyUsed / Math.max(tierConfig.target_apy_pct * 2, 1), 1);
  const volumeNorm = Math.min(volume24hUsd / 1_000_000, 1);
  const tvlNorm = tierConfig.max_pool_tvl_usd > 0 ? Math.min(tvlUsd / tierConfig.max_pool_tvl_usd, 1) : 0.5;
  const momentumNorm = Math.max(Math.min(priceChange1hPct / 30, 1), 0);
  const score = Math.round((
    tierConfig.score_weight_apy * apyNorm +
    tierConfig.score_weight_volume * volumeNorm +
    tierConfig.score_weight_tvl * tvlNorm +
    tierConfig.score_weight_momentum * momentumNorm +
    tierConfig.score_weight_il_risk * (1 - ilRiskScore)
  ) * 10000) / 100;

  let recommendation: ScoredOpportunity['recommendation'] = 'SKIP';
  if (score >= 50) {
    recommendation = 'SUGGEST';
  } else if (score >= 45) {
    recommendation = 'WATCH';
  }

  const tokenSymbol = String(payload['tokenSymbol'] ?? 'UNKNOWN');
  const poolAddress = String(payload['poolAddress'] ?? '');
  const poolName = tokenSymbol.length > 0 ? `${tokenSymbol}-SOL` : poolAddress;

  return {
    poolId: poolAddress,
    protocol: 'meteora_dlmm',
    poolName,
    apyDefillama: null,
    apyProtocol: apyUsed,
    apyUsed,
    tvlUsd,
    dataUncertain: confidence < 0.35,
    score,
    apyScore: apyNorm * 100,
    liquidityScore: tvlNorm * 100,
    trustScore: confidence * 100,
    riskPenalty: ilRiskScore * 10,
    regimePenalty: 0,
    recommendation,
    raw_data: {
      isDiscovery: true,
      signalType: signal.type,
      source: payload['source'] ?? 'unknown',
      recommendedTier: tier,
      confidenceScore: confidence,
      deploymentMode: 'active',
      positionStyle: tierConfig.meteora_position_style,
      depositToken: tierConfig.meteora_deposit_token,
      binStep: tierConfig.meteora_bin_step,
      totalBins: tierConfig.meteora_total_bins,
      rangeType: tierConfig.meteora_range_type,
      takeProfit: tierConfig.take_profit_pct,
      stopLoss: Math.abs(tierConfig.stop_loss_pct),
      maxHoldHours: tierConfig.max_hold_hours,
      tokenSymbol,
      dexUrl: payload['dexUrl'] ?? '',
      volume24hUsd,
      volume1hUsd: toNumber(payload['volume1hUsd']),
      volume5mUsd: toNumber(payload['volume5mUsd']),
      liquidityUsd: tvlUsd,
      priceChange1hPct,
      priceChange30mPct: toNumber(payload['priceChange30mPct']),
      poolAgeHours: toNumber(payload['poolAgeHours']),
      fdvUsd: toNumber(payload['fdvUsd']),
      spikeRatio: toNumber(payload['spikeRatio']),
    },
  };
}

async function persistDiscoveryOpportunities(
  db: Database,
  portfolioConfig: ReturnType<typeof getActivePortfolio>,
  signals: Signal[],
): Promise<ScoredOpportunity[]> {
  const derived = signals
    .map((signal) => buildDiscoveryOpportunity(signal, portfolioConfig))
    .filter((opportunity): opportunity is ScoredOpportunity => opportunity !== null);

  for (const opportunity of derived) {
    await db.insertOpportunity({
      protocol: opportunity.protocol,
      pool_id: opportunity.poolId,
      pool_name: opportunity.poolName,
      apy_defillama: opportunity.apyDefillama,
      apy_protocol: opportunity.apyProtocol,
      apy_used: opportunity.apyUsed,
      data_uncertain: opportunity.dataUncertain ? 1 : 0,
      tvl_usd: opportunity.tvlUsd,
      score: opportunity.score,
      raw_data: opportunity.raw_data ?? null,
    });
  }

  return derived;
}

function mergeOpportunities(base: ScoredOpportunity[], derived: ScoredOpportunity[]): ScoredOpportunity[] {
  const merged = new Map<string, ScoredOpportunity>();
  for (const opportunity of base) {
    merged.set(opportunity.poolId, opportunity);
  }
  for (const opportunity of derived) {
    merged.set(opportunity.poolId, opportunity);
  }
  return [...merged.values()];
}

// ---------------------------------------------------------------------------
// Main Event Loop
// ---------------------------------------------------------------------------
// Wires Tier 1 → Tier 2 → Tier 3 → Tier 4:
//   Poller (5min) → Detector → Queue → Dispatcher
//
// Replaces the node-cron scheduler in agent.ts.
// ---------------------------------------------------------------------------

export interface SignalLoopHandles {
  poller: DataPoller;
  queue: SignalQueue;
  dispatcher: SignalDispatcher;
  stop: () => void;
}

export function startSignalLoop(
  config: AgentConfig,
  db: Database,
  connection: Connection,
  kitRpc: KitRpc,
  reporter: TelegramReporter,
  dispatchHandler?: DispatchHandler
): SignalLoopHandles {
  const queue = new SignalQueue(db);
  const dispatcher = new SignalDispatcher(config, db, queue, reporter);

  if (dispatchHandler) {
    dispatcher.setDispatchHandler(dispatchHandler);
  }

  const poller = new DataPoller(config, db, connection, kitRpc);
  const activeDlmmDetector = new ActiveDlmmDetector();
  const portfolioRebalancer = new PortfolioRebalancer(db);
  const portfolioConfig = getActivePortfolio();
  let dlmmMonitorTimer: ReturnType<typeof setInterval> | null = null;
  let latestMarketSnapshot: MarketSnapshot | null = null;
  let lastDiscoveryScanAt = 0;

  dispatcher.setBatchBuilder(async (signals) => {
    const derivedSignalOpportunities = signals
      .map((signal) => buildDiscoveryOpportunity(signal, portfolioConfig))
      .filter((opportunity): opportunity is ScoredOpportunity => opportunity !== null);
    const marketSnapshot = latestMarketSnapshot ?? (await db.getLatestSnapshot() as MarketSnapshot | null) ?? null;
    const activeAndPending = [
      ...(await db.getPositionsByState('ACTIVE')),
      ...(await db.getPositionsByState('PENDING_OPEN')),
    ];
    const deployedUsd = activeAndPending.reduce((sum, position) => sum + position.size_usd, 0);

    let portfolioUsd = config.paperStartingBalanceUsd;
    let availableCashUsd = 0;

    if (config.paperTrading) {
      const portfolio = await db.getPaperPortfolio();
      portfolioUsd = portfolio?.starting_balance_usd ?? config.paperStartingBalanceUsd;
      availableCashUsd = Math.max(0, portfolioUsd - deployedUsd);
    } else {
      const liveCapital = await getLiveCapitalContext(config, connection, marketSnapshot?.solPriceUsd ?? null);
      portfolioUsd = Math.max(deployedUsd, liveCapital.portfolioUsd);
      availableCashUsd = liveCapital.availableCashUsd;
    }

    const protocolBookStats = await db.getProtocolBookStats(
      poller.lastScoredOpportunities.map((opportunity) => opportunity.protocol)
    );
    const baseMintBookStats = await db.getBaseMintBookStats(
      poller.lastScoredOpportunities
        .map((opportunity) => extractBaseMintFromOpportunity(opportunity))
        .filter((baseMint): baseMint is string => baseMint !== null)
    );

    const plannedIntents = planCapitalIntents({
      signals,
      opportunities: poller.lastScoredOpportunities,
      activePoolIds: new Set(activeAndPending.map((position) => position.pool_id)),
      cooledPoolIds: new Set((await db.getActivePoolCooldowns()).map((cooldown) => cooldown.pool_id)),
      activePositions: activeAndPending,
      paperTrading: config.paperTrading,
      portfolioUsd,
      availableCashUsd,
      activePositionCount: activeAndPending.length,
      maxOpenPositions: config.position.max_open_positions,
      minPositionUsd: config.position.min_position_usd,
      maxPositionUsd: config.position.max_position_usd,
      maxGroupConcentrationPct: config.position.max_group_concentration_pct,
      protocolBookStats,
      baseMintBookStats,
      allocator: config.allocator,
    });

      return {
        signals,
        capitalIntents: config.paperTrading
        ? plannedIntents.filter((intent) => intent.action !== 'open')
        : plannedIntents,
        marketSnapshot,
        opportunities: mergeOpportunities(poller.lastScoredOpportunities, derivedSignalOpportunities),
      };
  });

  const maybeRunPaperAllocator = async (signalTypes: string[], solPriceUsd: number) => {
    if (!config.paperTrading || !config.allocator.enabled) {
      return;
    }

    const portfolio = await db.getPaperPortfolio();
    if (!portfolio) {
      return;
    }

    const activeAndPending = [
      ...(await db.getPositionsByState('ACTIVE')),
      ...(await db.getPositionsByState('PENDING_OPEN')),
    ];
    const deployedUsd = activeAndPending.reduce((sum, position) => sum + position.size_usd, 0);
    const availableCashUsd = Math.max(0, portfolio.starting_balance_usd - deployedUsd);

    const capitalIntents = planCapitalIntents({
      signals: signalTypes.map((type, index) => ({
        id: `allocator-${index}-${type}`,
        type: type as Signal['type'],
        priority: 'LOW',
        timestamp: new Date().toISOString(),
        payload: {},
        dedupKey: `allocator:${type}:${index}`,
        processed: false,
        threadId: null,
      })),
      opportunities: poller.lastScoredOpportunities,
      activePoolIds: new Set(activeAndPending.map((position) => position.pool_id)),
       cooledPoolIds: new Set((await db.getActivePoolCooldowns()).map((cooldown) => cooldown.pool_id)),
      activePositions: activeAndPending,
      paperTrading: true,
      portfolioUsd: portfolio.starting_balance_usd,
      availableCashUsd,
      activePositionCount: activeAndPending.length,
      maxOpenPositions: config.position.max_open_positions,
      minPositionUsd: config.position.min_position_usd,
      maxPositionUsd: config.position.max_position_usd,
      maxGroupConcentrationPct: config.position.max_group_concentration_pct,
       protocolBookStats: await db.getProtocolBookStats(
         poller.lastScoredOpportunities.map((opportunity) => opportunity.protocol)
       ),
       baseMintBookStats: await db.getBaseMintBookStats(
         poller.lastScoredOpportunities
           .map((opportunity) => extractBaseMintFromOpportunity(opportunity))
           .filter((baseMint): baseMint is string => baseMint !== null)
      ),
      allocator: config.allocator,
    });
    const intents = getOpenAllocationIntents(capitalIntents).filter((intent) => {
      const rawData = intent.opportunity.raw_data ?? {};
      const isDiscoveryOpportunity = rawData['isDiscovery'] === true;
      const isActiveTierStyle = portfolioConfig.active_tiers.some((tier) => tier >= 6);
      return !(isDiscoveryOpportunity && isActiveTierStyle);
    });
    if (intents.length === 0) {
      return;
    }

    const result = await executePaperAllocationPlan({
      intents,
      db,
      config,
      connection,
      buildExecutionPlanFn: (opportunity, positionId, runtimeConnection, runtimeConfig, runtimeDb) =>
        buildExecutionPlan(opportunity, positionId, 'open', runtimeConnection, runtimeConfig, runtimeDb),
      signalTypes,
      reasoning: `Deterministic allocator executed ${intents.length} paper allocation(s)`,
      marketRegime: null,
      solPriceUsd,
    });

    if (result.openedPositionIds.length > 0) {
      logger.info({ opened: result.openedPositionIds.length }, 'Deterministic paper allocator opened positions');
    }
  };

  const onSnapshot = async (currentSnapshot: MarketSnapshot) => {
    latestMarketSnapshot = currentSnapshot;

    // Retrieve the previous snapshot for delta comparison
    const previousRaw = await db.getPreviousSnapshot() as MS | undefined;
    const previous = previousRaw ?? null;

    // Get current active positions for position-based signal detection
    const activePositions = await db.getPositionsByState('ACTIVE');

    // Detect signals
    const signals = detectSignals(currentSnapshot, previous, activePositions, config);

    const activeTierSignalsEnabled = portfolioConfig.active_tiers.some((tier) => tier >= 6);
    if (activeTierSignalsEnabled) {
      const mintByPoolId = new Map(
        poller.lastScoredOpportunities
          .map((opp) => {
            const mint = extractBaseMintFromOpportunity(opp);
            return mint !== null ? ([opp.poolId, mint] as [string, string]) : null;
          })
          .filter((entry): entry is [string, string] => entry !== null),
      );
      const knownPools = currentSnapshot.pools
        .filter((pool) => pool.protocol === 'meteora_dlmm')
        .flatMap((pool) => {
          const tokenMint = mintByPoolId.get(pool.poolId);
          return tokenMint !== undefined ? [{ poolId: pool.poolId, tokenMint }] : [];
        });
      signals.push(...(await activeDlmmDetector.scanForVolumeSpikes(knownPools)));
    }

    const discoveryIntervalMs = config.discoveryScanIntervalMin * 60 * 1000;
    if (config.enableMemeDiscovery && Date.now() - lastDiscoveryScanAt >= discoveryIntervalMs) {
      signals.push(...(await activeDlmmDetector.discoverMemePools()));
      lastDiscoveryScanAt = Date.now();
    }

    const derivedSignalOpportunities = await persistDiscoveryOpportunities(db, portfolioConfig, signals);

    const currentActiveValueUsd = activePositions.reduce((sum, position) => sum + position.size_usd, 0);
    const currentPortfolioValueUsd = config.paperTrading
      ? Math.max(config.paperStartingBalanceUsd, currentActiveValueUsd)
      : currentActiveValueUsd;
    await portfolioRebalancer.recordPortfolioValue(currentPortfolioValueUsd);
    const allocationBaseUsd = Math.max(portfolioConfig.total_capital_usd, currentPortfolioValueUsd, 1);
    const currentAllocations = Object.fromEntries(
      portfolioConfig.active_tiers.map((tier) => {
        const deployedUsd = activePositions
          .filter((position) => (position.tier ?? null) === tier)
          .reduce((sum, position) => sum + position.size_usd, 0);
        return [tier, deployedUsd / allocationBaseUsd];
      }),
    ) as Record<number, number>;
    signals.push(...(await portfolioRebalancer.checkCircuitBreakers({
      portfolio: portfolioConfig,
      currentValueUsd: currentPortfolioValueUsd,
      currentAllocations,
      solPriceChangePct:
        previous && previous.solPriceUsd > 0
          ? (currentSnapshot.solPriceUsd - previous.solPriceUsd) / previous.solPriceUsd
          : 0,
      affectedPositionIds: activePositions.map((position) => position.id),
    })));

    if (signals.length > 0) {
      const newCount = await queue.enqueue(signals);
      logger.info({ detected: signals.length, new: newCount, derivedOpportunities: derivedSignalOpportunities.length }, 'Signal detection complete');
    }

    await maybeRunPaperAllocator(
      signals.length > 0 ? signals.map((signal) => signal.type) : ['HEARTBEAT'],
      currentSnapshot.solPriceUsd,
    );

    // Tick the dispatcher (checks priorities, fires appropriate handlers)
    await dispatcher.tick();

    // Record PnL and APY snapshots for active positions
    const poolMap = new Map(currentSnapshot.pools.map((p) => [p.poolId, p]));
    for (const position of activePositions) {
      try {
        const currentPool = poolMap.get(position.pool_id);
        if (currentPool) {
          await db.insertApySnapshot({
            position_id: position.id,
            current_apy_pct: currentPool.apyPct,
            pool_tvl_usd: currentPool.tvlUsd,
          });
        }

        const pnl = computeCashFlowPnl(position);
        await db.insertPnlSnapshot({
          position_id: position.id,
          method: 'cash_flow',
          yield_earned_usd: pnl.yieldEarnedUsd,
          gas_paid_usd: pnl.gasPaidUsd,
          cash_flow_pnl_usd: pnl.cashFlowPnlUsd,
          cost_basis_usd: position.size_usd,
          current_value_usd: position.size_usd + pnl.yieldEarnedUsd,
          mtm_pnl_usd: pnl.cashFlowPnlUsd,
        });
      } catch (err) {
        logger.error({ err, positionId: position.id }, 'Failed to record snapshot for position');
      }
    }
  };

  const startDlmmMonitorLoop = () => {
    if (!config.meteora.enabled || !config.agentWalletAddress) {
      return;
    }

    const baseIntervalMinutes = config.meteora.management.management_interval_minutes;

    // Adaptive interval: schedule next tick using setTimeout rather than fixed setInterval.
    // Interval shrinks for high-volatility (high-tier) positions.
    const scheduleNext = (overrideMs?: number): void => {
      if (overrideMs !== undefined) {
        dlmmMonitorTimer = setTimeout(() => void runMonitorTick(), overrideMs);
        return;
      }
      db.getPositionsByState('ACTIVE').then((active) => {
        const maxTier = active.reduce((m, p) => Math.max(m, p.tier ?? 0), 0);
        // Map tier → volatility proxy: tier ≥ 8 = vol 5 (3 min), tier 5-7 = vol 3 (5 min), else base
        const volProxy = maxTier >= 8 ? 5 : maxTier >= 5 ? 3 : 1;
        const nextMinutes = dynamicManagementInterval(volProxy, baseIntervalMinutes);
        logger.debug({ nextMinutes, maxTier }, 'DLMM monitor: adaptive interval scheduled');
        dlmmMonitorTimer = setTimeout(() => void runMonitorTick(), nextMinutes * 60 * 1000);
      }).catch(() => {
        dlmmMonitorTimer = setTimeout(() => void runMonitorTick(), baseIntervalMinutes * 60 * 1000);
      });
    };

    const runMonitorTick = async (): Promise<void> => {
      try {
        const decisions = await monitorDlmmPositions(db, config, config.agentWalletAddress!);
        const actionable = decisions.filter((decision) => decision.action !== 'hold');
        if (actionable.length > 0) {
          const bucket = new Date().toISOString().slice(0, 16);
          const signals: Signal[] = [];
          for (const decision of actionable) {
            const trackedPosition = await db.getPosition(decision.positionId);
            const timestamp = new Date().toISOString();
            if (decision.action === 'close') {
              const isOorClose = decision.closeReason === 'oor_timeout' || decision.closeReason === 'pumped_past_range';
              const normalizedExitReason = isOorClose ? 'out_of_range' : decision.closeReason ?? 'manual';

              // Gap 2: OOR cooldown — pool-level + token-level tracking
              if (isOorClose) {
                const cooldownUntil = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
                db.upsertPoolCooldown({
                  pool_id: decision.poolAddress,
                  reason: 'oor_exit',
                  cooldown_until: cooldownUntil,
                  source_position_id: decision.positionId,
                }).catch((err) => logger.warn({ err }, 'OOR pool cooldown insert failed'));

                const baseMint = trackedPosition?.base_mint;
                if (baseMint) {
                  db.recordOorTokenExit(baseMint, 3, 12).then((row) => {
                    if (row.cooldown_until) {
                      logger.info({ baseMint: baseMint.slice(0, 8), exitCount: row.exit_count }, 'OOR token cooldown activated');
                    }
                  }).catch((err) => logger.warn({ err }, 'OOR token exit record failed'));
                }
              }

              signals.push({
                id: uuidv4(),
                type: 'POSITION_AUTO_EXIT',
                priority: SIGNAL_PRIORITY['POSITION_AUTO_EXIT'],
                timestamp,
                payload: {
                  positionId: decision.positionId,
                  poolAddress: decision.poolAddress,
                  tokenSymbol: trackedPosition?.pool_name ?? trackedPosition?.pool_id ?? 'UNKNOWN',
                  tier: trackedPosition?.tier ?? 0,
                  exitReason: normalizedExitReason,
                  currentPnlPct: decision.pnl.pnlPct / 100,
                  holdHours: (decision.pnl.ageMinutes ?? 0) / 60,
                  entryPrice: trackedPosition?.entry_price_sol ?? 0,
                  currentPrice: decision.pnl.currentPrice ?? trackedPosition?.entry_price_sol ?? 0,
                  positionValueUsd: decision.pnl.currentValueUsd,
                  unclaimedFeesUsd: decision.pnl.unclaimedFeesUsd,
                },
                dedupKey: `POSITION_AUTO_EXIT:${decision.positionId}:${bucket}`,
                processed: false,
                threadId: null,
              });
              continue;
            }

            signals.push({
              id: uuidv4(),
              type: decision.signalType,
              priority: SIGNAL_PRIORITY[decision.signalType],
              timestamp,
              payload: {
                positionId: decision.positionId,
                positionPubkey: decision.positionPubkey,
                poolAddress: decision.poolAddress,
                closeReason: decision.closeReason,
                action: decision.action,
                notes: decision.notes,
                pnlPct: decision.pnl.pnlPct,
                currentValueUsd: decision.pnl.currentValueUsd,
                unclaimedFeesUsd: decision.pnl.unclaimedFeesUsd,
                peakPnlPct: decision.peakPnlPct,
                drawdownPct: decision.drawdownPct,
                armProfitPct: decision.trailArmProfitPct,
                activeBinId: decision.pnl.activeBinId,
                lowerBinId: decision.pnl.lowerBinId,
                upperBinId: decision.pnl.upperBinId,
                ageMinutes: decision.pnl.ageMinutes,
                feePerTvl24h: decision.pnl.feePerTvl24h,
              },
              dedupKey: `${decision.signalType}:${decision.positionId}:${bucket}`,
              processed: false,
              threadId: null,
            });
          }

          const newCount = await queue.enqueue(signals);
          if (newCount > 0) {
            logger.info({ detected: signals.length, new: newCount }, 'DLMM monitor enqueued signals');
            await dispatcher.tick();
          }
        }
      } catch (err) {
        logger.warn({ err }, 'DLMM monitor loop failed');
      }
      scheduleNext();
    };

    void runMonitorTick();
    logger.info({ baseIntervalMinutes }, 'DLMM monitor loop started');
  };

  const startTime = Date.now();
  
  poller.start((snapshot) => {
    onSnapshot(snapshot)
      .then(() => {
        logger.info(
          { 
            tick: poller.tickCount, 
            uptimeSec: Math.floor((Date.now() - startTime) / 1000), 
            poolCount: snapshot.pools.length 
          },
          'HEARTBEAT: signal pipeline alive'
        );
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'Signal loop error in onSnapshot callback');
      });
  });

  startDlmmMonitorLoop();

  const stop = () => {
    poller.stop();
    if (dlmmMonitorTimer !== null) {
      clearTimeout(dlmmMonitorTimer);
      dlmmMonitorTimer = null;
    }
    logger.info('Signal loop stopped');
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  logger.info('Signal loop started');

  return { poller, queue, dispatcher, stop };
}
