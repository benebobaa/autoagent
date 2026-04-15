import { describe, it, expect } from 'vitest';
import {
  computeApyScore,
  computeLiquidityScore,
  scoreOpportunity,
  scoreAll,
  type RawOpportunity,
} from './engine.js';
import type { AgentConfig } from '../config/loader.js';

// ---------------------------------------------------------------------------
// Test config (minimal, matches agent_config.yaml defaults)
// ---------------------------------------------------------------------------

const testConfig: AgentConfig = {
  protocols: {
    kamino_lending: { trust_score: 90, enabled: true },
    kamino_vaults: { trust_score: 85, enabled: true },
    marginfi: { trust_score: 80, enabled: true },
    jito: { trust_score: 95, enabled: true },
    meteora_dlmm: { trust_score: 80, enabled: true },
  },
  scoring: {
    min_apy_pct: 5.0,
    min_tvl_usd: 500_000,
    min_score_to_suggest: 60,
    min_score_to_watch: 45,
    data_uncertainty_threshold_pct: 15,
  },
  position: { max_position_usd: 100, max_open_positions: 3, min_position_usd: 20, max_group_concentration_pct: 50 },
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
    cooldown_hours_after_bad_exit: 12,
  },
  risk: { circuit_breaker_drawdown_pct: 4.0, max_gas_usd: 0.5 },
  rebalance: { apy_drop_trigger_pct: 30, check_interval_hours: 1 },
  reporting: {
    daily_report_cron: '0 7 * * *',
    scan_cron: '0 6 * * *',
    monitor_cron: '0 * * * *',
  },
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
  regime: {
    bull_threshold_pct: 15,
    bear_threshold_pct: -15,
    high_vol_atr_ratio: 0.03,
    low_vol_atr_ratio: 0.015,
    capitulation_drop_pct: 25,
    euphoria_rise_pct: 40,
  },
  llm: {
    default: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', temperature: 0 },
    overrides: {},
  },
  polling: { data_poll_interval_sec: 300, signal_detect_interval_sec: 900 },
  dispatch: { critical_delay_sec: 0, high_batch_interval_sec: 3600, low_batch_interval_sec: 86400 },
  rag: {
    embedding_provider: 'openai',
    embedding_model: 'text-embedding-3-small',
  },
  rpcUrl: 'https://mainnet.helius-rpc.com/?api-key=0b850758-2dd9-4aaf-b956-9cf624e6a4e9',
  agentWalletAddress: undefined,
  telegramBotToken: undefined,
  telegramChatId: undefined,
  defillamaBaseUrl: 'https://yields.llama.fi',
  kaminoApiBaseUrl: 'https://api.kamino.finance',
  marginfiEnv: 'production',
  dryRun: true,
  logLevel: 'info',
  databaseUrl: process.env['DATABASE_URL'] ?? 'postgresql://yield_agent:yield_agent@localhost:5432/yield_agent',
  meteoraApiBaseUrl: 'https://dlmm-api.meteora.ag',
  meteora: {
    enabled: true,
    min_tvl_usd: 100000,
    min_fee_apr: 0.1,
    max_il_tolerance: 0.05,
    better_opportunity_delta: 0.1,
    max_position_size_usd: 10000,
    bin_step_rules: {
      stablecoin_pairs: { max_bin_step: 10 },
      bluechip_pairs: { max_bin_step: 30 },
      volatile_pairs: { max_bin_step: 150 },
    },
    discovery: {} as any,
    management: {} as any,
    out_of_range_alert_polls: 3,
    active_bin_liquidity_min_pct: 0.15,
    fee_apr_collapse_threshold: 0.60,
    volume_spike_multiplier: 3.0,
    preferred_strategy: 'Spot',
    allowed_pairs: ['SOL-USDC', 'SOL-USDT', 'JitoSOL-SOL', 'mSOL-SOL']
  },
  paper_trading: { enabled: false, starting_balance_usd: 100 },
  swap: { enabled: true, hitl_threshold_usd: 100, default_slippage_bps: 50 },
  risk_tiers: {
    active_tiers: [2, 5, 8],
    enable_meme_discovery: false,
    discovery_scan_interval_min: 20,
    paper_approval_tiers: [8, 9],
  },
  paperTrading: false,
  paperStartingBalanceUsd: 100,
  birdeyeApiKey: '',
  totalCapitalUsd: 500,
  enableMemeDiscovery: false,
  discoveryScanIntervalMin: 20,
  monitorCheckIntervalSec: 60,
  monitorCheckIntervalActiveSec: 180,
};

