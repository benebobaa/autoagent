import { z } from 'zod';
import { DEFAULT_TIER_CONFIGS, type RiskTierNumber, RiskTierNumberSchema, type TierConfig, TierConfigSchema } from './risk-tiers.js';

const TierOverrideSchema = z.record(z.unknown());

export const PortfolioConfigSchema = z.object({
  total_capital_usd: z.number().positive(),
  active_tiers: z.array(RiskTierNumberSchema).min(1),
  tier_overrides: z.record(TierOverrideSchema).default({}),
  global_max_drawdown_pct: z.number().positive().default(0.1),
  global_min_conservative_pct: z.number().min(0).max(1).default(0.4),
  rebalance_interval_hours: z.number().positive().default(168.0),
  event_driven_rebalance: z.boolean().default(true),
  volatility_spike_shift_pct: z.number().min(0).max(1).default(0.1),
  volatility_spike_threshold_pct: z.number().positive().default(0.12),
  high_conviction_boost_pct: z.number().min(0).max(1).default(0.05),
  max_aggressive_pct: z.number().min(0).max(1).default(0.35),
});

export type PortfolioConfigData = z.infer<typeof PortfolioConfigSchema>;
type PortfolioConfigInput = z.input<typeof PortfolioConfigSchema>;

type TierOverrideMap = Partial<Record<RiskTierNumber, Partial<TierConfig>>>;

function parseTierList(value: string | undefined): RiskTierNumber[] | null {
  if (!value || value.trim().length === 0) {
    return null;
  }

  const tiers = value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((tier) => Number.isFinite(tier));
  const parsed = z.array(RiskTierNumberSchema).safeParse(tiers);
  return parsed.success ? parsed.data : null;
}

