import { describe, it, expect } from 'vitest';
import {
  classifyPool,
  getExposureByGroup,
  checkConcentrationRisk,
  type CorrelationGroup,
} from './correlation.js';
import type { Position } from '../positions/db.js';

function makePosition(overrides: Partial<Position> & { protocol: string; pool_name: string }): Position {
  return {
    id: 'pos-1',
    opportunity_id: 'opp-1',
    protocol: overrides.protocol,
    pool_id: 'pool-1',
    pool_name: overrides.pool_name,
    state: 'ACTIVE',
    book: null,
    base_mint: null,
    size_usd: overrides.size_usd ?? 100,
    entry_apy: 8,
    entry_price_sol: null,
    opened_at: null,
    closed_at: null,
    close_reason: null,
    notes: null,
    created_at: new Date().toISOString(),
  };
}

describe('classifyPool', () => {
  it('SOL_LP for meteora SOL-USDC', () => {
    expect(classifyPool('meteora_dlmm', 'SOL-USDC DLMM')).toBe('SOL_LP');
  });

  it('STABLECOIN_LP for meteora USDC-USDT', () => {
    expect(classifyPool('meteora_dlmm', 'USDC-USDT DLMM')).toBe('STABLECOIN_LP');
  });

  it('STABLECOIN_LENDING for kamino USDC lending', () => {
    expect(classifyPool('kamino_lending', 'USDC Lending')).toBe('STABLECOIN_LENDING');
  });

  it('SOL_LENDING for marginfi SOL', () => {
    expect(classifyPool('marginfi', 'SOL Supply')).toBe('SOL_LENDING');
  });

  it('LST_STAKING for jito', () => {
    expect(classifyPool('jito', 'JitoSOL')).toBe('LST_STAKING');
  });

  it('LST_STAKING for marginfi lst', () => {
    expect(classifyPool('marginfi', 'mSOL Supply')).toBe('LST_STAKING');
  });

  it('STABLECOIN_LP for kamino vault USDC-USDT', () => {
    expect(classifyPool('kamino_vaults', 'USDC-USDT Vault')).toBe('STABLECOIN_LP');
  });

  it('defaults to STABLECOIN_LENDING for unknown', () => {
    expect(classifyPool('unknown_protocol', 'Unknown Pool')).toBe('STABLECOIN_LENDING');
  });
});

describe('getExposureByGroup', () => {
  it('returns empty map for no positions', () => {
    expect(getExposureByGroup([])).toEqual(new Map());
  });

  it('sums sizes for same group', () => {
    const positions: Position[] = [
      makePosition({ protocol: 'jito', pool_name: 'JitoSOL', size_usd: 50 }),
      makePosition({ protocol: 'marginfi', pool_name: 'mSOL Supply', size_usd: 75 }),
    ];
    const exposure = getExposureByGroup(positions);
    expect(exposure.get('LST_STAKING')).toBe(125);
  });

  it('skips non-ACTIVE positions', () => {
    const positions: Position[] = [
      { ...makePosition({ protocol: 'jito', pool_name: 'JitoSOL', size_usd: 50 }), state: 'ACTIVE' as const },
      { ...makePosition({ protocol: 'jito', pool_name: 'JitoSOL', size_usd: 75 }), state: 'CLOSED' as const },
    ];
    const exposure = getExposureByGroup(positions);
    expect(exposure.get('LST_STAKING')).toBe(50);
  });
});

describe('checkConcentrationRisk', () => {
  it('allows position when under limit', () => {
    const exposure = new Map<CorrelationGroup, number>();
    exposure.set('SOL_LP', 20);

    const result = checkConcentrationRisk({
      currentExposure: exposure,
      newPosition: { group: 'SOL_LP', sizeUsd: 10 },
      maxGroupConcentrationPct: 50,
      totalCapitalUsd: 100,
    });

    expect(result.allowed).toBe(true);
  });

  it('blocks position when would exceed limit', () => {
    const exposure = new Map<CorrelationGroup, number>();
    exposure.set('SOL_LP', 40);

    const result = checkConcentrationRisk({
      currentExposure: exposure,
      newPosition: { group: 'SOL_LP', sizeUsd: 20 },
      maxGroupConcentrationPct: 50,
      totalCapitalUsd: 100,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('exceed');
  });

  it('allows first position with no capital', () => {
    const result = checkConcentrationRisk({
      currentExposure: new Map(),
      newPosition: { group: 'SOL_LP', sizeUsd: 100 },
      maxGroupConcentrationPct: 50,
      totalCapitalUsd: 0,
    });

    expect(result.allowed).toBe(true);
  });
});
