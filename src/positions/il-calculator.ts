export function computeStandardIL(entryPrice: number, currentPrice: number): number {
  if (entryPrice === 0) return 0;
  return 2 * Math.sqrt(currentPrice / entryPrice) / (1 + currentPrice / entryPrice) - 1;
}

export interface ConcentratedILResult {
  ilPct: number;
  leverageFactor: number;
  isOutOfRange: boolean;
}

export function computeConcentratedIL(params: {
  entryPrice: number;
  currentPrice: number;
  lowerBinPrice: number;
  upperBinPrice: number;
  binStep: number;
}): ConcentratedILResult {
  const { entryPrice, currentPrice, lowerBinPrice, upperBinPrice, binStep } = params;

  const isOutOfRange = currentPrice < lowerBinPrice || currentPrice > upperBinPrice;

  const leverageFactor = 1 / (1 - (lowerBinPrice / upperBinPrice));

  const standardIL = computeStandardIL(entryPrice, currentPrice);
  const ilPct = standardIL * leverageFactor;

  return {
    ilPct,
    leverageFactor,
    isOutOfRange,
  };
}

export function computeFeeEfficiency(params: {
  binStepBps: number;
  volume24hUsd: number;
  expectedIlPct: number;
  timeInRangeRatio: number;
  tvlUsd: number;
}): number {
  const { binStepBps, volume24hUsd, expectedIlPct, timeInRangeRatio, tvlUsd } = params;

  if (tvlUsd === 0 || expectedIlPct === 0) return 0;

  const feeApr = (volume24hUsd * binStepBps * 365) / (tvlUsd * 10_000);

  const annualizedIl = expectedIlPct * timeInRangeRatio;

  const efficiency = feeApr / annualizedIl;

  return efficiency;
}
