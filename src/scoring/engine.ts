import type { AgentConfig } from '../config/loader.js';
import type { MarketRegime } from '../signals/regime.js';
import { getRegimeWeights } from '../signals/regime.js';
import { classifyPool } from './correlation.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RawOpportunity {
  poolId: string;
  protocol: 'kamino_lending' | 'kamino_vaults' | 'marginfi' | 'jito' | 'meteora_dlmm';
  poolName: string;
  apyDefillama: number | null;
  apyProtocol: number | null;
  apyUsed: number;
  tvlUsd: number;
  dataUncertain: boolean;
  /**
   * Extended metadata (protocol-specific). For Meteora DLMM discovery pools this
   * contains: feeTvlRatio, organicScore, binStep, volatility, holderCount, etc.
   * Stored as JSON in the opportunities table.
   */
  raw_data?: Record<string, unknown>;
}

export type Recommendation = 'SUGGEST' | 'WATCH' | 'SKIP';

// ---------------------------------------------------------------------------
// Discovery-mode scoring types
// ---------------------------------------------------------------------------

export interface ScoredOpportunityDiscovery {
  feeTvlScore: number;
  organicBonus: number;
  tvlOptimalityScore: number;
}

export interface ScoredOpportunity extends RawOpportunity {
  score: number;
  apyScore: number;
  liquidityScore: number;
  trustScore: number;
  riskPenalty: number;
  regimePenalty: number;
  recommendation: Recommendation;
  /** Present only for discovery-mode DLMM pools */
  discovery?: ScoredOpportunityDiscovery;
}

// ---------------------------------------------------------------------------
// Component score functions (pure, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Linear scale: 5% APY → 20, 25%+ APY → 100
 */
export function computeApyScore(apy: number): number {
  const MIN_APY = 5;
  const MAX_APY = 25;
  const MIN_SCORE = 20;
  const MAX_SCORE = 100;

  if (apy <= MIN_APY) return MIN_SCORE;
  if (apy >= MAX_APY) return MAX_SCORE;
  return MIN_SCORE + ((apy - MIN_APY) / (MAX_APY - MIN_APY)) * (MAX_SCORE - MIN_SCORE);
}

/**
 * Log10 scale: $100k TVL → 20, $50M+ TVL → 100
 */
export function computeLiquidityScore(tvlUsd: number): number {
  const MIN_TVL = 100_000;
  const MAX_TVL = 50_000_000;
  const MIN_SCORE = 20;
  const MAX_SCORE = 100;

  if (tvlUsd <= MIN_TVL) return MIN_SCORE;
  if (tvlUsd >= MAX_TVL) return MAX_SCORE;

  const logMin = Math.log10(MIN_TVL);
  const logMax = Math.log10(MAX_TVL);
  const logTvl = Math.log10(tvlUsd);

  return MIN_SCORE + ((logTvl - logMin) / (logMax - logMin)) * (MAX_SCORE - MIN_SCORE);
}

/**
 * Fee / active TVL ratio score for discovery-mode DLMM pools.
 *
 * The ratio (from the 5m window) is the primary profit signal: how much fee
 * revenue is being earned relative to active liquidity right now.
 *
 * Scale: 0.05 (minimum threshold) → 20 pts, 0.20+ → 100 pts
 */
export function computeFeeTvlScore(feeTvlRatio: number): number {
  const MIN_RATIO = 0.05;
  const MAX_RATIO = 0.20;
  const MIN_SCORE = 20;
  const MAX_SCORE = 100;

  if (feeTvlRatio <= MIN_RATIO) return MIN_SCORE;
  if (feeTvlRatio >= MAX_RATIO) return MAX_SCORE;
  return MIN_SCORE + ((feeTvlRatio - MIN_RATIO) / (MAX_RATIO - MIN_RATIO)) * (MAX_SCORE - MIN_SCORE);
}

/**
 * Organic score bonus for discovery DLMM pools.
 * Scores >= 80 get a boost; < 60 is already filtered by the discovery API.
 * Returns 0-15 additive bonus.
 */
export function computeOrganicBonus(organicScore: number): number {
  if (organicScore >= 90) return 15;
  if (organicScore >= 80) return 10;
  if (organicScore >= 70) return 5;
  return 0;
}

