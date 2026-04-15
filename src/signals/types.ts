import { z } from 'zod';

// ---------------------------------------------------------------------------
// Signal priority & types
// ---------------------------------------------------------------------------

export const SignalPrioritySchema = z.enum(['CRITICAL', 'HIGH', 'LOW']);
export type SignalPriority = z.infer<typeof SignalPrioritySchema>;

export const SignalTypeSchema = z.enum([
  // CRITICAL
  'IL_BREACH',          // Impermanent loss exceeds tolerance on an open LP position
  'PORTFOLIO_DRAWDOWN', // Portfolio MtM drops > circuit_breaker_drawdown_pct
  'TVL_COLLAPSE',       // Pool TVL drops > 30% between snapshots (rug signal)
  // HIGH
  'APY_DRIFT',          // Active position APY drops > 25% from entry
  'BETTER_POOL',        // A same-token pool has APY > current + 2pp
  'LIQUIDITY_CRUNCH',   // Pool TVL drops > 40% (exit risk, but not collapse)
  'REGIME_SHIFT',       // SOL price moves > 8% between snapshots
  // LOW
  'NEW_HIGH_YIELD_POOL',// Untracked pool exceeds APY/score thresholds
  'POSITION_AGING',     // Position held longer than configured hold_days
  // Meteora DLMM CRITICAL
  'METEORA_OUT_OF_RANGE',      // Active bin outside position bin range for 4 polls
  // Meteora DLMM HIGH
  'METEORA_BIN_LIQUIDITY_THIN',// Active bin liquidity < 20% pool TVL
  'METEORA_FEE_APR_COLLAPSE',  // Fee APR drop > 60% vs rolling avg
  'METEORA_HIGH_VOLUME_SPIKE', // Volume spikes 3x while APR remains high
  // Meteora DLMM LOW
  'METEORA_BIN_STEP_MISMATCH', // Bin step inappropriate for asset class
  // DLMM Hard-Close Signals (from position monitor)
  'DLMM_STOP_LOSS',     // CRITICAL: position PnL <= stop_loss_pct
  'DLMM_TAKE_PROFIT',   // HIGH: position PnL >= take_profit_pct
  'DLMM_TRAILING_TP',   // HIGH: position retraced from trailing PnL peak
  'DLMM_OOR_CLOSE',     // HIGH: position OOR >= out_of_range_wait_minutes OR pumped past range
  'DLMM_FEE_CLAIM_READY', // LOW: unclaimed fees >= min_claim_amount_usd
  'DLMM_FEE_YIELD_LOW', // HIGH: fee_per_tvl_24h < min_fee_per_tvl_24h AND age >= 60 min
  // Tiered active DLMM + portfolio allocation
  'VOLUME_SPIKE',
  'MEME_POOL_DISCOVERED',
  'POSITION_AUTO_EXIT',
  'PORTFOLIO_REBALANCE',
  'CIRCUIT_BREAKER_TRIGGERED',
  'TIER_OPPORTUNITY',
  // System
  'HEARTBEAT',          // Daily 00:00 full portfolio review trigger
]);
export type SignalType = z.infer<typeof SignalTypeSchema>;

// ---------------------------------------------------------------------------
// Signal payloads (typed per signal type)
// ---------------------------------------------------------------------------

export const ILBreachPayloadSchema = z.object({
  positionId: z.string(),
  poolId: z.string(),
  protocol: z.string(),
  ilPct: z.number(),
  maxTolerancePct: z.number(),
});

export const PortfolioDrawdownPayloadSchema = z.object({
  drawdownPct: z.number(),
  portfolioValueUsd: z.number(),
  peakValueUsd: z.number(),
});

export const TvlCollapsePayloadSchema = z.object({
  poolId: z.string(),
  protocol: z.string(),
  previousTvlUsd: z.number(),
  currentTvlUsd: z.number(),
  dropPct: z.number(),
});

export const ApyDriftPayloadSchema = z.object({
  positionId: z.string(),
  poolId: z.string(),
  protocol: z.string(),
  entryApy: z.number(),
  currentApy: z.number(),
  driftPct: z.number(),
});

export const BetterPoolPayloadSchema = z.object({
  currentPositionId: z.string(),
  currentPoolId: z.string(),
  currentApy: z.number(),
  betterPoolId: z.string(),
  betterProtocol: z.string(),
  betterApy: z.number(),
  deltaPp: z.number(),
});

export const LiquidityCrunchPayloadSchema = z.object({
  poolId: z.string(),
  protocol: z.string(),
  previousTvlUsd: z.number(),
  currentTvlUsd: z.number(),
  dropPct: z.number(),
});

export const RegimeShiftPayloadSchema = z.object({
  previousSolPrice: z.number(),
  currentSolPrice: z.number(),
  changePct: z.number(),
  direction: z.enum(['up', 'down']),
});

export const NewHighYieldPoolPayloadSchema = z.object({
  poolId: z.string(),
  protocol: z.string(),
  poolName: z.string(),
  apy: z.number(),
  tvlUsd: z.number(),
  score: z.number(),
});

