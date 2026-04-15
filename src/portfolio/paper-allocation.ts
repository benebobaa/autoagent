import type { Connection } from '@solana/web3.js';
import type { AgentConfig } from '../config/loader.js';
import type { Database } from '../positions/db.js';
import { PositionStateMachine, validateNewPosition } from '../positions/statemachine.js';
import type { ExecutionPlan } from '../executor/index.js';
import type { AllocationIntent } from './allocator.js';
import type { MarketRegime } from '../signals/regime.js';
import { logPositionDecisionEpisode } from '../rag/decision-logger.js';
import { extractBaseMintFromRawData } from './token-memory.js';
import { logger } from '../utils/logger.js';

export interface PaperAllocationExecutionParams {
  intents: AllocationIntent[];
  db: Database;
  config: AgentConfig;
  connection: Connection;
  buildExecutionPlanFn: (
    opportunity: AllocationIntent['opportunity'],
    positionId: string,
    connection: Connection,
    config: AgentConfig,
    db: Database,
  ) => Promise<ExecutionPlan>;
  signalTypes: string[];
  reasoning: string;
  marketRegime: MarketRegime | null;
  solPriceUsd: number | null;
}

export interface PaperAllocationExecutionResult {
  openedPositionIds: string[];
}

export async function executePaperAllocationPlan(
  params: PaperAllocationExecutionParams
): Promise<PaperAllocationExecutionResult> {
  const {
    intents,
    db,
    config,
    connection,
    buildExecutionPlanFn,
    signalTypes,
    reasoning,
    marketRegime,
    solPriceUsd,
  } = params;

  const sm = new PositionStateMachine(db, config);
  const openedPositionIds: string[] = [];

  for (const intent of intents) {
    const validation = await validateNewPosition(
      intent.sizeUsd,
      config,
      db,
      intent.opportunity.protocol,
      intent.opportunity.poolName,
      intent.opportunity.poolId,
      extractBaseMintFromRawData(intent.opportunity.raw_data ?? null),
    );
    if (!validation.success) {
      logger.info({ poolId: intent.opportunity.poolId, error: validation.error }, 'Paper allocation skipped');
      continue;
    }

    const opportunity = await db.insertOpportunity({
      protocol: intent.opportunity.protocol,
      pool_id: intent.opportunity.poolId,
      pool_name: intent.opportunity.poolName,
      apy_defillama: intent.opportunity.apyDefillama,
      apy_protocol: intent.opportunity.apyProtocol,
      apy_used: intent.opportunity.apyUsed,
      data_uncertain: intent.opportunity.dataUncertain ? 1 : 0,
      tvl_usd: intent.opportunity.tvlUsd,
      score: intent.opportunity.score,
      raw_data: intent.opportunity.raw_data ? JSON.stringify(intent.opportunity.raw_data) : null,
    });

    const position = await db.insertPosition({
      opportunity_id: opportunity.id,
      protocol: opportunity.protocol,
      pool_id: opportunity.pool_id,
      pool_name: opportunity.pool_name,
      state: 'PENDING_OPEN',
      book: intent.book,
      base_mint: extractBaseMintFromRawData(intent.opportunity.raw_data ?? null),
      size_usd: intent.sizeUsd,
      entry_apy: opportunity.apy_used,
      entry_price_sol: null,
      opened_at: null,
      closed_at: null,
      close_reason: null,
      notes: `book=${intent.book}`,
    });

    await buildExecutionPlanFn(intent.opportunity, position.id, connection, config, db);

    const txSignature = `PAPER-${position.id.slice(0, 8)}-${Date.now()}`;
    const transition = await sm.transition(position.id, 'ACTIVE', { txSignature });
    if (!transition.success) {
      logger.warn({ positionId: position.id, error: transition.error }, 'Paper allocation transition failed');
      continue;
    }

    const activeCount = await db.countActivePositions();
    await logPositionDecisionEpisode({
      db,
      position,
      action: 'open',
      signalTypes,
      reasoning: `${reasoning} [${intent.book}]`,
      marketRegime,
      solPriceUsd,
      source: 'paper',
      portfolioSizeUsd: config.paperStartingBalanceUsd,
      activePositionCount: activeCount,
    });

    openedPositionIds.push(position.id);
  }

  return { openedPositionIds };
}
