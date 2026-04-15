import { readFileSync } from 'fs';
import { load as yamlLoad } from 'js-yaml';
import { z } from 'zod';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import 'dotenv/config';
import { RiskTierNumberSchema } from './risk-tiers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../');

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ProtocolConfigSchema = z.object({
  trust_score: z.number().min(0).max(100),
  enabled: z.boolean(),
});

const ScoringConfigSchema = z.object({
  min_apy_pct: z.number().default(5.0),
  min_tvl_usd: z.number().default(500_000),
  min_score_to_suggest: z.number().default(60),
  min_score_to_watch: z.number().default(45),
  data_uncertainty_threshold_pct: z.number().default(15),
});

const PositionConfigSchema = z.object({
  max_position_usd: z.number().default(100),
  max_open_positions: z.number().default(3),
  min_position_usd: z.number().default(20),
  max_group_concentration_pct: z.number().default(50),
});

const AllocatorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  live_enabled: z.boolean().default(false),
  live_scout_enabled: z.boolean().default(false),
  live_gas_reserve_sol: z.number().default(0.1),
  history_enabled: z.boolean().default(true),
  core_history_min_samples: z.number().default(3),
  core_history_min_win_rate_pct: z.number().default(40),
  core_history_min_avg_pnl_usd: z.number().default(0),
  scout_history_min_samples: z.number().default(4),
  scout_bad_win_rate_pct: z.number().default(20),
  scout_bad_avg_pnl_usd: z.number().default(-1),
  target_utilization_pct: z.number().default(60),
  scout_enabled_paper: z.boolean().default(true),
  scout_min_score: z.number().default(45),
  scout_max_positions: z.number().default(2),
  scout_position_usd: z.number().default(30),
  cooldown_hours_after_bad_exit: z.number().default(12),
});

const RiskConfigSchema = z.object({
  circuit_breaker_drawdown_pct: z.number().default(4.0),
  max_gas_usd: z.number().default(0.50),
});

const RebalanceConfigSchema = z.object({
  apy_drop_trigger_pct: z.number().default(30),
  check_interval_hours: z.number().default(1),
});

const ReportingConfigSchema = z.object({
  daily_report_cron: z.string().default('0 7 * * *'),
  scan_cron: z.string().default('0 6 * * *'),
  monitor_cron: z.string().default('0 * * * *'),
});

// Discovery mode config — aggressive pool scanning
const MeteoraDiscoveryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Timeframe for pool metrics (5m | 15m | 30m | 1h | 4h | 24h). 5m finds hot pools fastest. */
  timeframe: z.string().default('5m'),
  /** Market cap range for base token */
  min_mcap: z.number().default(150_000),
  max_mcap: z.number().default(10_000_000),
  /** Minimum unique token holders */
  min_holders: z.number().default(500),
  /** TVL sweet spot — where fee/TVL ratios are highest */
  min_tvl: z.number().default(10_000),
  max_tvl: z.number().default(150_000),
  /** Minimum trading volume in the timeframe window */
  min_volume: z.number().default(500),
  /** Bin step bounds — outside this range, no curve strategy → skip */
  min_bin_step: z.number().default(80),
  max_bin_step: z.number().default(125),
  /** Fee / active TVL ratio in the timeframe window (as %). 0.05 = 0.05% */
  min_fee_tvl_ratio: z.number().default(0.05),
  /** Jupiter organic score — measures real vs bot activity (0-100) */
  min_organic_score: z.number().default(60),
  /** Global priority + jito fees paid by traders, in SOL. <30 = likely scam */
  min_global_fees_sol: z.number().default(30),
  /** Hard skip if top-10 holders hold more than this % */
  max_top10_holder_pct: z.number().default(60),
  /** Hard skip if bundler wallets hold more than this % */
  max_bundler_pct: z.number().default(30),
  /** Base token mint addresses to permanently skip */
  blacklisted_tokens: z.array(z.string()).default([]),
  /** Launchpad names to skip (pump.fun etc.) */
  blacklisted_launchpads: z.array(z.string()).default(['pump.fun', 'letsbonk.fun']),
}).default({});

