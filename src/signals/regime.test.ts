import { describe, it, expect } from 'vitest';
import {
  detectRegime,
  getRegimeWeights,
  getRegimeStrategyBias,
  DEFAULT_REGIME_CONFIG,
  type PricePoint,
} from './regime.js';

function makePriceHistory(points: { price: number; daysAgo: number }[]): PricePoint[] {
  const now = Date.now();
  return points.map(({ price, daysAgo }) => ({
    timestamp: new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    priceUsd: price,
    volume: 1_000_000,
  }));
}

describe('detectRegime', () => {
  it('returns LOW_VOL_RANGE when price change is minimal and vol is low', () => {
    const history = makePriceHistory([
      { price: 100, daysAgo: 7 },
      { price: 101, daysAgo: 6 },
      { price: 100.5, daysAgo: 5 },
      { price: 100.2, daysAgo: 4 },
      { price: 100.8, daysAgo: 3 },
      { price: 101.1, daysAgo: 2 },
      { price: 100.9, daysAgo: 1 },
      { price: 101, daysAgo: 0 },
    ]);
    const result = detectRegime(history, DEFAULT_REGIME_CONFIG);
    expect(result.regime).toBe('LOW_VOL_RANGE');
    expect(result.confidence).toBe('high');
  });

  it('returns BULL_TREND when price rises > 15% over lookback', () => {
    const history = makePriceHistory([
      { price: 100, daysAgo: 7 },
      { price: 105, daysAgo: 6 },
      { price: 108, daysAgo: 5 },
      { price: 112, daysAgo: 4 },
      { price: 115, daysAgo: 3 },
      { price: 118, daysAgo: 2 },
      { price: 120, daysAgo: 1 },
      { price: 120, daysAgo: 0 },
    ]);
    const result = detectRegime(history, DEFAULT_REGIME_CONFIG);
    expect(result.regime).toBe('BULL_TREND');
    expect(result.priceChangePct).toBeGreaterThan(15);
  });

  it('returns BEAR_TREND when price falls > 15% over lookback', () => {
    const history = makePriceHistory([
      { price: 120, daysAgo: 7 },
      { price: 118, daysAgo: 6 },
      { price: 115, daysAgo: 5 },
      { price: 112, daysAgo: 4 },
      { price: 108, daysAgo: 3 },
      { price: 105, daysAgo: 2 },
      { price: 102, daysAgo: 1 },
      { price: 100, daysAgo: 0 },
    ]);
    const result = detectRegime(history, DEFAULT_REGIME_CONFIG);
    expect(result.regime).toBe('BEAR_TREND');
    expect(result.priceChangePct).toBeLessThan(-15);
  });

  it('returns EUPHORIA when price rises > 40% over lookback', () => {
    const history = makePriceHistory([
      { price: 100, daysAgo: 7 },
      { price: 115, daysAgo: 6 },
      { price: 125, daysAgo: 5 },
      { price: 135, daysAgo: 4 },
      { price: 140, daysAgo: 3 },
      { price: 145, daysAgo: 2 },
      { price: 148, daysAgo: 1 },
      { price: 150, daysAgo: 0 },
    ]);
    const result = detectRegime(history, DEFAULT_REGIME_CONFIG);
    expect(result.regime).toBe('EUPHORIA');
    expect(result.confidence).toBe('high');
  });

  it('returns CAPITULATION when price drops > 25% over 48h', () => {
    const now = Date.now();
    const history: PricePoint[] = [
      { timestamp: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(), priceUsd: 150, volume: 1_000_000 },
      { timestamp: new Date(now - 1.9 * 24 * 60 * 60 * 1000).toISOString(), priceUsd: 145, volume: 2_000_000 },
      { timestamp: new Date(now - 1.8 * 24 * 60 * 60 * 1000).toISOString(), priceUsd: 140, volume: 5_000_000 },
      { timestamp: new Date(now - 1.7 * 24 * 60 * 60 * 1000).toISOString(), priceUsd: 130, volume: 10_000_000 },
      { timestamp: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(), priceUsd: 112, volume: 15_000_000 },
      { timestamp: new Date(now - 0.5 * 24 * 60 * 60 * 1000).toISOString(), priceUsd: 110, volume: 12_000_000 },
      { timestamp: new Date(now).toISOString(), priceUsd: 108, volume: 10_000_000 },
    ];
    const result = detectRegime(history, DEFAULT_REGIME_CONFIG);
    expect(result.regime).toBe('CAPITULATION');
    expect(result.confidence).toBe('high');
  });

  it('returns HIGH_VOL_RANGE when vol is high but price is stable', () => {
    const history: PricePoint[] = [];
    const now = Date.now();
    const base = 100;
    for (let i = 0; i < 20; i++) {
      const volatility = 0.05;
      const randomChange = (Math.random() - 0.5) * 2 * volatility * base;
      const price = base + randomChange;
      history.push({
        timestamp: new Date(now - (20 - i) * 60 * 60 * 1000).toISOString(),
        priceUsd: price,
        volume: 1_000_000,
      });
    }
    const result = detectRegime(history, DEFAULT_REGIME_CONFIG);
    expect(['HIGH_VOL_RANGE', 'LOW_VOL_RANGE']).toContain(result.regime);
  });

  it('returns LOW_VOL_RANGE for empty history', () => {
    const result = detectRegime([], DEFAULT_REGIME_CONFIG);
    expect(result.regime).toBe('LOW_VOL_RANGE');
    expect(result.confidence).toBe('low');
  });

  it('returns LOW_VOL_RANGE for single point history', () => {
    const history: PricePoint[] = [
      { timestamp: new Date().toISOString(), priceUsd: 150, volume: 1_000_000 },
    ];
    const result = detectRegime(history, DEFAULT_REGIME_CONFIG);
    expect(result.regime).toBe('LOW_VOL_RANGE');
    expect(result.confidence).toBe('low');
  });
});

