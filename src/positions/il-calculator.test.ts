import { describe, it, expect } from 'vitest';
import {
  computeStandardIL,
  computeConcentratedIL,
  computeFeeEfficiency,
} from './il-calculator.js';

describe('computeStandardIL', () => {
  it('returns 0 when entry and current price are equal', () => {
    expect(computeStandardIL(100, 100)).toBe(0);
  });

  it('returns negative IL when price goes up', () => {
    const il = computeStandardIL(100, 110);
    expect(il).toBeLessThan(0);
  });

  it('returns negative IL when price goes down', () => {
    const il = computeStandardIL(100, 90);
    expect(il).toBeLessThan(0);
  });

  it('returns 0 when entryPrice is 0', () => {
    expect(computeStandardIL(0, 100)).toBe(0);
  });

  it('symmetric: 10% up vs 10% down gives approximately same IL magnitude', () => {
    const ilUp = Math.abs(computeStandardIL(100, 110));
    const ilDown = Math.abs(computeStandardIL(100, 90));
    expect(ilUp).toBeCloseTo(ilDown, 2);
  });
});

describe('computeConcentratedIL', () => {
  it('marks position as out of range when current price is below lower bin', () => {
    const result = computeConcentratedIL({
      entryPrice: 100,
      currentPrice: 80,
      lowerBinPrice: 90,
      upperBinPrice: 110,
      binStep: 50,
    });
    expect(result.isOutOfRange).toBe(true);
  });

  it('marks position as out of range when current price is above upper bin', () => {
    const result = computeConcentratedIL({
      entryPrice: 100,
      currentPrice: 120,
      lowerBinPrice: 90,
      upperBinPrice: 110,
      binStep: 50,
    });
    expect(result.isOutOfRange).toBe(true);
  });

  it('marks position as in range when current price is within bin range', () => {
    const result = computeConcentratedIL({
      entryPrice: 100,
      currentPrice: 100,
      lowerBinPrice: 90,
      upperBinPrice: 110,
      binStep: 50,
    });
    expect(result.isOutOfRange).toBe(false);
  });

  it('returns leverage factor > 1 for concentrated positions', () => {
    const result = computeConcentratedIL({
      entryPrice: 100,
      currentPrice: 100,
      lowerBinPrice: 90,
      upperBinPrice: 110,
      binStep: 50,
    });
    expect(result.leverageFactor).toBeGreaterThan(1);
  });

  it('amplified IL vs standard for concentrated position', () => {
    const standard = computeStandardIL(100, 80);
    const concentrated = computeConcentratedIL({
      entryPrice: 100,
      currentPrice: 80,
      lowerBinPrice: 90,
      upperBinPrice: 110,
      binStep: 50,
    });
    expect(Math.abs(concentrated.ilPct)).toBeGreaterThan(Math.abs(standard));
  });
});

describe('computeFeeEfficiency', () => {
  it('returns 0 when tvlUsd is 0', () => {
    const result = computeFeeEfficiency({
      binStepBps: 10,
      volume24hUsd: 1_000_000,
      expectedIlPct: 0.05,
      timeInRangeRatio: 0.8,
      tvlUsd: 0,
    });
    expect(result).toBe(0);
  });

  it('returns 0 when expectedIlPct is 0', () => {
    const result = computeFeeEfficiency({
      binStepBps: 10,
      volume24hUsd: 1_000_000,
      expectedIlPct: 0,
      timeInRangeRatio: 0.8,
      tvlUsd: 10_000_000,
    });
    expect(result).toBe(0);
  });

  it('returns positive efficiency when fees exceed IL', () => {
    const result = computeFeeEfficiency({
      binStepBps: 10,
      volume24hUsd: 5_000_000,
      expectedIlPct: 0.05,
      timeInRangeRatio: 0.8,
      tvlUsd: 10_000_000,
    });
    expect(result).toBeGreaterThan(0);
  });

  it('higher volume improves efficiency', () => {
    const lowVol = computeFeeEfficiency({
      binStepBps: 10,
      volume24hUsd: 1_000_000,
      expectedIlPct: 0.05,
      timeInRangeRatio: 0.8,
      tvlUsd: 10_000_000,
    });
    const highVol = computeFeeEfficiency({
      binStepBps: 10,
      volume24hUsd: 5_000_000,
      expectedIlPct: 0.05,
      timeInRangeRatio: 0.8,
      tvlUsd: 10_000_000,
    });
    expect(highVol).toBeGreaterThan(lowVol);
  });
});