/**
 * TVL optimality score for discovery DLMM pools.
 * Peaks in the $30k-$100k sweet spot (high fee/TVL, enough depth, not overcrowded).
 * Outside $10k-$150k = low score (already filtered upstream, but handles edge cases).
 */
export function computeTvlOptimalityScore(tvlUsd: number): number {
  // Peak range: $30k-$100k → 100 pts
  if (tvlUsd >= 30_000 && tvlUsd <= 100_000) return 100;
  // Ramp up: $10k-$30k
  if (tvlUsd >= 10_000 && tvlUsd < 30_000) {
    return 40 + ((tvlUsd - 10_000) / 20_000) * 60;
  }
  // Ramp down: $100k-$150k
  if (tvlUsd > 100_000 && tvlUsd <= 150_000) {
    return 100 - ((tvlUsd - 100_000) / 50_000) * 60;
  }
  // Outside discovery range
  return 20;
}

function isLpProtocol(protocol: RawOpportunity['protocol']): boolean {
  return protocol === 'meteora_dlmm' || protocol === 'kamino_vaults';
}

function isStablecoinLending(protocol: RawOpportunity['protocol'], poolName: string): boolean {
  const isLending = protocol === 'kamino_lending' || protocol === 'marginfi';
  const isStable = poolName.toLowerCase().includes('usdc') ||
    poolName.toLowerCase().includes('usdt') ||
    poolName.toLowerCase().includes('dust');
  return isLending && isStable;
}

