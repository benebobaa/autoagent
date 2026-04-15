import type { DecisionAction } from './decision-types.js';
import type { MarketRegime } from '../signals/regime.js';
import type { Database, DecisionEpisodeRow, Position } from '../positions/db.js';

type PositionDecisionAction = Extract<DecisionAction, 'open' | 'close' | 'rebalance'>;

interface LogPositionDecisionEpisodeParams {
  db: Database;
  position: Pick<Position, 'id' | 'protocol' | 'pool_id' | 'pool_name' | 'size_usd' | 'book'>;
  action: PositionDecisionAction;
  signalTypes: string[];
  reasoning: string;
  marketRegime: MarketRegime | null;
  solPriceUsd: number | null;
  source: DecisionEpisodeRow['source'];
  portfolioSizeUsd?: number;
  activePositionCount?: number;
  decisionAt?: string;
}

export function getDecisionSource(paperTrading: boolean): DecisionEpisodeRow['source'] {
  return paperTrading ? 'paper' : 'live';
}

export async function logPositionDecisionEpisode({
  db,
  position,
  action,
  signalTypes,
  reasoning,
  marketRegime,
  solPriceUsd,
  source,
  portfolioSizeUsd,
  activePositionCount,
  decisionAt,
}: LogPositionDecisionEpisodeParams): Promise<DecisionEpisodeRow> {
  const activePositions = await db.getPositionsByState('ACTIVE');

  return db.insertDecisionEpisode({
    decision_at: decisionAt ?? new Date().toISOString(),
    action,
    book: position.book,
    signal_types: signalTypes.length > 0 ? signalTypes.join(',') : 'MANUAL',
    market_regime: marketRegime,
    sol_price_usd: solPriceUsd,
    portfolio_size_usd:
      portfolioSizeUsd ?? activePositions.reduce((sum, activePosition) => sum + activePosition.size_usd, 0),
    active_position_count: activePositionCount ?? activePositions.length,
    target_pool_id: position.pool_id,
    target_protocol: position.protocol,
    target_pool_name: position.pool_name,
    position_size_usd: position.size_usd,
    position_id: position.id,
    reasoning,
    source,
    outcome_resolved_at: null,
    outcome_net_pnl_usd: null,
    outcome_realized_apy_pct: null,
    outcome_days_held: null,
    outcome_exit_reason: null,
    outcome_exit_regime: null,
    outcome_exit_sol_price: null,
    grade: null,
    lesson_learned: null,
  });
}
