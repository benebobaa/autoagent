import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Connection } from '@solana/web3.js';
import type { AgentConfig } from '../config/loader.js';
import { Database } from '../positions/db.js';
import type { AllocationIntent } from './allocator.js';
import { executePaperAllocationPlan } from './paper-allocation.js';
import type { ExecutionPlan } from '../executor/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createDb() {
  const dir = mkdtempSync(join(tmpdir(), 'yield-agent-paper-'));
  tempDirs.push(dir);
  return new Database(join(dir, 'agent.db'));
}

function makeConfig(): AgentConfig {
  return {
    protocols: {
      kamino_lending: { trust_score: 90, enabled: true },
      kamino_vaults: { trust_score: 85, enabled: true },
      marginfi: { trust_score: 85, enabled: true },
      jito: { trust_score: 95, enabled: true },
      meteora_dlmm: { trust_score: 80, enabled: true },
    },
    scoring: {
      min_apy_pct: 4,
      min_tvl_usd: 500_000,
      min_score_to_suggest: 55,
      min_score_to_watch: 45,
      data_uncertainty_threshold_pct: 15,
    },
    position: {
      max_position_usd: 150,
      max_open_positions: 4,
      min_position_usd: 20,
      max_group_concentration_pct: 50,
    },
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
    risk: {
      circuit_breaker_drawdown_pct: 4,
      max_gas_usd: 0.5,
    },
    rebalance: {
      apy_drop_trigger_pct: 30,
      check_interval_hours: 1,
    },
    reporting: {
      daily_report_cron: '0 7 * * *',
      scan_cron: '0 6 * * *',
      monitor_cron: '0 * * * *',
    },
    signals: {
      tvl_collapse_pct: 0.3,
      portfolio_drawdown_pct: 4,
      il_max_tolerance_pct: 5,
      apy_drift_pct: 0.25,
      better_pool_delta_pp: 2,
      liquidity_crunch_pct: 0.4,
      regime_shift_pct: 0.08,
      high_yield_apy_threshold_pct: 10,
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
    llm: { default: { provider: 'deepseek', model: 'deepseek-chat', temperature: 0 }, overrides: {} },
    polling: { data_poll_interval_sec: 300, signal_detect_interval_sec: 900 },
    dispatch: { critical_delay_sec: 0, high_batch_interval_sec: 3600, low_batch_interval_sec: 3600 },
    rag: { embedding_provider: 'openai', embedding_model: 'text-embedding-3-small' },
    meteora: {
      enabled: true,
      min_tvl_usd: 500_000,
      min_fee_apr: 0.2,
      max_il_tolerance: 0.05,
      better_opportunity_delta: 0.1,
      max_position_size_usd: 10_000,
      bin_step_rules: {
        stablecoin_pairs: { max_bin_step: 10 },
        bluechip_pairs: { max_bin_step: 50 },
        volatile_pairs: { max_bin_step: 150 },
      },
      out_of_range_alert_polls: 4,
      active_bin_liquidity_min_pct: 0.15,
      fee_apr_collapse_threshold: 0.6,
      volume_spike_multiplier: 3,
      preferred_strategy: 'Spot',
      allowed_pairs: ['SOL-USDC'],
      discovery: {
        enabled: false,
        timeframe: '5m',
        min_mcap: 150_000,
        max_mcap: 10_000_000,
        min_holders: 500,
        min_tvl: 10_000,
        max_tvl: 150_000,
        min_volume: 500,
        min_bin_step: 80,
        max_bin_step: 125,
        min_fee_tvl_ratio: 0.05,
        min_organic_score: 60,
        min_global_fees_sol: 30,
        max_top10_holder_pct: 60,
        max_bundler_pct: 30,
        blacklisted_tokens: [],
        blacklisted_launchpads: ['pump.fun', 'letsbonk.fun'],
      },
      management: {
        out_of_range_wait_minutes: 30,
        out_of_range_bins_to_close: 10,
        stop_loss_pct: -50,
        take_profit_pct: 5,
        trailing_take_profit_enabled: true,
        trail_arm_profit_pct: 5,
        trail_drawdown_pct: 2,
        min_fee_per_tvl_24h: 7,
        min_claim_amount_usd: 5,
        auto_swap_after_close: true,
        management_interval_minutes: 10,
      },
    },
    paper_trading: { enabled: true, starting_balance_usd: 500 },
    swap: { enabled: true, hitl_threshold_usd: 100, default_slippage_bps: 50 },
    risk_tiers: {
      active_tiers: [2, 5, 8],
      enable_meme_discovery: false,
      discovery_scan_interval_min: 20,
      paper_approval_tiers: [8, 9],
    },
    rpcUrl: 'https://example.invalid',
    agentWalletAddress: undefined,
    telegramBotToken: undefined,
    telegramChatId: undefined,
    defillamaBaseUrl: 'https://yields.llama.fi',
    kaminoApiBaseUrl: 'https://api.kamino.finance',
    meteoraApiBaseUrl: 'https://dlmm.datapi.meteora.ag',
    marginfiEnv: 'production',
    dryRun: true,
    logLevel: 'info',
    openaiApiKey: undefined,
    embeddingApiKey: undefined,
    databaseUrl: process.env['DATABASE_URL'] ?? 'postgresql://yield_agent:yield_agent@localhost:5432/yield_agent',
    paperTrading: true,
    paperStartingBalanceUsd: 500,
    birdeyeApiKey: '',
    totalCapitalUsd: 500,
    enableMemeDiscovery: false,
    discoveryScanIntervalMin: 20,
    monitorCheckIntervalSec: 60,
    monitorCheckIntervalActiveSec: 180,
  };
}

function makeIntent(overrides: Partial<AllocationIntent> = {}): AllocationIntent {
  return {
    book: 'core',
    sizeUsd: 120,
    historyReason: null,
    opportunity: {
      poolId: 'pool-1',
      protocol: 'jito',
      poolName: 'JitoSOL',
      apyDefillama: 8,
      apyProtocol: 8,
      apyUsed: 8,
      tvlUsd: 10_000_000,
      dataUncertain: false,
      score: 70,
      apyScore: 50,
      liquidityScore: 70,
      trustScore: 90,
      riskPenalty: 0,
      regimePenalty: 0,
      recommendation: 'SUGGEST',
      raw_data: { baseMint: 'So111', tokenAMint: 'So111' },
    },
    ...overrides,
  };
}

describe('executePaperAllocationPlan', () => {
  it('opens active paper positions and writes linked decision episodes', async () => {
    const db = createDb();
    const config = makeConfig();
    await db.initPaperPortfolio(500);

    const buildExecutionPlanFn = async (_opportunity: AllocationIntent['opportunity'], positionId: string): Promise<ExecutionPlan> => ({
      logId: `log-${positionId}`,
      positionId,
      action: 'open',
      txBase64: null,
      txSignatures: [],
      simSuccess: null,
      simLogs: [],
      isDryRun: true,
    });

    const result = await executePaperAllocationPlan({
      intents: [makeIntent()],
      db,
      config,
      connection: {} as Connection,
      buildExecutionPlanFn,
      signalTypes: ['HEARTBEAT'],
      reasoning: 'Deterministic core deployment',
      marketRegime: 'LOW_VOL_RANGE',
      solPriceUsd: 100,
    });

    expect(result.openedPositionIds).toHaveLength(1);
    const positions = await db.getPositionsByState('ACTIVE');
    expect(positions).toHaveLength(1);
    expect(positions[0]?.size_usd).toBe(120);
    expect(positions[0]?.base_mint).toBe('So111');

    const episodes = await db.getEpisodesByPositionId(result.openedPositionIds[0] ?? '');
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.action).toBe('open');
    expect(episodes[0]?.position_size_usd).toBe(120);
  });

  it('skips intents that fail validation, such as cooled-down pools', async () => {
    const db = createDb();
    const config = makeConfig();
    await db.initPaperPortfolio(500);
    await db.upsertPoolCooldown({
      pool_id: 'pool-1',
      reason: 'stop_loss',
      cooldown_until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      source_position_id: null,
    });

    const result = await executePaperAllocationPlan({
      intents: [makeIntent()],
      db,
      config,
      connection: {} as Connection,
      buildExecutionPlanFn: async (_opportunity, positionId) => ({
        logId: `log-${positionId}`,
        positionId,
        action: 'open',
        txBase64: null,
        txSignatures: [],
        simSuccess: null,
        simLogs: [],
        isDryRun: true,
      }),
      signalTypes: ['HEARTBEAT'],
      reasoning: 'Deterministic core deployment',
      marketRegime: 'LOW_VOL_RANGE',
      solPriceUsd: 100,
    });

    expect(result.openedPositionIds).toEqual([]);
    expect(await db.getPositionsByState('ACTIVE')).toHaveLength(0);
  });
});