function computeRegimePenalty(
  protocol: RawOpportunity['protocol'],
  regime: MarketRegime,
  poolName = ''
): number {
  const isLp = isLpProtocol(protocol);
  const isStableLending = isStablecoinLending(protocol, poolName);

  if ((regime === 'BEAR_TREND' || regime === 'CAPITULATION') && isLp) {
    return -15;
  }

  if ((regime === 'BEAR_TREND' || regime === 'CAPITULATION') && isStableLending) {
    return 10;
  }

  if (regime === 'EUPHORIA' && isLp) {
    return 5;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Portfolio context for diversification bonus
// ---------------------------------------------------------------------------

export interface PortfolioContext {
  /** USD exposure per correlation group for currently active positions */
  exposureByGroup: Map<string, number>;
  /** Total portfolio capital in USD */
  totalCapitalUsd: number;
}

/**
 * Diversification bonus/penalty based on portfolio concentration.
 * Underrepresented groups (<10% of portfolio) get +8 pts to encourage diversity.
 * Overrepresented groups (>30% of portfolio) get -5 pts to discourage piling on.
 */
function computeDiversificationBonus(
  opp: RawOpportunity,
  ctx: PortfolioContext | undefined
): number {
  if (!ctx || ctx.totalCapitalUsd <= 0) return 0;
  const group = classifyPool(opp.protocol, opp.poolName);
  const groupExposure = ctx.exposureByGroup.get(group) ?? 0;
  const groupPct = (groupExposure / ctx.totalCapitalUsd) * 100;
  if (groupPct < 10) return 8;
  if (groupPct > 30) return -5;
  return 0;
}

// ---------------------------------------------------------------------------
// Main scoring function (pure — no side effects)
// ---------------------------------------------------------------------------

export function scoreOpportunity(
  opp: RawOpportunity,
  config: AgentConfig,
  regime: MarketRegime = 'LOW_VOL_RANGE',
  portfolioCtx?: PortfolioContext
): ScoredOpportunity {
  const protocolConfig = config.protocols[opp.protocol];
  const trustScore = protocolConfig?.trust_score ?? 50;
  const riskPenalty = opp.dataUncertain ? 20 : 0;
  const regimePenalty = computeRegimePenalty(opp.protocol, regime, opp.poolName);

  // ── Discovery-mode scoring for Meteora DLMM ──────────────────────────────
  const isDiscovery = opp.protocol === 'meteora_dlmm' && opp.raw_data?.['isDiscovery'] === true;

  if (isDiscovery) {
    const feeTvlRatio = typeof opp.raw_data?.['feeTvlRatio'] === 'number'
      ? opp.raw_data['feeTvlRatio']
      : 0;
    const organicScore = typeof opp.raw_data?.['organicScore'] === 'number'
      ? opp.raw_data['organicScore']
      : 60;

    const feeTvlScore = computeFeeTvlScore(feeTvlRatio);
    const organicBonus = computeOrganicBonus(organicScore);
    const tvlOptimalityScore = computeTvlOptimalityScore(opp.tvlUsd);

    // Smart wallet boost
    const smartWalletBoost = opp.raw_data?.['hasSmartWallet'] === true ? 8 : 0;

    // For discovery mode, APY is inflated (from 5m window) — use it but don't let it
    // dominate. Cap its weight and rely more on fee/TVL as the real signal.
    const apyScore = computeApyScore(Math.min(opp.apyUsed, 50)); // cap at 50% for weight calc

    // Discovery scoring formula (weights sum to 1.0):
    // fee/TVL: 0.35 (primary signal — how much this pool earns right now)
    // TVL optimality: 0.20 (sweet spot 30k-100k)
    // APY: 0.15 (fee yield relative signal)
    // Trust: 0.15 (protocol trust)
    // Organic: additive bonus (0-15 pts)
    // Smart wallet: additive boost (0-8 pts)
    const weights = getRegimeWeights(regime);
    const baseScore =
      feeTvlScore * 0.35 +
      tvlOptimalityScore * 0.20 +
      apyScore * 0.15 +
      trustScore * weights.trustWeight -
      riskPenalty * weights.riskPenaltyWeight +
      regimePenalty;

    const diversificationBonus = computeDiversificationBonus(opp, portfolioCtx);
    const score = baseScore + organicBonus + smartWalletBoost + diversificationBonus;

    const recommendation: Recommendation =
      score >= config.scoring.min_score_to_suggest
        ? 'SUGGEST'
        : score >= config.scoring.min_score_to_watch
        ? 'WATCH'
        : 'SKIP';

    return {
      ...opp,
      score,
      apyScore,
      liquidityScore: tvlOptimalityScore, // repurposed as TVL optimality for discovery
      trustScore,
      riskPenalty,
      regimePenalty,
      recommendation,
      discovery: { feeTvlScore, organicBonus, tvlOptimalityScore },
    };
  }

  // ── Standard scoring (non-discovery pools) ───────────────────────────────
  const apyScore = computeApyScore(opp.apyUsed);
  const liquidityScore = computeLiquidityScore(opp.tvlUsd);

  const weights = getRegimeWeights(regime);
  const apySustainabilityPenalty =
    opp.apyUsed > 30 && opp.tvlUsd < 1_000_000
      ? Math.min(15, (opp.apyUsed - 30) * 0.3)
      : 0;

  const diversificationBonus = computeDiversificationBonus(opp, portfolioCtx);
  const score =
    apyScore * weights.apyWeight +
    liquidityScore * weights.liquidityWeight +
    trustScore * weights.trustWeight -
    riskPenalty * weights.riskPenaltyWeight +
    regimePenalty -
    apySustainabilityPenalty +
    diversificationBonus;

  const recommendation: Recommendation =
    score >= config.scoring.min_score_to_suggest
      ? 'SUGGEST'
      : score >= config.scoring.min_score_to_watch
      ? 'WATCH'
      : 'SKIP';

  return {
    ...opp,
    score,
    apyScore,
    liquidityScore,
    trustScore,
    riskPenalty,
    regimePenalty,
    recommendation,
  };
}

export function scoreAll(
  opps: RawOpportunity[],
  config: AgentConfig,
  regime: MarketRegime = 'LOW_VOL_RANGE',
  portfolioCtx?: PortfolioContext
): ScoredOpportunity[] {
  return opps
    .filter((o) => {
      if (o.apyUsed < config.scoring.min_apy_pct) return false;
      // Discovery pools have small TVL by design (10k-150k) — skip global TVL filter
      const isDiscovery = o.protocol === 'meteora_dlmm' && o.raw_data?.['isDiscovery'] === true;
      if (isDiscovery) {
        const discMin = config.meteora.discovery.min_tvl;
        return (o.tvlUsd ?? 0) >= discMin;
      }
      return (o.tvlUsd ?? 0) >= config.scoring.min_tvl_usd;
    })
    .map((o) => scoreOpportunity(o, config, regime, portfolioCtx))
    .sort((a, b) => b.score - a.score);
}