function envAllocationOverride(tier: RiskTierNumber): number | null {
  const value = process.env[`TIER_${tier}_ALLOCATION`];
  if (!value) {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export class PortfolioConfig {
  public readonly total_capital_usd: number;
  public readonly active_tiers: RiskTierNumber[];
  public readonly tier_overrides: TierOverrideMap;
  public readonly global_max_drawdown_pct: number;
  public readonly global_min_conservative_pct: number;
  public readonly rebalance_interval_hours: number;
  public readonly event_driven_rebalance: boolean;
  public readonly volatility_spike_shift_pct: number;
  public readonly volatility_spike_threshold_pct: number;
  public readonly high_conviction_boost_pct: number;
  public readonly max_aggressive_pct: number;

  constructor(data: PortfolioConfigInput) {
    const parsed = PortfolioConfigSchema.parse(data);
    this.total_capital_usd = parsed.total_capital_usd;
    this.active_tiers = parsed.active_tiers;
    this.tier_overrides = Object.fromEntries(
      Object.entries(parsed.tier_overrides).map(([tier, override]) => [Number(tier), override as Partial<TierConfig>])
    ) as TierOverrideMap;
    this.global_max_drawdown_pct = parsed.global_max_drawdown_pct;
    this.global_min_conservative_pct = parsed.global_min_conservative_pct;
    this.rebalance_interval_hours = parsed.rebalance_interval_hours;
    this.event_driven_rebalance = parsed.event_driven_rebalance;
    this.volatility_spike_shift_pct = parsed.volatility_spike_shift_pct;
    this.volatility_spike_threshold_pct = parsed.volatility_spike_threshold_pct;
    this.high_conviction_boost_pct = parsed.high_conviction_boost_pct;
    this.max_aggressive_pct = parsed.max_aggressive_pct;
  }

  getTierConfig(tier: RiskTierNumber): TierConfig {
    const base = DEFAULT_TIER_CONFIGS[tier];
    const overrides = this.tier_overrides[tier];
    return TierConfigSchema.parse({
      ...base,
      ...(overrides ?? {}),
    });
  }

  getTierCapitalUsd(tier: RiskTierNumber): number {
    return this.total_capital_usd * this.getTierConfig(tier).capital_allocation_pct;
  }

  validateAllocations(): true {
    const total = this.active_tiers.reduce((sum, tier) => sum + this.getTierConfig(tier).capital_allocation_pct, 0);
    const conservative = this.active_tiers
      .filter((tier) => tier <= 3)
      .reduce((sum, tier) => sum + this.getTierConfig(tier).capital_allocation_pct, 0);
    const aggressive = this.active_tiers
      .filter((tier) => tier >= 7)
      .reduce((sum, tier) => sum + this.getTierConfig(tier).capital_allocation_pct, 0);

    if (Math.abs(total - 1.0) >= 0.01) {
      throw new Error(`Tier allocations must sum to 1.0, got ${total.toFixed(3)}`);
    }
    if (conservative < this.global_min_conservative_pct) {
      throw new Error(
        `Conservative allocation ${(conservative * 100).toFixed(1)}% below floor ${(this.global_min_conservative_pct * 100).toFixed(1)}%`
      );
    }
    if (aggressive > this.max_aggressive_pct) {
      throw new Error(
        `Aggressive allocation ${(aggressive * 100).toFixed(1)}% exceeds cap ${(this.max_aggressive_pct * 100).toFixed(1)}%`
      );
    }
    return true;
  }
}

export const PAPER_PORTFOLIO = new PortfolioConfig({
  total_capital_usd: 500,
  active_tiers: [2, 5, 8],
  tier_overrides: {
    2: { capital_allocation_pct: 0.5 },
    5: { capital_allocation_pct: 0.3 },
    8: { capital_allocation_pct: 0.2 },
  },
});

export const PRODUCTION_PORTFOLIO = new PortfolioConfig({
  total_capital_usd: Number(process.env['TOTAL_CAPITAL_USD'] ?? '500'),
  active_tiers: [2, 5, 8],
  tier_overrides: {
    2: { capital_allocation_pct: 0.5 },
    5: { capital_allocation_pct: 0.3 },
    8: { capital_allocation_pct: 0.2 },
  },
});

function withEnvOverrides(base: PortfolioConfig): PortfolioConfig {
  const envActiveTiers = parseTierList(process.env['ACTIVE_TIERS']);
  const activeTiers = envActiveTiers ?? base.active_tiers;
  const tierOverrides: TierOverrideMap = { ...base.tier_overrides };

  for (const tier of activeTiers) {
    const allocation = envAllocationOverride(tier);
    if (allocation !== null) {
      tierOverrides[tier] = {
        ...(tierOverrides[tier] ?? {}),
        capital_allocation_pct: allocation,
      };
    }
  }

  return new PortfolioConfig({
    total_capital_usd: Number(process.env['TOTAL_CAPITAL_USD'] ?? base.total_capital_usd),
    active_tiers: activeTiers,
    tier_overrides: tierOverrides as Record<string, Record<string, unknown>>,
    global_max_drawdown_pct: Number(process.env['GLOBAL_MAX_DRAWDOWN_PCT'] ?? base.global_max_drawdown_pct),
    global_min_conservative_pct: base.global_min_conservative_pct,
    rebalance_interval_hours: base.rebalance_interval_hours,
    event_driven_rebalance: base.event_driven_rebalance,
    volatility_spike_shift_pct: base.volatility_spike_shift_pct,
    volatility_spike_threshold_pct: base.volatility_spike_threshold_pct,
    high_conviction_boost_pct: base.high_conviction_boost_pct,
    max_aggressive_pct: Number(process.env['MAX_AGGRESSIVE_TIER_PCT'] ?? base.max_aggressive_pct),
  });
}

let cachedPortfolio: PortfolioConfig | null = null;

export function getActivePortfolio(): PortfolioConfig {
  if (cachedPortfolio) {
    return cachedPortfolio;
  }

  const paperMode = (process.env['PAPER_TRADING'] ?? 'true').toLowerCase() === 'true';
  const base = paperMode ? PAPER_PORTFOLIO : PRODUCTION_PORTFOLIO;
  const resolved = withEnvOverrides(base);
  resolved.validateAllocations();
  cachedPortfolio = resolved;
  return resolved;
}

export function resetActivePortfolio(): void {
  cachedPortfolio = null;
}
