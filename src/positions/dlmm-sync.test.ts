import { describe, expect, it } from 'vitest';
import type { Position } from './db.js';
import { buildExecutionOpportunity } from './dlmm-sync.js';

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'position-1',
    opportunity_id: 'opp-1',
    protocol: 'meteora_dlmm',
    pool_id: 'pool-1',
    pool_name: 'SOL-USDC',
    state: 'ACTIVE',
    book: 'core',
    base_mint: 'So111',
    size_usd: 75,
    entry_apy: 18,
    entry_price_sol: null,
    opened_at: '2026-04-05T00:00:00.000Z',
    closed_at: null,
    close_reason: null,
    notes: null,
    created_at: '2026-04-05T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildExecutionOpportunity', () => {
  it('falls back to position data when no stored opportunity exists', () => {
    const result = buildExecutionOpportunity(makePosition(), null);

    expect(result.poolId).toBe('pool-1');
    expect(result.poolName).toBe('SOL-USDC');
    expect(result.apyUsed).toBe(18);
    expect(result.dataUncertain).toBe(true);
    expect(result.score).toBe(50);
  });

  it('preserves stored opportunity metadata when available', () => {
    const result = buildExecutionOpportunity(makePosition(), {
      id: 'opp-1',
      protocol: 'meteora_dlmm',
      pool_id: 'pool-1',
      pool_name: 'SOL-USDC',
      apy_defillama: 15,
      apy_protocol: 18,
      apy_used: 17,
      data_uncertain: 0,
      tvl_usd: 1_250_000,
      score: 74,
      raw_data: { binStep: 25 },
      scanned_at: '2026-04-05T00:00:00.000Z',
    });

    expect(result.apyUsed).toBe(17);
    expect(result.tvlUsd).toBe(1_250_000);
    expect(result.dataUncertain).toBe(false);
    expect(result.score).toBe(74);
    expect(result.raw_data?.['binStep']).toBe(25);
  });
});