export const PositionAgingPayloadSchema = z.object({
  positionId: z.string(),
  poolId: z.string(),
  protocol: z.string(),
  daysHeld: z.number(),
  thresholdDays: z.number(),
});

export const HeartbeatPayloadSchema = z.object({
  date: z.string(),
});

// -- Meteora --

export const MeteoraOutOfRangePayloadSchema = z.object({
  positionId: z.string(),
  poolId: z.string(),
  activeBinId: z.number(),
  lowerBinId: z.number(),
  upperBinId: z.number(),
  consecutivePolls: z.number(),
});

export const MeteoraBinLiquidityThinPayloadSchema = z.object({
  poolId: z.string(),
  activeBinLiquidityUsd: z.number(),
  tvlUsd: z.number(),
  liquidityPct: z.number(),
});

export const MeteoraFeeAprCollapsePayloadSchema = z.object({
  poolId: z.string(),
  currentApr: z.number(),
  averageApr: z.number(),
  dropPct: z.number(),
});

export const MeteoraHighVolumeSpikePayloadSchema = z.object({
  poolId: z.string(),
  currentVolume: z.number(),
  previousVolume: z.number(),
  spikeMultiplier: z.number(),
  currentApr: z.number(),
});

export const MeteoraBinStepMismatchPayloadSchema = z.object({
  poolId: z.string(),
  poolName: z.string(),
  binStep: z.number(),
  assessment: z.string(),
});

// -- DLMM Hard-Close Payloads --

export const DlmmStopLossPayloadSchema = z.object({
  positionId: z.string(),
  poolAddress: z.string(),
  positionPubkey: z.string(),
  pnlPct: z.number(),
  stopLossPct: z.number(),
  currentValueUsd: z.number(),
});

export const DlmmTakeProfitPayloadSchema = z.object({
  positionId: z.string(),
  poolAddress: z.string(),
  positionPubkey: z.string(),
  pnlPct: z.number(),
  takeProfitPct: z.number(),
  currentValueUsd: z.number(),
  unclaimedFeesUsd: z.number(),
});

export const DlmmTrailingTakeProfitPayloadSchema = z.object({
  positionId: z.string(),
  poolAddress: z.string(),
  positionPubkey: z.string(),
  currentPnlPct: z.number(),
  peakPnlPct: z.number(),
  drawdownPct: z.number(),
  armProfitPct: z.number(),
  currentValueUsd: z.number(),
});

export const DlmmOorClosePayloadSchema = z.object({
  positionId: z.string(),
  poolAddress: z.string(),
  positionPubkey: z.string(),
  activeBinId: z.number(),
  lowerBinId: z.number(),
  upperBinId: z.number(),
  minutesOor: z.number(),
  /** 'timeout' = OOR >= wait threshold; 'pumped' = active_bin > upper + outOfRangeBinsToClose */
  reason: z.enum(['timeout', 'pumped']),
});

export const DlmmFeeClaimReadyPayloadSchema = z.object({
  positionId: z.string(),
  poolAddress: z.string(),
  positionPubkey: z.string(),
  unclaimedFeesUsd: z.number(),
  minClaimAmountUsd: z.number(),
});

export const DlmmFeeYieldLowPayloadSchema = z.object({
  positionId: z.string(),
  poolAddress: z.string(),
  positionPubkey: z.string(),
  feePerTvl24h: z.number(),
  minFeePerTvl24h: z.number(),
  ageMinutes: z.number(),
});

export const VolumeSpikePayloadSchema = z.object({
  poolAddress: z.string(),
  tokenSymbol: z.string(),
  dexUrl: z.string().optional(),
  volume1hUsd: z.number(),
  volumeBaselineUsd: z.number(),
  spikeRatio: z.number(),
  priceChange30mPct: z.number(),
  priceChange1hPct: z.number(),
  liquidityUsd: z.number(),
  poolAgeHours: z.number(),
  isNewPool: z.boolean(),
  recommendedTier: z.number().int(),
  confidenceScore: z.number(),
  source: z.string(),
});

export const MemePoolDiscoveredPayloadSchema = z.object({
  poolAddress: z.string(),
  tokenSymbol: z.string(),
  tokenMint: z.string(),
  dexUrl: z.string(),
  volume5mUsd: z.number(),
  volume1hUsd: z.number(),
  volume24hUsd: z.number(),
  liquidityUsd: z.number(),
  priceChange5mPct: z.number(),
  priceChange1hPct: z.number(),
  poolAgeHours: z.number(),
  fdvUsd: z.number(),
  recommendedTier: z.number().int(),
  confidenceScore: z.number(),
  source: z.string(),
});

export const PositionAutoExitPayloadSchema = z.object({
  positionId: z.string(),
  poolAddress: z.string(),
  tokenSymbol: z.string(),
  tier: z.number().int(),
  exitReason: z.string(),
  currentPnlPct: z.number(),
  holdHours: z.number(),
  entryPrice: z.number(),
  currentPrice: z.number(),
  positionValueUsd: z.number(),
  unclaimedFeesUsd: z.number(),
});