function makeOpp(overrides: Partial<RawOpportunity> = {}): RawOpportunity {
  return {
    poolId: 'test-pool-1',
    protocol: 'kamino_lending',
    poolName: 'SOL Lending',
    apyDefillama: 10,
    apyProtocol: 10,
    apyUsed: 10,
    tvlUsd: 5_000_000,
    dataUncertain: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// apy_score
// ---------------------------------------------------------------------------

describe('computeApyScore', () => {
  it('returns 20 at exactly 5% APY (floor)', () => {
    expect(computeApyScore(5)).toBe(20);
  });

  it('returns 20 below 5% APY', () => {
    expect(computeApyScore(0)).toBe(20);
    expect(computeApyScore(3)).toBe(20);
  });

  it('returns 100 at exactly 25% APY (ceiling)', () => {
    expect(computeApyScore(25)).toBe(100);
  });

  it('returns 100 above 25% APY (capped)', () => {
    expect(computeApyScore(50)).toBe(100);
    expect(computeApyScore(1000)).toBe(100);
  });

  it('interpolates linearly: 15% APY is midpoint → 60', () => {
    expect(computeApyScore(15)).toBeCloseTo(60, 5);
  });

  it('interpolates correctly at 10% APY → 40', () => {
    // (10-5)/(25-5) * 80 + 20 = 25% * 80 + 20 = 20 + 20 = 40
    expect(computeApyScore(10)).toBeCloseTo(40, 5);
  });
});

// ---------------------------------------------------------------------------
// liquidity_score
// ---------------------------------------------------------------------------

describe('computeLiquidityScore', () => {
  it('returns 20 at $100k TVL (floor)', () => {
    expect(computeLiquidityScore(100_000)).toBe(20);
  });

  it('returns 20 below $100k TVL', () => {
    expect(computeLiquidityScore(0)).toBe(20);
    expect(computeLiquidityScore(50_000)).toBe(20);
  });

  it('returns 100 at $50M TVL (ceiling)', () => {
    expect(computeLiquidityScore(50_000_000)).toBe(100);
  });

  it('returns 100 above $50M TVL', () => {
    expect(computeLiquidityScore(100_000_000)).toBe(100);
  });

  it('log scale: $5M TVL → ~70 (with MIN_TVL=$100k)', () => {
    // log10(100k)=5, log10(50M)=7.699, log10(5M)=6.699 → (1.699/2.699)*80+20 ≈ 70.4
    expect(computeLiquidityScore(5_000_000)).toBeCloseTo(70, 0);
  });

  it('is not linear (score at $5M ≠ midpoint of linear range between $100k and $50M)', () => {
    const atFiveMillion = computeLiquidityScore(5_000_000);
    const linearMidpoint = computeLiquidityScore(25_050_000); // linear midpoint between $100k and $50M
    // On log scale, $5M gives ~70; linear midpoint would give different score
    expect(atFiveMillion).not.toBeCloseTo(linearMidpoint, 0);
  });
});

// ---------------------------------------------------------------------------
// risk_penalty
// ---------------------------------------------------------------------------

describe('risk penalty', () => {
  it('subtracts 3 points (0.15 × 20) when dataUncertain=true in LOW_VOL_RANGE', () => {
    const certain = scoreOpportunity(makeOpp({ dataUncertain: false }), testConfig, 'LOW_VOL_RANGE');
    const uncertain = scoreOpportunity(makeOpp({ dataUncertain: true }), testConfig, 'LOW_VOL_RANGE');
    expect(certain.score - uncertain.score).toBeCloseTo(3, 5);
  });

  it('riskPenalty is 0 when dataUncertain=false', () => {
    const result = scoreOpportunity(makeOpp({ dataUncertain: false }), testConfig);
    expect(result.riskPenalty).toBe(0);
  });

  it('riskPenalty is 20 when dataUncertain=true', () => {
    const result = scoreOpportunity(makeOpp({ dataUncertain: true }), testConfig);
    expect(result.riskPenalty).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// trust_score
// ---------------------------------------------------------------------------

describe('trust score', () => {
  it('jito has higher trust score than kamino_vaults', () => {
    const jito = scoreOpportunity(makeOpp({ protocol: 'jito' }), testConfig);
    const vaults = scoreOpportunity(makeOpp({ protocol: 'kamino_vaults' }), testConfig);
    expect(jito.trustScore).toBeGreaterThan(vaults.trustScore);
    expect(jito.score).toBeGreaterThan(vaults.score);
  });
});

// ---------------------------------------------------------------------------
// recommendation thresholds
// ---------------------------------------------------------------------------

describe('recommendation thresholds', () => {
  it('SUGGEST when score >= 60', () => {
    // High APY + high TVL + high trust = easily SUGGEST
    const result = scoreOpportunity(
      makeOpp({ protocol: 'jito', apyUsed: 25, tvlUsd: 50_000_000, dataUncertain: false }),
      testConfig
    );
    expect(result.recommendation).toBe('SUGGEST');
    expect(result.score).toBeGreaterThanOrEqual(60);
  });

  it('SKIP when score < 45', () => {
    // Minimal APY + minimal TVL = SKIP
    const result = scoreOpportunity(
      makeOpp({ apyUsed: 5, tvlUsd: 500_000, dataUncertain: true, protocol: 'kamino_vaults' }),
      testConfig
    );
    expect(result.recommendation).toBe('SKIP');
    expect(result.score).toBeLessThan(45);
  });
});

// ---------------------------------------------------------------------------
// Full formula integration
// ---------------------------------------------------------------------------

describe('full formula integration', () => {
  it('high APY + high TVL + trusted protocol (jito) = SUGGEST', () => {
    const opp = makeOpp({
      protocol: 'jito',
      apyUsed: 20,
      tvlUsd: 10_000_000,
      dataUncertain: false,
    });
    const result = scoreOpportunity(opp, testConfig);
    expect(result.recommendation).toBe('SUGGEST');
    expect(result.score).toBeGreaterThan(60);
  });

  it('low APY + low TVL + uncertain data = SKIP', () => {
    const opp = makeOpp({
      apyUsed: 5.5,
      tvlUsd: 600_000,
      dataUncertain: true,
      protocol: 'kamino_vaults',
    });
    const result = scoreOpportunity(opp, testConfig);
    expect(result.recommendation).toBe('SKIP');
  });

  it('uncertain data scores lower than identical certain opportunity', () => {
    const certain = scoreOpportunity(makeOpp({ dataUncertain: false }), testConfig);
    const uncertain = scoreOpportunity(makeOpp({ dataUncertain: true }), testConfig);
    expect(certain.score).toBeGreaterThan(uncertain.score);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('APY = 0 → apy_score = 20 (floor)', () => {
    const result = scoreOpportunity(makeOpp({ apyUsed: 0 }), testConfig);
    expect(result.apyScore).toBe(20);
  });

  it('TVL = 0 → liquidity_score = 20 (floor)', () => {
    const result = scoreOpportunity(makeOpp({ tvlUsd: 0 }), testConfig);
    expect(result.liquidityScore).toBe(20);
  });

  it('trust_score = 100 (jito) is used correctly', () => {
    const result = scoreOpportunity(makeOpp({ protocol: 'jito' }), testConfig);
    expect(result.trustScore).toBe(95);
  });

  it('scoreAll filters out opportunities below min_apy_pct', () => {
    const opps = [makeOpp({ apyUsed: 4 }), makeOpp({ apyUsed: 10 })];
    const results = scoreAll(opps, testConfig);
    expect(results).toHaveLength(1);
    expect(results[0]?.apyUsed).toBe(10);
  });

  it('scoreAll filters out opportunities below min_tvl_usd', () => {
    const opps = [makeOpp({ tvlUsd: 100_000 }), makeOpp({ tvlUsd: 1_000_000 })];
    const results = scoreAll(opps, testConfig);
    expect(results).toHaveLength(1);
    expect(results[0]?.tvlUsd).toBe(1_000_000);
  });

  it('scoreAll returns results sorted descending by score', () => {
    const opps = [
      makeOpp({ apyUsed: 5, tvlUsd: 600_000 }),
      makeOpp({ apyUsed: 25, tvlUsd: 50_000_000 }),
      makeOpp({ apyUsed: 15, tvlUsd: 5_000_000 }),
    ];
    const results = scoreAll(opps, testConfig);
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1];
      const curr = results[i];
      if (prev && curr) {
        expect(prev.score).toBeGreaterThanOrEqual(curr.score);
      }
    }
  });
});
