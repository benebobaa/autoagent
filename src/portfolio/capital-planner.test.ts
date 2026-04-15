import { describe, expect, it } from 'vitest';
import type { Position } from '../positions/db.js';
import type { Signal } from '../signals/types.js';
import type { ScoredOpportunity } from '../scoring/engine.js';
import { planCapitalIntents } from './capital-planner.js';
import type { AllocationInputs } from './allocator.js';

function makeOpportunity(overrides: Partial<ScoredOpportunity>): ScoredOpportunity {
  return {
    poolId: 'pool-1',
    protocol: 'jito',
    poolName: 'JitoSOL',
    apyDefillama: 8,
    apyProtocol: 8,
    apyUsed: 8,
    tvlUsd: 10_000_000,
    dataUncertain: false,
    score: 60,
    apyScore: 50,
    liquidityScore: 70,
    trustScore: 90,
    riskPenalty: 0,
    regimePenalty: 0,
    recommendation: 'SUGGEST',
    raw_data: { baseMint: 'mint-default', tokenAMint: 'mint-default' },
    ...overrides,
  };
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'position-1',
    opportunity_id: 'opp-1',
    protocol: 'meteora_dlmm',
    pool_id: 'pool-1',
    pool_name: 'SOL-USDC',
    state: 'ACTIVE',
    book: overrides.book ?? null,
    base_mint: overrides.base_mint ?? null,
    size_usd: 50,
    entry_apy: 12,
    entry_price_sol: null,
    opened_at: new Date().toISOString(),
    closed_at: null,
    close_reason: null,
    notes: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeSignal(overrides: Partial<Signal>): Signal {
  return {
    id: 'signal-1',
    type: 'HEARTBEAT',
    priority: 'LOW',
    timestamp: new Date().toISOString(),
    payload: {},
    dedupKey: 'HEARTBEAT:test',
    processed: false,
    threadId: null,
    ...overrides,
  };
}

function makeInputs(overrides: Partial<AllocationInputs & { signals: Signal[] }> = {}) {
  return {
    signals: [],
    opportunities: [],
    activePoolIds: new Set<string>(),
    cooledPoolIds: new Set<string>(),
    activePositions: [],
    paperTrading: true,
    portfolioUsd: 500,
    availableCashUsd: 200,
    activePositionCount: 0,
    maxOpenPositions: 4,
    minPositionUsd: 20,
    maxPositionUsd: 150,
    maxGroupConcentrationPct: 50,
    protocolBookStats: new Map(),
    baseMintBookStats: new Map(),
    allocator: {
      enabled: true,
      live_enabled: false,
      live_scout_enabled: false,
      live_gas_reserve_sol: 0.1,
      history_enabled: true,
      core_history_min_samples: 3,
      core_history_min_win_rate_pct: 40,
      core_history_min_avg_pnl_usd: 0,
      scout_history_min_samples: 4,
      scout_bad_win_rate_pct: 20,
      scout_bad_avg_pnl_usd: -1,
      target_utilization_pct: 60,
      scout_enabled_paper: true,
      scout_min_score: 45,
      scout_max_positions: 2,
      scout_position_usd: 30,
    },
    ...overrides,
  };
}

describe('planCapitalIntents', () => {
  it('emits deterministic close intents from hard DLMM signals', () => {
    const intents = planCapitalIntents(makeInputs({
      paperTrading: false,
      activePositions: [makePosition()],
      signals: [makeSignal({
        type: 'DLMM_STOP_LOSS',
        priority: 'CRITICAL',
        payload: { positionId: 'position-1', pnlPct: -6 },
      })],
    }));

    expect(intents).toHaveLength(1);
    expect(intents[0]?.action).toBe('close');
    expect(intents[0]?.closeReason).toBe('stop_loss');
    expect(intents[0]?.positionId).toBe('position-1');
  });

  it('suppresses open intents when a deterministic close intent exists', () => {
    const intents = planCapitalIntents(makeInputs({
      activePositions: [makePosition()],
      opportunities: [makeOpportunity({ poolId: 'suggest-1' })],
      signals: [makeSignal({
        type: 'DLMM_FEE_YIELD_LOW',
        priority: 'HIGH',
        payload: { positionId: 'position-1', feePerTvl24h: 3 },
      })],
    }));

    expect(intents).toHaveLength(1);
    expect(intents[0]?.action).toBe('close');
  });

  it('emits deterministic fee-claim intents before allocator opens', () => {
    const intents = planCapitalIntents(makeInputs({
      activePositions: [makePosition()],
      opportunities: [makeOpportunity({ poolId: 'suggest-1', score: 72, recommendation: 'SUGGEST' })],
      signals: [makeSignal({
        type: 'DLMM_FEE_CLAIM_READY',
        priority: 'LOW',
        payload: { positionId: 'position-1', unclaimedFeesUsd: 7.25 },
      })],
    }));

    expect(intents).toHaveLength(1);
    expect(intents[0]?.action).toBe('claim_fee');
    expect(intents[0]?.positionId).toBe('position-1');
    expect(intents[0]?.notes).toContain('7.25');
  });

  it('maps trailing take-profit monitor signals into deterministic close intents', () => {
    const intents = planCapitalIntents(makeInputs({
      paperTrading: false,
      activePositions: [makePosition()],
      signals: [makeSignal({
        type: 'DLMM_TRAILING_TP',
        priority: 'HIGH',
        payload: { positionId: 'position-1', peakPnlPct: 8, currentPnlPct: 5.5, drawdownPct: 2.5 },
      })],
    }));

    expect(intents).toHaveLength(1);
    expect(intents[0]?.action).toBe('close');
    expect(intents[0]?.closeReason).toBe('trailing_take_profit');
  });

  it('emits core open intents in paper mode from SUGGEST opportunities', () => {
    const intents = planCapitalIntents(makeInputs({
      opportunities: [
        makeOpportunity({ poolId: 'suggest-1', score: 72, recommendation: 'SUGGEST' }),
        makeOpportunity({ poolId: 'suggest-2', score: 69, recommendation: 'SUGGEST' }),
      ],
    }));

    expect(intents.map((intent) => intent.poolId)).toEqual(['suggest-1', 'suggest-2']);
    expect(intents.every((intent) => intent.action === 'open')).toBe(true);
    expect(intents.every((intent) => intent.book === 'core')).toBe(true);
  });

  it('emits scout intents only in paper mode when utilization is low and no SUGGEST candidates exist', () => {
    const intents = planCapitalIntents(makeInputs({
      availableCashUsd: 440,
      opportunities: [
        makeOpportunity({ poolId: 'watch-1', score: 52, recommendation: 'WATCH' }),
        makeOpportunity({ poolId: 'watch-2', score: 49, recommendation: 'WATCH' }),
      ],
    }));

    expect(intents.map((intent) => intent.poolId)).toEqual(['watch-1', 'watch-2']);
    expect(intents.every((intent) => intent.book === 'scout')).toBe(true);
  });

  it('does not emit live open intents when live allocation is disabled', () => {
    const intents = planCapitalIntents(makeInputs({
      paperTrading: false,
      opportunities: [makeOpportunity({ poolId: 'suggest-1', score: 72, recommendation: 'SUGGEST' })],
    }));

    expect(intents).toEqual([]);
  });

  it('emits live core open intents when live allocation is enabled', () => {
    const intents = planCapitalIntents(makeInputs({
      paperTrading: false,
      availableCashUsd: 200,
      portfolioUsd: 500,
      allocator: {
        enabled: true,
        live_enabled: true,
        live_scout_enabled: false,
        live_gas_reserve_sol: 0.1,
        history_enabled: true,
        core_history_min_samples: 3,
        core_history_min_win_rate_pct: 40,
        core_history_min_avg_pnl_usd: 0,
        scout_history_min_samples: 4,
        scout_bad_win_rate_pct: 20,
        scout_bad_avg_pnl_usd: -1,
        target_utilization_pct: 60,
        scout_enabled_paper: true,
        scout_min_score: 45,
        scout_max_positions: 2,
        scout_position_usd: 30,
      },
      opportunities: [makeOpportunity({ poolId: 'suggest-1', score: 72, recommendation: 'SUGGEST' })],
    }));

    expect(intents).toHaveLength(1);
    expect(intents[0]?.action).toBe('open');
    expect(intents[0]?.book).toBe('core');
  });

  it('includes history-aware notes on deterministic open intents', () => {
    const intents = planCapitalIntents(makeInputs({
      opportunities: [makeOpportunity({ poolId: 'suggest-1', protocol: 'jito', recommendation: 'SUGGEST' })],
      protocolBookStats: new Map([
        ['jito', { core: { protocol: 'jito', book: 'core', count: 5, avgPnl: 1.2, winRate: 80 } }],
      ]),
    }));

    expect(intents).toHaveLength(1);
    expect(intents[0]?.notes).toContain('History: strong core protocol history');
  });

  it('includes token-history reasoning in deterministic open intent notes', () => {
    const intents = planCapitalIntents(makeInputs({
      opportunities: [
        makeOpportunity({
          poolId: 'suggest-1',
          protocol: 'meteora_dlmm',
          recommendation: 'SUGGEST',
          raw_data: { baseMint: 'bonk-mint', tokenAMint: 'bonk-mint' },
        }),
      ],
      protocolBookStats: new Map([
        ['meteora_dlmm', { core: { protocol: 'meteora_dlmm', book: 'core', count: 5, avgPnl: 0.5, winRate: 60 } }],
      ]),
      baseMintBookStats: new Map([
        ['bonk-mint', { core: { baseMint: 'bonk-mint', book: 'core', count: 5, avgPnl: 0.8, winRate: 70 } }],
      ]),
    }));

    expect(intents).toHaveLength(1);
    expect(intents[0]?.notes).toContain('token');
  });
});
