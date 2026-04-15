import type { MarketRegime } from '../signals/regime.js';

// ---------------------------------------------------------------------------
// Decision Episode — the full lifecycle of one investment decision
// ---------------------------------------------------------------------------
// Captures context → reasoning → action → outcome in a single record.
// Stored in PostgreSQL for structured analytics AND mirrored to vector memory
// as narrative text for semantic retrieval.
// ---------------------------------------------------------------------------

export interface DecisionEpisode {
  // Identity
  episodeId: string;
  decisionAt: string; // ISO 8601

  // Context at decision time
  signalTypes: string[];
  marketRegime: MarketRegime | null;
  solPriceUsd: number | null;
  portfolioSizeUsd: number;
  activePositionCount: number;

  // The decision itself
  action: DecisionAction;
  book?: 'core' | 'scout' | null;
  reasoning: string;
  targetPoolId: string | null;
  targetProtocol: string | null;
  targetPoolName: string | null;
  positionSizeUsd: number | null;
  positionId: string | null; // If the action created/affected a position

  // Outcome (filled in later when position closes or skip is evaluated)
  outcome: DecisionOutcome | null;
  grade: DecisionGrade | null;
  lessonLearned: string | null;

  // Source tracking
  source: 'live' | 'paper' | 'backtest';
}

export type DecisionAction = 'open' | 'hold' | 'close' | 'skip' | 'rebalance';

export interface DecisionOutcome {
  resolvedAt: string; // ISO 8601
  netPnlUsd: number;
  realizedApyPct: number;
  daysHeld: number;
  exitReason: string;
  exitMarketRegime: MarketRegime | null;
  exitSolPriceUsd: number | null;
}

/**
 * Decision grades — rule-based, deterministic.
 *
 * EXCELLENT: Exceeded expectations (APY held, positive PnL)
 * GOOD:     Met expectations (net positive)
 * NEUTRAL:  Marginal result (break-even after gas)
 * BAD:      Lost money but within acceptable bounds
 * TERRIBLE: Significant loss or missed a critical signal
 */
export type DecisionGrade = 'EXCELLENT' | 'GOOD' | 'NEUTRAL' | 'BAD' | 'TERRIBLE';

// ---------------------------------------------------------------------------
// Skip Episode — tracking opportunities the agent chose NOT to take
// ---------------------------------------------------------------------------

export interface SkipEpisode {
  episodeId: string;
  skippedAt: string;
  poolId: string;
  protocol: string;
  poolName: string;
  apyAtSkip: number;
  scoreAtSkip: number;
  signalTypes: string[];
  marketRegime: MarketRegime | null;
  skipReason: string;

  // Hindsight (filled later)
  hindsightApyAfter48h: number | null;
  hindsightTvlChangeUsd: number | null;
  grade: DecisionGrade | null;
}
