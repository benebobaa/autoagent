import { describe, expect, it } from 'vitest';
import { buildAllocationPlan, type AllocationInputs } from './allocator.js';
import type { ScoredOpportunity } from '../scoring/engine.js';

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

function makeInputs(overrides: Partial<AllocationInputs> = {}): AllocationInputs {
  return {
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

describe('buildAllocationPlan', () => {
  it('allocates core-book capital to SUGGEST opportunities before WATCH opportunities', () => {
    const plan = buildAllocationPlan(
      makeInputs({
        opportunities: [
          makeOpportunity({ poolId: 'watch-1', score: 50, recommendation: 'WATCH' }),
          makeOpportunity({ poolId: 'suggest-1', score: 72, recommendation: 'SUGGEST' }),
          makeOpportunity({ poolId: 'suggest-2', score: 69, recommendation: 'SUGGEST' }),
        ],
      })
    );

    expect(plan.map((intent) => intent.opportunity.poolId)).toEqual(['suggest-1', 'suggest-2']);
    expect(plan.every((intent) => intent.book === 'core')).toBe(true);
    expect(plan.every((intent) => intent.sizeUsd === 100)).toBe(true);
  });

  it('uses the scout sleeve only in paper mode when utilization is below target and no SUGGEST opportunities exist', () => {
    const plan = buildAllocationPlan(
      makeInputs({
        availableCashUsd: 440,
        opportunities: [
          makeOpportunity({ poolId: 'watch-1', score: 52, recommendation: 'WATCH' }),
          makeOpportunity({ poolId: 'watch-2', score: 49, recommendation: 'WATCH' }),
        ],
      })
    );

    expect(plan.map((intent) => intent.opportunity.poolId)).toEqual(['watch-1', 'watch-2']);
    expect(plan.every((intent) => intent.book === 'scout')).toBe(true);
    expect(plan.every((intent) => intent.sizeUsd === 30)).toBe(true);
  });

  it('ignores held and cooled pools, and does not use the scout sleeve outside paper mode', () => {
    const plan = buildAllocationPlan(
      makeInputs({
        paperTrading: false,
        availableCashUsd: 440,
        activePoolIds: new Set(['held-1']),
        cooledPoolIds: new Set(['cooldown-1']),
        opportunities: [
          makeOpportunity({ poolId: 'held-1', score: 75, recommendation: 'SUGGEST' }),
          makeOpportunity({ poolId: 'cooldown-1', score: 74, recommendation: 'SUGGEST' }),
          makeOpportunity({ poolId: 'watch-1', score: 52, recommendation: 'WATCH' }),
        ],
      })
    );

    expect(plan).toEqual([]);
  });

  it('blocks core candidates with bad protocol history and falls through to safer protocols', () => {
    const plan = buildAllocationPlan(
      makeInputs({
        opportunities: [
          makeOpportunity({ poolId: 'bad-core', protocol: 'jito', score: 72, recommendation: 'SUGGEST' }),
          makeOpportunity({ poolId: 'good-core', protocol: 'marginfi', poolName: 'USDC Supply', score: 68, recommendation: 'SUGGEST' }),
        ],
        protocolBookStats: new Map([
          ['jito', { core: { protocol: 'jito', book: 'core', count: 4, avgPnl: -0.5, winRate: 25 } }],
          ['marginfi', { core: { protocol: 'marginfi', book: 'core', count: 4, avgPnl: 0.8, winRate: 75 } }],
        ]),
      })
    );

    expect(plan).toHaveLength(1);
    expect(plan[0]?.opportunity.poolId).toBe('good-core');
    expect(plan[0]?.historyReason).toContain('strong core protocol history');
  });

  it('reranks scout candidates using book-specific historical performance', () => {
    const plan = buildAllocationPlan(
      makeInputs({
        availableCashUsd: 440,
        opportunities: [
          makeOpportunity({ poolId: 'weak-scout', protocol: 'jito', score: 53, recommendation: 'WATCH' }),
          makeOpportunity({ poolId: 'good-scout', protocol: 'marginfi', poolName: 'USDC Supply', score: 50, recommendation: 'WATCH' }),
        ],
        protocolBookStats: new Map([
          ['jito', { scout: { protocol: 'jito', book: 'scout', count: 5, avgPnl: -0.2, winRate: 35 } }],
          ['marginfi', { scout: { protocol: 'marginfi', book: 'scout', count: 5, avgPnl: 0.6, winRate: 60 } }],
        ]),
      })
    );

    expect(plan.map((intent) => intent.opportunity.poolId)).toEqual(['good-scout', 'weak-scout']);
    expect(plan[0]?.historyReason).toContain('constructive scout protocol history');
    expect(plan[1]?.historyReason).toContain('weak scout protocol history');
  });

  it('uses base-mint history to separate same-protocol core candidates', () => {
    const plan = buildAllocationPlan(
      makeInputs({
        opportunities: [
          makeOpportunity({
            poolId: 'mint-weak',
            protocol: 'meteora_dlmm',
            poolName: 'Meteora DLMM: WEN-SOL',
            score: 72,
            recommendation: 'SUGGEST',
            raw_data: { baseMint: 'wen-mint', tokenAMint: 'wen-mint' },
          }),
          makeOpportunity({
            poolId: 'mint-strong',
            protocol: 'meteora_dlmm',
            poolName: 'Meteora DLMM: BONK-SOL',
            score: 70,
            recommendation: 'SUGGEST',
            raw_data: { baseMint: 'bonk-mint', tokenAMint: 'bonk-mint' },
          }),
        ],
        protocolBookStats: new Map([
          ['meteora_dlmm', { core: { protocol: 'meteora_dlmm', book: 'core', count: 5, avgPnl: 0.4, winRate: 60 } }],
        ]),
        baseMintBookStats: new Map([
          ['wen-mint', { core: { baseMint: 'wen-mint', book: 'core', count: 5, avgPnl: -0.8, winRate: 20 } }],
          ['bonk-mint', { core: { baseMint: 'bonk-mint', book: 'core', count: 5, avgPnl: 0.6, winRate: 70 } }],
        ]),
      })
    );

    expect(plan).toHaveLength(1);
    expect(plan[0]?.opportunity.poolId).toBe('mint-strong');
    expect(plan[0]?.historyReason).toContain('token');
  });
});
