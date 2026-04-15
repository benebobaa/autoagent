export interface MeteoraILResult {
  divergenceIlPct: number;      // standard IL formula, clamped to bin boundaries
  outOfRangeLossPct: number;    // fees missed during out-of-range periods
  totalEffectiveIlPct: number;  // combined IL + opportunity cost
  inRange: boolean;
  feeOffsetPct: number;         // estimated fees earned as IL offset
  netPnlPct: number;            // fee_offset - total_effective_il
}

/**
 * Calculates the Impermanent Loss and Opportunity Cost for a Meteora DLMM position.
 * 
 * Note: A true DLMM IL calculation integrates across all discrete bins.
 * This is a continuous approximation adequate for risk signaling and advisory.
 */
export function calculateMeteoraIL(params: {
  entryPrice: number;
  currentPrice: number;
  lowerBinPrice: number;
  upperBinPrice: number;
  feeApr24h: number;
  timeInRangePct: number; // 0.0 to 1.0
  daysHeld: number;
}): MeteoraILResult {
  const {
    entryPrice,
    currentPrice,
    lowerBinPrice,
    upperBinPrice,
    feeApr24h,
    timeInRangePct,
    daysHeld,
  } = params;

  // 1. Calculate Divergence IL
  // Standard AMM IL formula: 2*sqrt(p) / (1 + p) - 1  (where p is price ratio)
  // For DLMM, price divergence stops accumulating once out of bounds since the position 
  // converts entirely to one asset. We clamp the price to the range bounds.
  let activePrice = currentPrice;
  const inRange = currentPrice >= lowerBinPrice && currentPrice <= upperBinPrice;

  if (currentPrice < lowerBinPrice) activePrice = lowerBinPrice;
  if (currentPrice > upperBinPrice) activePrice = upperBinPrice;

  const r = activePrice / entryPrice;
  const divergenceIlPct = (2 * Math.sqrt(r) / (1 + r)) - 1; // typically negative
  
  // Convert to positive magnitude for risk metrics (e.g. 0.05 = 5% IL)
  const absDivergenceIlPct = Math.abs(divergenceIlPct);

  // 2. Calculate Out of Range Loss (Opportunity Cost)
  // Fees we would have earned if we stayed in range instead of being pushed out
  const outOfRangeTime = Math.max(0, 1.0 - timeInRangePct);
  const outOfRangeLossPct = outOfRangeTime * feeApr24h * (daysHeld / 365);

  // 3. Total Effective IL
  const totalEffectiveIlPct = absDivergenceIlPct + outOfRangeLossPct;

  // 4. Estimated Fee Offset
  // Fees actually earned while in range
  const feeOffsetPct = timeInRangePct * feeApr24h * (daysHeld / 365);

  // 5. Net PnL Pct (excluding underlying asset appreciation)
  const netPnlPct = feeOffsetPct - totalEffectiveIlPct;

  return {
    divergenceIlPct: absDivergenceIlPct,
    outOfRangeLossPct,
    totalEffectiveIlPct,
    inRange,
    feeOffsetPct,
    netPnlPct,
  };
}
