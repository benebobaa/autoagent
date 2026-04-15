import { describe, it, expect } from 'vitest';
import { detectSignals } from './detector.js';
import type { MarketSnapshot, PoolSnapshot } from './snapshot.js';
import type { Position } from '../positions/db.js';
import type { AgentConfig } from '../config/loader.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG: Pick<AgentConfig, 'signals' | 'scoring' | 'meteora'> = {
  signals: {
    tvl_collapse_pct: 0.30,
    portfolio_drawdown_pct: 4.0,
    il_max_tolerance_pct: 5.0,
    apy_drift_pct: 0.25,
    better_pool_delta_pp: 2.0,
    liquidity_crunch_pct: 0.40,
    regime_shift_pct: 0.08,
    high_yield_apy_threshold_pct: 10.0,
    position_aging_days: 14,
  },
  scoring: {
    min_apy_pct: 5,
    min_tvl_usd: 500_000,
    min_score_to_suggest: 55,
    min_score_to_watch: 45,
    data_uncertainty_threshold_pct: 15,
  },
  meteora: {
    enabled: true,
    min_tvl_usd: 500_000,
    min_fee_apr: 0.20,
    max_il_tolerance: 0.05,
    better_opportunity_delta: 0.10,
    max_position_size_usd: 10000,
    bin_step_rules: {
      stablecoin_pairs: { max_bin_step: 10 },
      bluechip_pairs: { max_bin_step: 50 },
      volatile_pairs: { max_bin_step: 150 },
    },
    discovery: {} as any,
    management: {} as any,
    out_of_range_alert_polls: 4,
    active_bin_liquidity_min_pct: 0.15,
    fee_apr_collapse_threshold: 0.60,
    volume_spike_multiplier: 3.0,
    preferred_strategy: 'Spot',
    allowed_pairs: ['SOL-USDC'],
  },
} as const;

function makePool(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    poolId: 'pool-1',
    protocol: 'jito',
    poolName: 'JitoSOL',
    apyPct: 8.0,
    tvlUsd: 10_000_000,
    il7d: null,
    score: 70,
    snapshotAt: '2026-03-31T06:00:00.000Z',
    ...overrides,
  };
}

function makeSnapshot(
  pools: PoolSnapshot[],
  solPrice = 150,
  ts = '2026-03-31T06:00:00.000Z'
): MarketSnapshot {
  return {
    id: 'snap-1',
    snapshotAt: ts,
    pools,
    solPriceUsd: solPrice,
    hash: 'test-hash',
  };
}

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
    opened_at: '2026-03-01T00:00:00.000Z',
    closed_at: null,
    close_reason: null,
    notes: null,
    created_at: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TVL_COLLAPSE — CRITICAL
// ---------------------------------------------------------------------------

