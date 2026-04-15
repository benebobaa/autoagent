import { describe, it, expect } from 'vitest';
import { calculateMeteoraIL } from './meteora-il.js';

describe('calculateMeteoraIL', () => {
  it('calculates near-zero IL for price at entry', () => {
    const result = calculateMeteoraIL({
      entryPrice: 100,
      currentPrice: 100,
      lowerBinPrice: 90,
      upperBinPrice: 110,
      feeApr24h: 0.50,
      timeInRangePct: 1.0,
      daysHeld: 10,
    });

    expect(result.divergenceIlPct).toBe(0);
    expect(result.outOfRangeLossPct).toBe(0);
    expect(result.inRange).toBe(true);
    expect(result.feeOffsetPct).toBeGreaterThan(0);
    expect(result.netPnlPct).toBeGreaterThan(0);
  });

  it('clamps divergence IL when price completely exits range', () => {
    const resultInBounds = calculateMeteoraIL({
      entryPrice: 100,
      currentPrice: 90, // at boundary
      lowerBinPrice: 90,
      upperBinPrice: 110,
      feeApr24h: 0.50,
      timeInRangePct: 1.0,
      daysHeld: 10,
    });

    const resultOutOfBounds = calculateMeteoraIL({
      entryPrice: 100,
      currentPrice: 50, // way out of bounds
      lowerBinPrice: 90,
      upperBinPrice: 110,
      feeApr24h: 0.50,
      timeInRangePct: 0.5,
      daysHeld: 10,
    });

    // Divergence IL should be identical because it's clamped to the boundary (90)
    expect(resultOutOfBounds.divergenceIlPct).toBeCloseTo(resultInBounds.divergenceIlPct);
    
    // But out-of-range loss will be much higher
    expect(resultOutOfBounds.outOfRangeLossPct).toBeGreaterThan(0);
    expect(resultOutOfBounds.inRange).toBe(false);
  });

  it('computes correct opportunity cost', () => {
    const result = calculateMeteoraIL({
      entryPrice: 100,
      currentPrice: 80,
      lowerBinPrice: 90,
      upperBinPrice: 110,
      feeApr24h: 0.73, // 73% APR
      timeInRangePct: 0.0, // 100% out of range
      daysHeld: 36.5, // 1/10th of year
    });

    // Opp cost = 1.0 * 0.73 * 0.1 = 0.073 (7.3%)
    expect(result.outOfRangeLossPct).toBeCloseTo(0.073);
    expect(result.feeOffsetPct).toBe(0);
    expect(result.netPnlPct).toBeLessThan(0);
  });
});
