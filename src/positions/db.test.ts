import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AgentConfig } from '../config/loader.js';
import { Database } from './db.js';
import { validateNewPosition } from './statemachine.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createDb() {
  const dir = mkdtempSync(join(tmpdir(), 'yield-agent-db-'));
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

describe('pool cooldowns', () => {
  it('stores and returns active cooldowns', async () => {
    const db = createDb();
    const cooldownUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await db.upsertPoolCooldown({
      pool_id: 'pool-1',
      reason: 'fee_yield_low',
      cooldown_until: cooldownUntil,
      source_position_id: null,
    });

    const cooldown = await db.getActivePoolCooldown('pool-1');
    expect(cooldown?.pool_id).toBe('pool-1');
    expect(cooldown?.reason).toBe('fee_yield_low');
    expect(await db.getActivePoolCooldowns()).toHaveLength(1);
  });

  it('blocks new positions while a pool cooldown is active', async () => {
    const db = createDb();
    const config = makeConfig();

    await db.upsertPoolCooldown({
      pool_id: 'pool-1',
      reason: 'stop_loss',
      cooldown_until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      source_position_id: null,
    });

    const result = await validateNewPosition(30, config, db, 'meteora_dlmm', 'SOL-USDC', 'pool-1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('cooldown');
  });

  it('blocks duplicate base mint exposure across active positions', async () => {
    const db = createDb();
    const config = makeConfig();

    const opportunity = await db.insertOpportunity({
      protocol: 'meteora_dlmm',
      pool_id: 'pool-existing',
      pool_name: 'SOL-BONK',
      apy_defillama: null,
      apy_protocol: 20,
      apy_used: 20,
      data_uncertain: 0,
      tvl_usd: 500_000,
      score: 72,
      raw_data: { baseMint: 'bonk-mint' },
    });

    await db.insertPosition({
      opportunity_id: opportunity.id,
      protocol: opportunity.protocol,
      pool_id: opportunity.pool_id,
      pool_name: opportunity.pool_name,
      state: 'ACTIVE',
      book: 'core',
      base_mint: 'bonk-mint',
      size_usd: 40,
      entry_apy: 20,
      entry_price_sol: null,
      opened_at: new Date().toISOString(),
      closed_at: null,
      close_reason: null,
      notes: null,
    });

    const result = await validateNewPosition(30, config, db, 'meteora_dlmm', 'BONK-USDC', 'pool-new', 'bonk-mint');
    expect(result.success).toBe(false);
    expect(result.error).toContain('duplicate token exposure');
  });

  it('aggregates protocol-book stats from graded decision episodes', async () => {
    const db = createDb();

    await db.insertDecisionEpisode({
      decision_at: new Date().toISOString(),
      action: 'open',
      book: 'core',
      signal_types: 'CLI_OPEN',
      market_regime: null,
      sol_price_usd: 150,
      portfolio_size_usd: 500,
      active_position_count: 1,
      target_pool_id: 'pool-1',
      target_protocol: 'jito',
      target_pool_name: 'JitoSOL',
      position_size_usd: 50,
      position_id: 'position-1',
      reasoning: 'core win',
      source: 'paper',
      outcome_resolved_at: new Date().toISOString(),
      outcome_net_pnl_usd: 1,
      outcome_realized_apy_pct: 8,
      outcome_days_held: 3,
      outcome_exit_reason: 'manual',
      outcome_exit_regime: null,
      outcome_exit_sol_price: 150,
      grade: 'GOOD',
      lesson_learned: 'good',
    });

    await db.insertDecisionEpisode({
      decision_at: new Date().toISOString(),
      action: 'open',
      book: 'core',
      signal_types: 'CLI_OPEN',
      market_regime: null,
      sol_price_usd: 150,
      portfolio_size_usd: 500,
      active_position_count: 1,
      target_pool_id: 'pool-2',
      target_protocol: 'jito',
      target_pool_name: 'JitoSOL 2',
      position_size_usd: 50,
      position_id: 'position-2',
      reasoning: 'core loss',
      source: 'paper',
      outcome_resolved_at: new Date().toISOString(),
      outcome_net_pnl_usd: -0.5,
      outcome_realized_apy_pct: 4,
      outcome_days_held: 2,
      outcome_exit_reason: 'manual',
      outcome_exit_regime: null,
      outcome_exit_sol_price: 150,
      grade: 'BAD',
      lesson_learned: 'bad',
    });

    const stats = await db.getProtocolBookStats(['jito']);
    expect(stats.get('jito')?.core?.count).toBe(2);
    expect(stats.get('jito')?.core?.winRate).toBeCloseTo(50, 6);
    expect(stats.get('jito')?.core?.avgPnl).toBeCloseTo(0.25, 6);
    await db.close();
  });

  it('aggregates base-mint book stats from graded decision episodes', async () => {
    const db = createDb();

    const opportunity = await db.insertOpportunity({
      protocol: 'meteora_dlmm',
      pool_id: 'pool-1',
      pool_name: 'SOL-USDC',
      apy_defillama: null,
      apy_protocol: 10,
      apy_used: 10,
      data_uncertain: 0,
      tvl_usd: 1_000_000,
      score: 70,
      raw_data: JSON.stringify({ baseMint: 'So111' }),
    });
    const position = await db.insertPosition({
      opportunity_id: opportunity.id,
      protocol: opportunity.protocol,
      pool_id: opportunity.pool_id,
      pool_name: opportunity.pool_name,
      state: 'ACTIVE',
      book: 'core',
      base_mint: 'So111',
      size_usd: 50,
      entry_apy: 10,
      entry_price_sol: null,
      opened_at: new Date().toISOString(),
      closed_at: null,
      close_reason: null,
      notes: null,
    });

    await db.insertDecisionEpisode({
      decision_at: new Date().toISOString(),
      action: 'open',
      book: 'core',
      signal_types: 'CLI_OPEN',
      market_regime: null,
      sol_price_usd: 150,
      portfolio_size_usd: 500,
      active_position_count: 1,
      target_pool_id: 'pool-1',
      target_protocol: 'meteora_dlmm',
      target_pool_name: 'SOL-USDC',
      position_size_usd: 50,
      position_id: position.id,
      reasoning: 'mint win',
      source: 'paper',
      outcome_resolved_at: new Date().toISOString(),
      outcome_net_pnl_usd: 2,
      outcome_realized_apy_pct: 10,
      outcome_days_held: 2,
      outcome_exit_reason: 'manual',
      outcome_exit_regime: null,
      outcome_exit_sol_price: 150,
      grade: 'GOOD',
      lesson_learned: 'good',
    });

    const stats = await db.getBaseMintBookStats(['So111']);
    expect(stats.get('So111')?.core?.count).toBe(1);
    expect(stats.get('So111')?.core?.winRate).toBe(100);
    expect(stats.get('So111')?.core?.avgPnl).toBe(2);
    await db.close();
  });

  it('persists DLMM trailing state updates', async () => {
    const db = createDb();
    const opportunity = await db.insertOpportunity({
      protocol: 'meteora_dlmm',
      pool_id: 'pool-1',
      pool_name: 'SOL-USDC',
      apy_defillama: null,
      apy_protocol: 12,
      apy_used: 12,
      data_uncertain: 0,
      tvl_usd: 1_000_000,
      score: 70,
      raw_data: null,
    });
    const position = await db.insertPosition({
      opportunity_id: opportunity.id,
      protocol: opportunity.protocol,
      pool_id: opportunity.pool_id,
      pool_name: opportunity.pool_name,
      state: 'ACTIVE',
      book: 'core',
      base_mint: 'So111',
      size_usd: 50,
      entry_apy: 12,
      entry_price_sol: null,
      opened_at: new Date().toISOString(),
      closed_at: null,
      close_reason: null,
      notes: null,
    });
    await db.insertDlmmPosition({
      position_id: position.id,
      position_pubkey: 'pos-pubkey',
      pool_pubkey: 'pool-pubkey',
      lower_bin_id: 1,
      upper_bin_id: 10,
      active_bin_at_deploy: 5,
      strategy: 'Spot',
      bins_below: 2,
      bins_above: 2,
      amount_x_deployed: 10,
      amount_y_deployed: 10,
      initial_value_usd: 50,
      bin_step: 5,
      volatility_at_deploy: 1,
      fee_tvl_ratio_at_deploy: 10,
      organic_score_at_deploy: 80,
      base_mint: 'So111',
      deployed_at: new Date().toISOString(),
    });

    await db.updateDlmmTrailingState(position.id, {
      peak_pnl_pct: 8,
      last_pnl_pct: 6,
      trailing_armed_at: '2026-01-01T00:00:00.000Z',
      last_monitored_at: '2026-01-01T00:05:00.000Z',
    });

    const dlmm = await db.getDlmmPosition(position.id);
    expect(dlmm?.peak_pnl_pct).toBe(8);
    expect(dlmm?.last_pnl_pct).toBe(6);
    expect(dlmm?.trailing_armed_at).toBe('2026-01-01T00:00:00.000Z');
    expect(dlmm?.last_monitored_at).toBe('2026-01-01T00:05:00.000Z');
    await db.close();
  });
});