describe('TVL_COLLAPSE', () => {
  it('fires CRITICAL when TVL drops > 30% and we hold a position', () => {
    const prev = makeSnapshot([makePool({ tvlUsd: 10_000_000 })]);
    const curr = makeSnapshot([makePool({ tvlUsd: 6_000_000 })]);
    // pool-1 matches the default makePool poolId
    const position = makePosition({ pool_id: 'pool-1', state: 'ACTIVE' });
    const signals = detectSignals(curr, prev, [position], BASE_CONFIG as AgentConfig);
    const tvl = signals.filter((s) => s.type === 'TVL_COLLAPSE');
    expect(tvl).toHaveLength(1);
    expect(tvl[0]?.priority).toBe('CRITICAL');
  });

  it('fires HIGH when TVL drops > 30% but we hold no position', () => {
    const prev = makeSnapshot([makePool({ tvlUsd: 10_000_000 })]);
    const curr = makeSnapshot([makePool({ tvlUsd: 6_000_000 })]);
    const signals = detectSignals(curr, prev, [], BASE_CONFIG as AgentConfig);
    const tvl = signals.filter((s) => s.type === 'TVL_COLLAPSE');
    expect(tvl).toHaveLength(1);
    expect(tvl[0]?.priority).toBe('HIGH');
  });

  it('does not fire when TVL drop < 30%', () => {
    const prev = makeSnapshot([makePool({ tvlUsd: 10_000_000 })]);
    const curr = makeSnapshot([makePool({ tvlUsd: 8_000_000 })]); // 20% drop
    const signals = detectSignals(curr, prev, [], BASE_CONFIG as AgentConfig);
    expect(signals.filter((s) => s.type === 'TVL_COLLAPSE')).toHaveLength(0);
  });

  it('does not fire when previous snapshot is null', () => {
    const curr = makeSnapshot([makePool({ tvlUsd: 100 })]);
    const signals = detectSignals(curr, null, [], BASE_CONFIG as AgentConfig);
    expect(signals.filter((s) => s.type === 'TVL_COLLAPSE')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LIQUIDITY_CRUNCH — HIGH
// ---------------------------------------------------------------------------

describe('LIQUIDITY_CRUNCH', () => {
  it('fires when TVL drops 40-50% (above crunch, below collapse)', () => {
    const prev = makeSnapshot([makePool({ tvlUsd: 10_000_000 })]);
    const curr = makeSnapshot([makePool({ tvlUsd: 5_500_000 })]); // 45% drop
    const signals = detectSignals(curr, prev, [], BASE_CONFIG as AgentConfig);
    const crunch = signals.filter((s) => s.type === 'LIQUIDITY_CRUNCH');
    expect(crunch).toHaveLength(1);
    expect(crunch[0]?.priority).toBe('HIGH');
  });

  it('can fire alongside TVL_COLLAPSE when drop is above both thresholds', () => {
    // 50% drop exceeds both tvl_collapse_pct (30%) and liquidity_crunch_pct (40%)
    // Both signals are independent and can fire on the same pool
    const prev = makeSnapshot([makePool({ tvlUsd: 10_000_000 })]);
    const curr = makeSnapshot([makePool({ tvlUsd: 5_000_000 })]); // 50% drop
    const signals = detectSignals(curr, prev, [], BASE_CONFIG as AgentConfig);
    expect(signals.filter((s) => s.type === 'LIQUIDITY_CRUNCH')).toHaveLength(1);
    expect(signals.filter((s) => s.type === 'TVL_COLLAPSE')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// REGIME_SHIFT — HIGH
// ---------------------------------------------------------------------------

describe('REGIME_SHIFT', () => {
  it('fires when SOL price drops > 8%', () => {
    const prev = makeSnapshot([], 150);
    const curr = makeSnapshot([], 136); // -9.3%
    const signals = detectSignals(curr, prev, [], BASE_CONFIG as AgentConfig);
    const regime = signals.filter((s) => s.type === 'REGIME_SHIFT');
    expect(regime).toHaveLength(1);
    expect((regime[0]?.payload as { direction: string }).direction).toBe('down');
  });

  it('fires when SOL price pumps > 8%', () => {
    const prev = makeSnapshot([], 150);
    const curr = makeSnapshot([], 165); // +10%
    const signals = detectSignals(curr, prev, [], BASE_CONFIG as AgentConfig);
    const regime = signals.filter((s) => s.type === 'REGIME_SHIFT');
    expect(regime).toHaveLength(1);
    expect((regime[0]?.payload as { direction: string }).direction).toBe('up');
  });

  it('does not fire on small price move', () => {
    const prev = makeSnapshot([], 150);
    const curr = makeSnapshot([], 154); // +2.7%
    const signals = detectSignals(curr, prev, [], BASE_CONFIG as AgentConfig);
    expect(signals.filter((s) => s.type === 'REGIME_SHIFT')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// APY_DRIFT — HIGH
// ---------------------------------------------------------------------------

describe('APY_DRIFT', () => {
  it('fires when active position APY drops > 25% from entry', () => {
    const pos = makePosition({ entry_apy: 8.0 });
    const curr = makeSnapshot([makePool({ apyPct: 5.0 })]); // 37.5% drop from 8%
    const signals = detectSignals(curr, null, [pos], BASE_CONFIG as AgentConfig);
    const drift = signals.filter((s) => s.type === 'APY_DRIFT');
    expect(drift).toHaveLength(1);
    expect(drift[0]?.priority).toBe('HIGH');
  });

  it('does not fire when APY drop is minor', () => {
    const pos = makePosition({ entry_apy: 8.0 });
    const curr = makeSnapshot([makePool({ apyPct: 7.0 })]); // 12.5% drop
    const signals = detectSignals(curr, null, [pos], BASE_CONFIG as AgentConfig);
    expect(signals.filter((s) => s.type === 'APY_DRIFT')).toHaveLength(0);
  });

  it('does not fire for non-ACTIVE positions', () => {
    const pos = makePosition({ entry_apy: 8.0, state: 'PENDING_REBALANCE' });
    const curr = makeSnapshot([makePool({ apyPct: 4.0 })]);
    const signals = detectSignals(curr, null, [pos], BASE_CONFIG as AgentConfig);
    expect(signals.filter((s) => s.type === 'APY_DRIFT')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// IL_BREACH — CRITICAL
// ---------------------------------------------------------------------------

describe('IL_BREACH', () => {
  it('fires when pool il7d exceeds tolerance', () => {
    const pos = makePosition();
    const curr = makeSnapshot([makePool({ il7d: 7.0 })]); // > 5% tolerance
    const signals = detectSignals(curr, null, [pos], BASE_CONFIG as AgentConfig);
    const il = signals.filter((s) => s.type === 'IL_BREACH');
    expect(il).toHaveLength(1);
    expect(il[0]?.priority).toBe('CRITICAL');
  });

  it('does not fire when il7d is null (not an LP pool)', () => {
    const pos = makePosition();
    const curr = makeSnapshot([makePool({ il7d: null })]);
    const signals = detectSignals(curr, null, [pos], BASE_CONFIG as AgentConfig);
    expect(signals.filter((s) => s.type === 'IL_BREACH')).toHaveLength(0);
  });

  it('does not fire when il7d is within tolerance', () => {
    const pos = makePosition();
    const curr = makeSnapshot([makePool({ il7d: 3.0 })]); // < 5%
    const signals = detectSignals(curr, null, [pos], BASE_CONFIG as AgentConfig);
    expect(signals.filter((s) => s.type === 'IL_BREACH')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// BETTER_POOL — HIGH
// ---------------------------------------------------------------------------

describe('BETTER_POOL', () => {
  it('fires when same-protocol pool has APY > current + 2pp', () => {
    const pos = makePosition({ pool_id: 'pool-1' });
    const currentPool = makePool({ poolId: 'pool-1', apyPct: 6.0 });
    const betterPool = makePool({ poolId: 'pool-2', apyPct: 9.0 }); // +3pp
    const curr = makeSnapshot([currentPool, betterPool]);
    const signals = detectSignals(curr, null, [pos], BASE_CONFIG as AgentConfig);
    const better = signals.filter((s) => s.type === 'BETTER_POOL');
    expect(better).toHaveLength(1);
    expect(better[0]?.priority).toBe('HIGH');
  });

  it('does not fire when delta is less than threshold', () => {
    const pos = makePosition({ pool_id: 'pool-1' });
    const currentPool = makePool({ poolId: 'pool-1', apyPct: 6.0 });
    const slightlyBetter = makePool({ poolId: 'pool-2', apyPct: 7.0 }); // +1pp < 2pp
    const curr = makeSnapshot([currentPool, slightlyBetter]);
    const signals = detectSignals(curr, null, [pos], BASE_CONFIG as AgentConfig);
    expect(signals.filter((s) => s.type === 'BETTER_POOL')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// POSITION_AGING — LOW
// ---------------------------------------------------------------------------

describe('POSITION_AGING', () => {
  it('fires when position is held longer than threshold', () => {
    const openedAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(); // 15 days ago
    const pos = makePosition({ opened_at: openedAt });
    const curr = makeSnapshot([makePool()]);
    const signals = detectSignals(curr, null, [pos], BASE_CONFIG as AgentConfig);
    const aging = signals.filter((s) => s.type === 'POSITION_AGING');
    expect(aging).toHaveLength(1);
    expect(aging[0]?.priority).toBe('LOW');
  });

  it('does not fire for recently opened positions', () => {
    const openedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago
    const pos = makePosition({ opened_at: openedAt });
    const curr = makeSnapshot([makePool()]);
    const signals = detectSignals(curr, null, [pos], BASE_CONFIG as AgentConfig);
    expect(signals.filter((s) => s.type === 'POSITION_AGING')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// NEW_HIGH_YIELD_POOL — LOW
// ---------------------------------------------------------------------------

describe('NEW_HIGH_YIELD_POOL', () => {
  it('fires when a high-yield pool is not in any active position', () => {
    const curr = makeSnapshot([makePool({ poolId: 'new-pool', apyPct: 15.0, score: 75 })]);
    const signals = detectSignals(curr, null, [], BASE_CONFIG as AgentConfig);
    const newPool = signals.filter((s) => s.type === 'NEW_HIGH_YIELD_POOL');
    expect(newPool).toHaveLength(1);
    expect(newPool[0]?.priority).toBe('LOW');
  });

  it('does not fire when pool is already in an active position', () => {
    const pos = makePosition({ pool_id: 'pool-1' });
    const curr = makeSnapshot([makePool({ poolId: 'pool-1', apyPct: 15.0, score: 75 })]);
    const signals = detectSignals(curr, null, [pos], BASE_CONFIG as AgentConfig);
    expect(signals.filter((s) => s.type === 'NEW_HIGH_YIELD_POOL')).toHaveLength(0);
  });

  it('does not fire when APY is below threshold', () => {
    const curr = makeSnapshot([makePool({ poolId: 'pool-1', apyPct: 7.0, score: 75 })]);
    const signals = detectSignals(curr, null, [], BASE_CONFIG as AgentConfig);
    expect(signals.filter((s) => s.type === 'NEW_HIGH_YIELD_POOL')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Deduplication key format
// ---------------------------------------------------------------------------

describe('deduplication keys', () => {
  it('includes YYYY-MM-DD date in dedup key', () => {
    const curr = makeSnapshot([makePool({ poolId: 'pool-1', apyPct: 15.0, score: 75 })]);
    const signals = detectSignals(curr, null, [], BASE_CONFIG as AgentConfig);
    const signal = signals.find((s) => s.type === 'NEW_HIGH_YIELD_POOL');
    expect(signal?.dedupKey).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('includes pool_id in dedup key for pool-level signals', () => {
    const prev = makeSnapshot([makePool({ poolId: 'my-pool', tvlUsd: 10_000_000 })]);
    const curr = makeSnapshot([makePool({ poolId: 'my-pool', tvlUsd: 4_000_000 })]);
    const signals = detectSignals(curr, prev, [], BASE_CONFIG as AgentConfig);
    const collapse = signals.find((s) => s.type === 'TVL_COLLAPSE');
    expect(collapse?.dedupKey).toContain('my-pool');
  });
});

// ---------------------------------------------------------------------------
// METEORA DLMM SIGNALS
// ---------------------------------------------------------------------------

describe('METEORA_OUT_OF_RANGE', () => {
  it('fires only after crossing consecutive poll threshold', () => {
    const pos = makePosition({
      protocol: 'meteora_dlmm',
      notes: JSON.stringify({ lowerBinId: 100, upperBinId: 200 }),
    });

    for (let i = 1; i <= 4; i++) {
        const curr = makeSnapshot([
            makePool({ protocol: 'meteora_dlmm', activeBinId: 50 }),
        ]);
        const signals = detectSignals(curr, null, [pos], BASE_CONFIG as AgentConfig);
        const outOfRange = signals.filter((s) => s.type === 'METEORA_OUT_OF_RANGE');
        
        if (i < 4) {
            expect(outOfRange).toHaveLength(0);
        } else {
            expect(outOfRange).toHaveLength(1);
            expect(outOfRange[0]?.priority).toBe('CRITICAL');
        }
    }
  });

  it('resets count if back in range', () => {
    const pos = makePosition({
      protocol: 'meteora_dlmm',
      notes: JSON.stringify({ lowerBinId: 100, upperBinId: 200 }),
    });

    // 1st out of range
    detectSignals(makeSnapshot([makePool({ protocol: 'meteora_dlmm', activeBinId: 50 })]), null, [pos], BASE_CONFIG as AgentConfig);
    // back in range
    detectSignals(makeSnapshot([makePool({ protocol: 'meteora_dlmm', activeBinId: 150 })]), null, [pos], BASE_CONFIG as AgentConfig);
    
    // next 3 out of range shouldn't fire
    for (let i = 1; i <= 3; i++) {
        const curr = makeSnapshot([
            makePool({ protocol: 'meteora_dlmm', activeBinId: 50 }),
        ]);
        const signals = detectSignals(curr, null, [pos], BASE_CONFIG as AgentConfig);
        expect(signals.filter((s) => s.type === 'METEORA_OUT_OF_RANGE')).toHaveLength(0);
    }
  });
});

describe('METEORA_BIN_STEP_MISMATCH', () => {
  it('fires when bin step is inappropriate for bluechip', () => {
    const curr = makeSnapshot([
      makePool({ protocol: 'meteora_dlmm', poolName: 'SOL-USDC', binStep: 100 }), // 100 > 50 config
    ]);
    const signals = detectSignals(curr, null, [], BASE_CONFIG as AgentConfig);
    const mismatch = signals.filter((s) => s.type === 'METEORA_BIN_STEP_MISMATCH');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]?.priority).toBe('LOW');
  });

  it('does not fire for valid bin steps', () => {
    const curr = makeSnapshot([
      makePool({ protocol: 'meteora_dlmm', poolName: 'SOL-USDC', binStep: 20 }), // <= 50 config
    ]);
    const signals = detectSignals(curr, null, [], BASE_CONFIG as AgentConfig);
    expect(signals.filter((s) => s.type === 'METEORA_BIN_STEP_MISMATCH')).toHaveLength(0);
  });
});

describe('METEORA_FEE_APR_COLLAPSE', () => {
  it('fires when APR drops significantly after multiple polls', async () => {
    const poolId = 'pool-apr-collapse';
    const initSnapshot = makeSnapshot([makePool({ poolId: poolId, protocol: 'meteora_dlmm', feeApr24h: 1.0 })]);
    const pos = makePosition({ state: 'ACTIVE', pool_id: poolId, protocol: 'meteora_dlmm' });
    
    // Poll 1
    detectSignals(initSnapshot, null, [pos], BASE_CONFIG as AgentConfig);
    // Poll 2
    detectSignals(initSnapshot, initSnapshot, [pos], BASE_CONFIG as AgentConfig);
    
    // Poll 3: APR drops 70%
    const dropSnapshot = makeSnapshot([makePool({ poolId: poolId, protocol: 'meteora_dlmm', feeApr24h: 0.3 })]);
    
    const signals = detectSignals(dropSnapshot, initSnapshot, [pos], BASE_CONFIG as AgentConfig);
    const collapseSignals = signals.filter(s => s.type === 'METEORA_FEE_APR_COLLAPSE');
    expect(collapseSignals).toHaveLength(1);
    expect(collapseSignals[0]?.type).toBe('METEORA_FEE_APR_COLLAPSE');
  });
});

describe('METEORA_HIGH_VOLUME_SPIKE', () => {
  it('fires volume spikes 3x with decent APR', () => {
    const prev = makeSnapshot([makePool({ protocol: 'meteora_dlmm', volume24hUsd: 1000, feeApr24h: 0.5 })]);
    const curr = makeSnapshot([makePool({ protocol: 'meteora_dlmm', volume24hUsd: 3500, feeApr24h: 0.5, apyPct: 50.0 })]);
    
    const signals = detectSignals(curr, prev, [], BASE_CONFIG as AgentConfig);
    
    const spike = signals.filter((s) => s.type === 'METEORA_HIGH_VOLUME_SPIKE');
    expect(spike).toHaveLength(1);
    expect(spike[0]?.priority).toBe('HIGH');
  });
});