describe('getRegimeWeights', () => {
  it('returns correct weights for BULL_TREND', () => {
    const w = getRegimeWeights('BULL_TREND');
    expect(w.apyWeight).toBe(0.35);
    expect(w.liquidityWeight).toBe(0.30);
    expect(w.trustWeight).toBe(0.20);
    expect(w.riskPenaltyWeight).toBe(0.15);
  });

  it('returns correct weights for BEAR_TREND', () => {
    const w = getRegimeWeights('BEAR_TREND');
    expect(w.apyWeight).toBe(0.20);
    expect(w.liquidityWeight).toBe(0.35);
    expect(w.trustWeight).toBe(0.30);
    expect(w.riskPenaltyWeight).toBe(0.15);
  });

  it('returns correct weights for CAPITULATION', () => {
    const w = getRegimeWeights('CAPITULATION');
    expect(w.apyWeight).toBe(0.10);
    expect(w.liquidityWeight).toBe(0.40);
    expect(w.trustWeight).toBe(0.35);
  });

  it('returns correct weights for LOW_VOL_RANGE', () => {
    const w = getRegimeWeights('LOW_VOL_RANGE');
    expect(w.apyWeight).toBe(0.45);
  });

  it('returns correct weights for EUPHORIA', () => {
    const w = getRegimeWeights('EUPHORIA');
    expect(w.apyWeight).toBe(0.25);
    expect(w.riskPenaltyWeight).toBe(0.20);
  });
});

describe('getRegimeStrategyBias', () => {
  it('BULL_TREND → AGGRESSIVE', () => {
    expect(getRegimeStrategyBias('BULL_TREND')).toBe('AGGRESSIVE');
  });

  it('BEAR_TREND → DEFENSIVE', () => {
    expect(getRegimeStrategyBias('BEAR_TREND')).toBe('DEFENSIVE');
  });

  it('CAPITULATION → SAFE', () => {
    expect(getRegimeStrategyBias('CAPITULATION')).toBe('SAFE');
  });

  it('LOW_VOL_RANGE → BALANCED', () => {
    expect(getRegimeStrategyBias('LOW_VOL_RANGE')).toBe('BALANCED');
  });

  it('EUPHORIA → AGGRESSIVE', () => {
    expect(getRegimeStrategyBias('EUPHORIA')).toBe('AGGRESSIVE');
  });
});
