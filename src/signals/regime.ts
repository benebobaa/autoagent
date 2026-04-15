export type MarketRegime =
  | 'BULL_TREND'
  | 'BEAR_TREND'
  | 'HIGH_VOL_RANGE'
  | 'LOW_VOL_RANGE'
  | 'CAPITULATION'
  | 'EUPHORIA';

export interface PricePoint {
  timestamp: string;
  priceUsd: number;
  volume?: number | undefined;
}

export interface RegimeConfig {
  bullThresholdPct: number;
  bearThresholdPct: number;
  highVolAtrRatio: number;
  lowVolAtrRatio: number;
  capitulationDropPct: number;
  euphoriaRisePct: number;
}

export interface RegimeResult {
  regime: MarketRegime;
  confidence: 'low' | 'medium' | 'high';
  priceChangePct: number;
  atrRatio: number;
  volumeTrend: 'increasing' | 'decreasing' | 'stable';
  details: {
    momentumPct: number;
    volatilityRatio: number;
  };
}

export interface ScoringWeights {
  apyWeight: number;
  liquidityWeight: number;
  trustWeight: number;
  riskPenaltyWeight: number;
}

export type StrategyBias = 'AGGRESSIVE' | 'DEFENSIVE' | 'BALANCED' | 'SAFE';

export const DEFAULT_REGIME_CONFIG: RegimeConfig = {
  bullThresholdPct: 15,
  bearThresholdPct: -15,
  highVolAtrRatio: 0.03,
  lowVolAtrRatio: 0.015,
  capitulationDropPct: 25,
  euphoriaRisePct: 40,
};

export function detectRegime(
  priceHistory: PricePoint[],
  config: RegimeConfig
): RegimeResult {
  if (priceHistory.length < 2) {
    return {
      regime: 'LOW_VOL_RANGE',
      confidence: 'low',
      priceChangePct: 0,
      atrRatio: 0,
      volumeTrend: 'stable',
      details: { momentumPct: 0, volatilityRatio: 1 },
    };
  }

  const sorted = [...priceHistory].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const firstPrice = sorted[0]!.priceUsd;
  const lastPrice = sorted[sorted.length - 1]!.priceUsd;
  const priceChangePct = ((lastPrice - firstPrice) / firstPrice) * 100;

  const atr = computeAtr(sorted);
  const atrRatio = atr / lastPrice;

  const volumeTrend = computeVolumeTrend(sorted);

  if (priceChangePct >= config.euphoriaRisePct) {
    return {
      regime: 'EUPHORIA',
      confidence: 'high',
      priceChangePct,
      atrRatio,
      volumeTrend,
      details: { momentumPct: priceChangePct, volatilityRatio: atrRatio / config.highVolAtrRatio },
    };
  }

  if (priceChangePct <= -(config.capitulationDropPct)) {
    return {
      regime: 'CAPITULATION',
      confidence: 'high',
      priceChangePct,
      atrRatio,
      volumeTrend,
      details: { momentumPct: priceChangePct, volatilityRatio: atrRatio / config.highVolAtrRatio },
    };
  }

  if (priceChangePct >= config.bullThresholdPct) {
    const conf = atrRatio >= config.highVolAtrRatio ? 'medium' : 'high';
    return {
      regime: 'BULL_TREND',
      confidence: conf,
      priceChangePct,
      atrRatio,
      volumeTrend,
      details: { momentumPct: priceChangePct, volatilityRatio: atrRatio / config.lowVolAtrRatio },
    };
  }

  if (priceChangePct <= config.bearThresholdPct) {
    const conf = atrRatio >= config.highVolAtrRatio ? 'medium' : 'high';
    return {
      regime: 'BEAR_TREND',
      confidence: conf,
      priceChangePct,
      atrRatio,
      volumeTrend,
      details: { momentumPct: priceChangePct, volatilityRatio: atrRatio / config.lowVolAtrRatio },
    };
  }

  if (atrRatio >= config.highVolAtrRatio) {
    return {
      regime: 'HIGH_VOL_RANGE',
      confidence: 'medium',
      priceChangePct,
      atrRatio,
      volumeTrend,
      details: { momentumPct: priceChangePct, volatilityRatio: atrRatio / config.lowVolAtrRatio },
    };
  }

  return {
    regime: 'LOW_VOL_RANGE',
    confidence: 'high',
    priceChangePct,
    atrRatio,
    volumeTrend,
    details: { momentumPct: priceChangePct, volatilityRatio: atrRatio / config.highVolAtrRatio },
  };
}

function computeAtr(points: PricePoint[]): number {
  if (points.length < 2) return 0;

  let trueRanges: number[] = [];

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const curr = points[i]!;

    const high = Math.max(prev.priceUsd, curr.priceUsd);
    const low = Math.min(prev.priceUsd, curr.priceUsd);
    const close = curr.priceUsd;

    const tr = Math.max(
      high - low,
      Math.abs(high - prev.priceUsd),
      Math.abs(low - prev.priceUsd)
    );
    trueRanges.push(tr);
  }

  return trueRanges.reduce((sum, tr) => sum + tr, 0) / trueRanges.length;
}

function computeVolumeTrend(
  points: PricePoint[]
): 'increasing' | 'decreasing' | 'stable' {
  const volumes = points
    .filter((p) => p.volume !== undefined)
    .map((p) => p.volume as number);

  if (volumes.length < 4) return 'stable';

  const halfLen = Math.floor(volumes.length / 2);
  const firstHalf = volumes.slice(0, halfLen);
  const secondHalf = volumes.slice(halfLen);

  const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

  const ratio = secondAvg / firstAvg;

  if (ratio > 1.2) return 'increasing';
  if (ratio < 0.8) return 'decreasing';
  return 'stable';
}

export const REGIME_WEIGHTS: Record<MarketRegime, ScoringWeights> = {
  LOW_VOL_RANGE: { apyWeight: 0.45, liquidityWeight: 0.25, trustWeight: 0.15, riskPenaltyWeight: 0.15 },
  BULL_TREND: { apyWeight: 0.35, liquidityWeight: 0.30, trustWeight: 0.20, riskPenaltyWeight: 0.15 },
  BEAR_TREND: { apyWeight: 0.20, liquidityWeight: 0.35, trustWeight: 0.30, riskPenaltyWeight: 0.15 },
  HIGH_VOL_RANGE: { apyWeight: 0.30, liquidityWeight: 0.30, trustWeight: 0.20, riskPenaltyWeight: 0.20 },
  CAPITULATION: { apyWeight: 0.10, liquidityWeight: 0.40, trustWeight: 0.35, riskPenaltyWeight: 0.15 },
  EUPHORIA: { apyWeight: 0.25, liquidityWeight: 0.30, trustWeight: 0.25, riskPenaltyWeight: 0.20 },
};

export const REGIME_STRATEGY_BIAS: Record<MarketRegime, StrategyBias> = {
  LOW_VOL_RANGE: 'BALANCED',
  BULL_TREND: 'AGGRESSIVE',
  BEAR_TREND: 'DEFENSIVE',
  HIGH_VOL_RANGE: 'DEFENSIVE',
  CAPITULATION: 'SAFE',
  EUPHORIA: 'AGGRESSIVE',
};

export function getRegimeWeights(regime: MarketRegime): ScoringWeights {
  return REGIME_WEIGHTS[regime];
}

export function getRegimeStrategyBias(regime: MarketRegime): StrategyBias {
  return REGIME_STRATEGY_BIAS[regime];
}