// Position management config — hard close rules
const MeteoraManagementConfigSchema = z.object({
  /** Minutes OOR before closing the position */
  out_of_range_wait_minutes: z.number().default(30),
  /** Active bin must exceed upper_bin by this many bins before forced close (pumped) */
  out_of_range_bins_to_close: z.number().default(10),
  /** PnL% threshold below which the position is force-closed (stop loss) */
  stop_loss_pct: z.number().default(-50),
  /** PnL% threshold above which the position is closed and profit taken */
  take_profit_pct: z.number().default(5),
  /** Replace fixed take-profit with a trailing exit once profit is high enough */
  trailing_take_profit_enabled: z.boolean().default(true),
  /** PnL% level that arms the trailing take-profit */
  trail_arm_profit_pct: z.number().default(5),
  /** Close once PnL retraces this much from the peak after trailing is armed */
  trail_drawdown_pct: z.number().default(2),
  /** Minimum fee/TVL ratio in 24h window; close if below this AND age >= 60 min */
  min_fee_per_tvl_24h: z.number().default(7),
  /** Minimum unclaimed fees (USD) to trigger a claim signal */
  min_claim_amount_usd: z.number().default(5),
  /** Automatically swap base token to SOL via Jupiter after close */
  auto_swap_after_close: z.boolean().default(true),
  /** How often to run the monitor loop, in minutes */
  management_interval_minutes: z.number().default(10),
}).default({});

const MeteoraConfigSchema = z.object({
  enabled: z.boolean().default(true),
  min_tvl_usd: z.number().default(500000),
  min_fee_apr: z.number().default(0.20),
  max_il_tolerance: z.number().default(0.05),
  better_opportunity_delta: z.number().default(0.10),
  max_position_size_usd: z.number().default(10000),
  bin_step_rules: z.object({
    stablecoin_pairs: z.object({ max_bin_step: z.number().default(10) }),
    bluechip_pairs: z.object({ max_bin_step: z.number().default(50) }),
    volatile_pairs: z.object({ max_bin_step: z.number().default(150) }),
  }).default({
    stablecoin_pairs: { max_bin_step: 10 },
    bluechip_pairs: { max_bin_step: 50 },
    volatile_pairs: { max_bin_step: 150 },
  }),
  out_of_range_alert_polls: z.number().default(4),
  active_bin_liquidity_min_pct: z.number().default(0.15),
  fee_apr_collapse_threshold: z.number().default(0.60),
  volume_spike_multiplier: z.number().default(3.0),
  preferred_strategy: z.enum(['Spot', 'Curve', 'BidAsk']).default('Spot'),
  allowed_pairs: z.array(z.string()).default(['SOL-USDC', 'SOL-USDT', 'JitoSOL-SOL', 'mSOL-SOL']),
  /** Discovery mode — enable to scan 50k+ pools aggressively */
  discovery: MeteoraDiscoveryConfigSchema,
  /** Position management — hard close rules, fee claiming, auto-swap */
  management: MeteoraManagementConfigSchema,
});

// Signal detection thresholds
const SignalsConfigSchema = z.object({
  tvl_collapse_pct: z.number().default(0.30),        // CRITICAL: TVL drops >30%
  portfolio_drawdown_pct: z.number().default(4.0),   // CRITICAL: portfolio down >4% (uses risk.circuit_breaker_drawdown_pct)
  il_max_tolerance_pct: z.number().default(5.0),     // CRITICAL: IL > 5% on LP positions
  apy_drift_pct: z.number().default(0.25),           // HIGH: APY drops >25% from entry
  better_pool_delta_pp: z.number().default(2.0),     // HIGH: better pool APY > current + 2pp
  liquidity_crunch_pct: z.number().default(0.40),    // HIGH: TVL drops >40%
  regime_shift_pct: z.number().default(0.08),        // HIGH: SOL price moves >8%
  high_yield_apy_threshold_pct: z.number().default(10.0), // LOW: new pool APY > 10%
  position_aging_days: z.number().default(14),       // LOW: position held > 14 days
});

// LLM config per-provider
const LLMProviderConfigSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'deepseek', 'openrouter']).default('anthropic'),
  model: z.string().default('claude-sonnet-4-20250514'),
  temperature: z.number().default(0),
  apiKey: z.string().optional(), // injected from env, not stored in YAML
  baseUrl: z.string().url().optional(),
  siteUrl: z.string().url().optional(),
  siteName: z.string().optional(),
});

const LLMConfigSchema = z.object({
  default: LLMProviderConfigSchema.default({}),
  overrides: z.record(LLMProviderConfigSchema).default({}), // keyed by agent name
});

// Polling & dispatch intervals
const PollingConfigSchema = z.object({
  data_poll_interval_sec: z.number().default(300),    // Tier 1: every 5 min
  signal_detect_interval_sec: z.number().default(900), // Tier 2: every 15 min
});

