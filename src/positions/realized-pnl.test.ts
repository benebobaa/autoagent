import { describe, it, expect } from 'vitest';
import { computeTimeWeightedApy, computeRealizedPnl, type ApySnapshot } from './realized-pnl.js';
import type { Position } from './db.js';

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'pos-1',
    opportunity_id: 'opp-1',
    protocol: 'jito',
    pool_id: 'pool-1',
    pool_name: 'JitoSOL',
    state: 'ACTIVE',
    book: null,
    base_mint: null,
    size_usd: 100,
    entry_apy: 8.0,
    entry_price_sol: null,
    opened_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    closed_at: null,
    close_reason: null,
    notes: null,
    created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function makeSnapshots(apyValues: number[], daysAgo: number[]): ApySnapshot[] {
  const now = Date.now();
  return apyValues.map((apy, i) => {
    const days = daysAgo[i] ?? 0;
    return {
      positionId: 'pos-1',
      snapshotAt: new Date(now - days * 24 * 60 * 60 * 1000).toISOString(),
      currentApyPct: apy,
      poolTvlUsd: 10_000_000,
    };
  });
}

describe('computeTimeWeightedApy', () => {
  it('returns 0 for empty snapshots', () => {
    expect(computeTimeWeightedApy([])).toBe(0);
  });

  it('returns 0 for single snapshot', () => {
    const snapshots = makeSnapshots([8], [0]);
    expect(computeTimeWeightedApy(snapshots)).toBe(0);
  });

  it('returns the APY when all snapshots have same value', () => {
    const snapshots = makeSnapshots([10, 10, 10], [3, 2, 1]);
    expect(computeTimeWeightedApy(snapshots)).toBe(10);
  });

  it('computes time-weighted average correctly', () => {
    const now = Date.now();
    const snapshots: ApySnapshot[] = [
      { positionId: 'pos-1', snapshotAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(), currentApyPct: 10, poolTvlUsd: 10_000_000 },
      { positionId: 'pos-1', snapshotAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(), currentApyPct: 20, poolTvlUsd: 10_000_000 },
      { positionId: 'pos-1', snapshotAt: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(), currentApyPct: 30, poolTvlUsd: 10_000_000 },
    ];
    expect(computeTimeWeightedApy(snapshots)).toBe(15);
  });

  it('handles irregular intervals', () => {
    const now = Date.now();
    const snapshots: ApySnapshot[] = [
      { positionId: 'pos-1', snapshotAt: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(), currentApyPct: 10, poolTvlUsd: 10_000_000 },
      { positionId: 'pos-1', snapshotAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(), currentApyPct: 20, poolTvlUsd: 10_000_000 },
      { positionId: 'pos-1', snapshotAt: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(), currentApyPct: 30, poolTvlUsd: 10_000_000 },
    ];
    const result = computeTimeWeightedApy(snapshots);
    expect(result).toBeCloseTo(13.33, 1);
  });
});

describe('computeRealizedPnl', () => {
  it('computes basic realized PnL', () => {
    const position = makePosition({
      opened_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      closed_at: new Date().toISOString(),
      size_usd: 100,
    });

    const snapshots = makeSnapshots([8, 8, 8], [30, 20, 10]);

    const result = computeRealizedPnl({
      position,
      apySnapshots: snapshots,
      tokenPrices: { tokenA: 1, tokenB: 150 },
      gasPaidSol: 0.001,
      solPriceUsd: 150,
    });

    expect(result.positionId).toBe('pos-1');
    expect(result.feesClaimedUsd).toBeGreaterThan(0);
    expect(result.gasPaidUsd).toBe(0.15);
    expect(result.netPnlUsd).toBe(result.feesClaimedUsd - 0.15);
    expect(result.realizedApyPct).toBeGreaterThan(0);
  });

  it('returns 0 realized APY when no snapshots', () => {
    const position = makePosition();
    const result = computeRealizedPnl({
      position,
      apySnapshots: [],
      tokenPrices: { tokenA: 1, tokenB: 150 },
      gasPaidSol: 0,
      solPriceUsd: 150,
    });
    expect(result.realizedApyPct).toBe(0);
  });

  it('uses created_at when opened_at is null', () => {
    const position = makePosition({ opened_at: null });
    const snapshots = makeSnapshots([8], [0]);
    const result = computeRealizedPnl({
      position,
      apySnapshots: snapshots,
      tokenPrices: { tokenA: 1, tokenB: 150 },
      gasPaidSol: 0,
      solPriceUsd: 150,
    });
    expect(result.positionId).toBe('pos-1');
  });
});
