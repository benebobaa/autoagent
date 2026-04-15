export interface ProtocolBookStats {
  protocol: string;
  book: 'core' | 'scout';
  count: number;
  avgPnl: number;
  winRate: number;
}

export type ProtocolBookStatsMap = Map<string, Partial<Record<'core' | 'scout', ProtocolBookStats>>>;

export interface BaseMintBookStats {
  baseMint: string;
  book: 'core' | 'scout';
  count: number;
  avgPnl: number;
  winRate: number;
}

export type BaseMintBookStatsMap = Map<string, Partial<Record<'core' | 'scout', BaseMintBookStats>>>;

export interface AllocatorHistoryConfig {
  history_enabled: boolean;
  core_history_min_samples: number;
  core_history_min_win_rate_pct: number;
  core_history_min_avg_pnl_usd: number;
  scout_history_min_samples: number;
  scout_bad_win_rate_pct: number;
  scout_bad_avg_pnl_usd: number;
}

export interface HistoryPolicyResult {
  allowed: boolean;
  rankAdjustment: number;
  reason: string | null;
}

interface EvaluateHistoryPolicyParams {
  subject: string;
  book: 'core' | 'scout';
  allocator: AllocatorHistoryConfig;
  statsByBook: Map<string, Partial<Record<'core' | 'scout', { count: number; avgPnl: number; winRate: number }>>>;
  label: string;
  strongRankAdjustment?: number;
  passingRankAdjustment?: number;
  constructiveScoutRankAdjustment?: number;
  weakScoutRankAdjustment?: number;
}

export function evaluateHistoryPolicy({
  subject,
  book,
  allocator,
  statsByBook,
  label,
  strongRankAdjustment = 6,
  passingRankAdjustment = 2,
  constructiveScoutRankAdjustment = 3,
  weakScoutRankAdjustment = -4,
}: EvaluateHistoryPolicyParams): HistoryPolicyResult {
  if (!allocator.history_enabled) {
    return { allowed: true, rankAdjustment: 0, reason: null };
  }

  const stats = statsByBook.get(subject)?.[book] ?? null;
  if (stats === null) {
    return { allowed: true, rankAdjustment: 0, reason: `${label} history cold start` };
  }

  if (book === 'core') {
    if (stats.count < allocator.core_history_min_samples) {
      return { allowed: true, rankAdjustment: 0, reason: `${label} history warming up (${stats.count} samples)` };
    }

    if (
      stats.winRate < allocator.core_history_min_win_rate_pct ||
      stats.avgPnl < allocator.core_history_min_avg_pnl_usd
    ) {
      return {
        allowed: false,
        rankAdjustment: -1000,
        reason: `blocked by core ${label} history (${stats.count} samples, ${stats.winRate.toFixed(0)}% wins, avg PnL $${stats.avgPnl.toFixed(2)})`,
      };
    }

    if (stats.winRate >= 65 && stats.avgPnl > 0) {
      return {
        allowed: true,
        rankAdjustment: strongRankAdjustment,
        reason: `strong core ${label} history (${stats.count} samples, ${stats.winRate.toFixed(0)}% wins, avg PnL $${stats.avgPnl.toFixed(2)})`,
      };
    }

    return {
      allowed: true,
      rankAdjustment: passingRankAdjustment,
      reason: `passing core ${label} history (${stats.count} samples, ${stats.winRate.toFixed(0)}% wins, avg PnL $${stats.avgPnl.toFixed(2)})`,
    };
  }

  if (stats.count < allocator.scout_history_min_samples) {
    return { allowed: true, rankAdjustment: 0, reason: `${label} history warming up (${stats.count} samples)` };
  }

  if (
    stats.winRate <= allocator.scout_bad_win_rate_pct &&
    stats.avgPnl <= allocator.scout_bad_avg_pnl_usd
  ) {
      return {
        allowed: false,
        rankAdjustment: -1000,
        reason: `blocked by scout ${label} history (${stats.count} samples, ${stats.winRate.toFixed(0)}% wins, avg PnL $${stats.avgPnl.toFixed(2)})`,
      };
    }

  if (stats.winRate >= 55 && stats.avgPnl > 0) {
    return {
      allowed: true,
      rankAdjustment: constructiveScoutRankAdjustment,
      reason: `constructive scout ${label} history (${stats.count} samples, ${stats.winRate.toFixed(0)}% wins, avg PnL $${stats.avgPnl.toFixed(2)})`,
    };
  }

  if (stats.winRate < 40 || stats.avgPnl < 0) {
    return {
      allowed: true,
      rankAdjustment: weakScoutRankAdjustment,
      reason: `weak scout ${label} history (${stats.count} samples, ${stats.winRate.toFixed(0)}% wins, avg PnL $${stats.avgPnl.toFixed(2)})`,
    };
  }

  return {
    allowed: true,
    rankAdjustment: 0,
    reason: `mixed scout ${label} history (${stats.count} samples, ${stats.winRate.toFixed(0)}% wins, avg PnL $${stats.avgPnl.toFixed(2)})`,
  };
}

export function evaluateProtocolHistoryPolicy(
  protocol: string,
  book: 'core' | 'scout',
  allocator: AllocatorHistoryConfig,
  statsByProtocolBook: ProtocolBookStatsMap,
): HistoryPolicyResult {
  return evaluateHistoryPolicy({
    subject: protocol,
    book,
    allocator,
    statsByBook: statsByProtocolBook,
    label: 'protocol',
  });
}

export function evaluateBaseMintHistoryPolicy(
  baseMint: string,
  book: 'core' | 'scout',
  allocator: AllocatorHistoryConfig,
  statsByBaseMintBook: BaseMintBookStatsMap,
): HistoryPolicyResult {
  return evaluateHistoryPolicy({
    subject: baseMint,
    book,
    allocator,
    statsByBook: statsByBaseMintBook,
    label: 'token',
    strongRankAdjustment: 4,
    passingRankAdjustment: 1,
    constructiveScoutRankAdjustment: 2,
    weakScoutRankAdjustment: -2,
  });
}