const DispatchConfigSchema = z.object({
  critical_delay_sec: z.number().default(0),
  high_batch_interval_sec: z.number().default(3600),
  low_batch_interval_sec: z.number().default(86400),
});

// Paper trading config
const PaperTradingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  starting_balance_usd: z.number().default(100),
});

// RAG / vector store config
const RagConfigSchema = z.object({
  embedding_provider: z.literal('openai').default('openai'),
  embedding_model: z.string().default('text-embedding-3-small'),
});

// Regime detection config
const RegimeConfigSchema = z.object({
  bull_threshold_pct: z.number().default(15),
  bear_threshold_pct: z.number().default(-15),
  high_vol_atr_ratio: z.number().default(0.03),
  low_vol_atr_ratio: z.number().default(0.015),
  capitulation_drop_pct: z.number().default(25),
  euphoria_rise_pct: z.number().default(40),
});

// Swap config
const SwapConfigSchema = z.object({
  enabled: z.boolean().default(true),
  hitl_threshold_usd: z.number().default(100),
  default_slippage_bps: z.number().default(50),
});

const RiskTiersRuntimeConfigSchema = z.object({
  active_tiers: z.array(RiskTierNumberSchema).default([2, 5, 8]),
  enable_meme_discovery: z.boolean().default(false),
  discovery_scan_interval_min: z.number().default(20),
  paper_approval_tiers: z.array(RiskTierNumberSchema).default([8, 9]),
});

const AgentConfigFileSchema = z.object({
  protocols: z.object({
    kamino_lending: ProtocolConfigSchema,
    kamino_vaults: ProtocolConfigSchema,
    marginfi: ProtocolConfigSchema,
    jito: ProtocolConfigSchema,
    meteora_dlmm: ProtocolConfigSchema,
  }),
  scoring: ScoringConfigSchema,
  position: PositionConfigSchema,
  allocator: AllocatorConfigSchema.default({}),
  risk: RiskConfigSchema,
  rebalance: RebalanceConfigSchema,
  reporting: ReportingConfigSchema,
  signals: SignalsConfigSchema.default({}),
  regime: RegimeConfigSchema.default({}),
  llm: LLMConfigSchema.default({}),
  polling: PollingConfigSchema.default({}),
  dispatch: DispatchConfigSchema.default({}),
  rag: RagConfigSchema.default({}),
  meteora: MeteoraConfigSchema.default({}),
  paper_trading: PaperTradingConfigSchema.default({}),
  swap: SwapConfigSchema.default({}),
  risk_tiers: RiskTiersRuntimeConfigSchema.default({}),
});