export const PortfolioRebalancePayloadSchema = z.object({
  rebalanceReason: z.string(),
  currentAllocations: z.record(z.number()),
  targetAllocations: z.record(z.number()),
  capitalToMoveUsd: z.number().default(0),
  solPriceChangePct: z.number(),
  portfolioDrawdownPct: z.number(),
});

export const CircuitBreakerTriggeredPayloadSchema = z.object({
  triggerType: z.string(),
  triggerValue: z.number(),
  triggerThreshold: z.number(),
  positionsAffected: z.array(z.string()).default([]),
  recommendedAction: z.string(),
});

export const TierOpportunityPayloadSchema = z.object({
  tier: z.number().int(),
  protocol: z.string(),
  poolAddress: z.string(),
  tokenSymbol: z.string(),
  estimatedApyPct: z.number(),
  tvlUsd: z.number(),
  volume24hUsd: z.number(),
  feeRatePct: z.number(),
  opportunityScore: z.number(),
  source: z.string(),
});

// Union payload schema
export const SignalPayloadSchema = z.union([
  ILBreachPayloadSchema,
  PortfolioDrawdownPayloadSchema,
  TvlCollapsePayloadSchema,
  ApyDriftPayloadSchema,
  BetterPoolPayloadSchema,
  LiquidityCrunchPayloadSchema,
  RegimeShiftPayloadSchema,
  NewHighYieldPoolPayloadSchema,
  PositionAgingPayloadSchema,
  HeartbeatPayloadSchema,
  MeteoraOutOfRangePayloadSchema,
  MeteoraBinLiquidityThinPayloadSchema,
  MeteoraFeeAprCollapsePayloadSchema,
  MeteoraHighVolumeSpikePayloadSchema,
  MeteoraBinStepMismatchPayloadSchema,
  DlmmStopLossPayloadSchema,
  DlmmTakeProfitPayloadSchema,
  DlmmTrailingTakeProfitPayloadSchema,
  DlmmOorClosePayloadSchema,
  DlmmFeeClaimReadyPayloadSchema,
  DlmmFeeYieldLowPayloadSchema,
  VolumeSpikePayloadSchema,
  MemePoolDiscoveredPayloadSchema,
  PositionAutoExitPayloadSchema,
  PortfolioRebalancePayloadSchema,
  CircuitBreakerTriggeredPayloadSchema,
  TierOpportunityPayloadSchema,
]);

export type SignalPayload = z.infer<typeof SignalPayloadSchema>;

// ---------------------------------------------------------------------------
// Signal — the core domain object
// ---------------------------------------------------------------------------

export const SignalSchema = z.object({
  id: z.string().uuid(),
  type: SignalTypeSchema,
  priority: SignalPrioritySchema,
  timestamp: z.string().datetime(),
  payload: z.record(z.unknown()), // stored as JSON; typed payloads above for creation
  dedupKey: z.string(),           // prevents same signal from firing twice in one day
  processed: z.boolean().default(false),
  threadId: z.string().nullable().default(null), // LangGraph thread_id after dispatch
});

export type Signal = z.infer<typeof SignalSchema>;

// ---------------------------------------------------------------------------
// Priority metadata
// ---------------------------------------------------------------------------

export const SIGNAL_PRIORITY: Record<SignalType, SignalPriority> = {
  IL_BREACH: 'CRITICAL',
  PORTFOLIO_DRAWDOWN: 'CRITICAL',
  TVL_COLLAPSE: 'CRITICAL',
  APY_DRIFT: 'HIGH',
  BETTER_POOL: 'HIGH',
  LIQUIDITY_CRUNCH: 'HIGH',
  REGIME_SHIFT: 'HIGH',
  NEW_HIGH_YIELD_POOL: 'LOW',
  POSITION_AGING: 'LOW',
  HEARTBEAT: 'LOW',
  METEORA_OUT_OF_RANGE: 'CRITICAL',
  METEORA_BIN_LIQUIDITY_THIN: 'HIGH',
  METEORA_FEE_APR_COLLAPSE: 'HIGH',
  METEORA_HIGH_VOLUME_SPIKE: 'HIGH',
  METEORA_BIN_STEP_MISMATCH: 'LOW',
  DLMM_STOP_LOSS: 'CRITICAL',
  DLMM_TAKE_PROFIT: 'HIGH',
  DLMM_TRAILING_TP: 'HIGH',
  DLMM_OOR_CLOSE: 'HIGH',
  DLMM_FEE_CLAIM_READY: 'LOW',
  DLMM_FEE_YIELD_LOW: 'HIGH',
  VOLUME_SPIKE: 'HIGH',
  MEME_POOL_DISCOVERED: 'HIGH',
  POSITION_AUTO_EXIT: 'CRITICAL',
  PORTFOLIO_REBALANCE: 'HIGH',
  CIRCUIT_BREAKER_TRIGGERED: 'CRITICAL',
  TIER_OPPORTUNITY: 'LOW',
};