// Merged config shape exposed to the rest of the codebase
const AgentConfigSchema = AgentConfigFileSchema.extend({
  rpcUrl: z.string().url(),
  agentWalletAddress: z.string().optional(),
  telegramBotToken: z.string().optional(),
  telegramChatId: z.string().optional(),
  defillamaBaseUrl: z.string().url().default('https://yields.llama.fi'),
  kaminoApiBaseUrl: z.string().url().default('https://api.kamino.finance'),
  meteoraApiBaseUrl: z.string().url().default('https://dlmm.datapi.meteora.ag'),
  marginfiEnv: z.enum(['production', 'staging']).default('production'),
  dryRun: z.boolean().default(true),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  openaiApiKey: z.string().optional(),
  embeddingApiKey: z.string().optional(),
  databaseUrl: z.string().min(1),
  paperTrading: z.boolean().default(false),
  paperStartingBalanceUsd: z.number().default(100),
  birdeyeApiKey: z.string().default(''),
  totalCapitalUsd: z.number().positive().default(500),
  enableMemeDiscovery: z.boolean().default(false),
  discoveryScanIntervalMin: z.number().int().positive().default(20),
  monitorCheckIntervalSec: z.number().int().positive().default(60),
  monitorCheckIntervalActiveSec: z.number().int().positive().default(180),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

let _config: AgentConfig | null = null;

export function loadConfig(configPath?: string): AgentConfig {
  if (_config) return _config;

  const yamlPath = configPath ?? resolve(ROOT, 'agent_config.yaml');
  const raw = readFileSync(yamlPath, 'utf-8');
  const parsed = yamlLoad(raw);

  const getApiKey = (provider: string) => {
    switch (provider) {
      case 'anthropic': return process.env['ANTHROPIC_API_KEY'];
      case 'openai': return process.env['OPENAI_API_KEY'];
      case 'deepseek': return process.env['DEEPSEEK_API_KEY'];
      case 'openrouter': return process.env['OPENROUTER_API_KEY'];
      default: return undefined;
    }
  };

  const getProviderRuntimeFields = (provider: string, config: Record<string, unknown> | undefined) => {
    if (provider !== 'openrouter') {
      return {};
    }

    return {
      baseUrl: process.env['OPENROUTER_BASE_URL'] ?? config?.['baseUrl'],
      siteUrl: process.env['OPENROUTER_SITE_URL'] ?? config?.['siteUrl'],
      siteName: process.env['OPENROUTER_SITE_NAME'] ?? config?.['siteName'],
    };
  };

  const parsedObj = parsed as Record<string, any>;
  const llmConfig = (parsedObj['llm'] || {}) as Record<string, any>;
  
  // Inject API keys into default and overrides based on their provider
  const defaultProvider = llmConfig['default']?.['provider'] || 'anthropic';
  const defaultWithKey = {
    ...(llmConfig['default'] || {}),
    apiKey: getApiKey(defaultProvider),
    ...getProviderRuntimeFields(defaultProvider, llmConfig['default'] as Record<string, unknown> | undefined),
  };

  const overridesWithKeys: Record<string, any> = {};
  if (llmConfig['overrides']) {
    for (const [agent, config] of Object.entries(llmConfig['overrides'] as Record<string, any>)) {
      overridesWithKeys[agent] = {
        ...(config || {}),
        apiKey: getApiKey(config['provider'] || defaultProvider),
        ...getProviderRuntimeFields(config['provider'] || defaultProvider, config as Record<string, unknown>),
      };
    }
  }

  const merged = {
    ...parsedObj,
    rpcUrl: process.env['SOLANA_RPC_URL'],
    agentWalletAddress: process.env['AGENT_WALLET_ADDRESS'],
    telegramBotToken: process.env['TELEGRAM_BOT_TOKEN'],
    telegramChatId: process.env['TELEGRAM_CHAT_ID'],
    defillamaBaseUrl: process.env['DEFILLAMA_BASE_URL'] ?? 'https://yields.llama.fi',
    kaminoApiBaseUrl: process.env['KAMINO_API_BASE_URL'] ?? 'https://api.kamino.finance',
    meteoraApiBaseUrl: process.env['METEORA_API_BASE_URL'] ?? 'https://dlmm.datapi.meteora.ag',
    marginfiEnv: process.env['MARGINFI_ENV'] ?? 'production',
    dryRun: process.env['DRY_RUN'] === 'true' || process.env['PAPER_TRADING'] === 'true',
    logLevel: process.env['LOG_LEVEL'] || 'info',
    openaiApiKey: process.env['OPENAI_API_KEY'],
    embeddingApiKey: process.env['EMBEDDING_API_KEY'],
    databaseUrl: process.env['DATABASE_URL'],
    paperTrading: process.env['PAPER_TRADING'] === 'true' || (parsedObj['paper_trading'] as Record<string, unknown>)?.['enabled'] === true,
    paperStartingBalanceUsd: Number(process.env['PAPER_STARTING_BALANCE_USD'] ?? (parsedObj['paper_trading'] as Record<string, unknown>)?.['starting_balance_usd'] ?? 100),
    birdeyeApiKey: process.env['BIRDEYE_API_KEY'] ?? '',
    totalCapitalUsd: Number(process.env['TOTAL_CAPITAL_USD'] ?? '500'),
    enableMemeDiscovery:
      process.env['ENABLE_MEME_DISCOVERY'] === 'true' ||
      (parsedObj['risk_tiers'] as Record<string, unknown> | undefined)?.['enable_meme_discovery'] === true,
    discoveryScanIntervalMin: Number(
      process.env['DISCOVERY_SCAN_INTERVAL_MIN'] ??
        (parsedObj['risk_tiers'] as Record<string, unknown> | undefined)?.['discovery_scan_interval_min'] ??
        20,
    ),
    monitorCheckIntervalSec: Number(process.env['MONITOR_CHECK_INTERVAL'] ?? '60'),
    monitorCheckIntervalActiveSec: Number(process.env['MONITOR_CHECK_INTERVAL_ACTIVE'] ?? '180'),
    llm: {
      ...llmConfig,
      default: defaultWithKey,
      overrides: overridesWithKeys,
    },
  };

  _config = AgentConfigSchema.parse(merged);
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
