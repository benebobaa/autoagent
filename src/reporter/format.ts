import type { ScoredOpportunity } from '../scoring/engine.js';
import type { Position } from '../positions/db.js';
import type { CashFlowPnl, MtmPnl } from '../positions/pnl.js';
import type { PortfolioConfig } from '../config/portfolio-config.js';

// ---------------------------------------------------------------------------
// Telegram-safe HTML formatting helpers
// ---------------------------------------------------------------------------

function esc(s: string | number): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${fmt(n / 1_000_000)}M`;
  if (Math.abs(n) >= 1_000) return `$${fmt(n / 1_000)}k`;
  return `$${fmt(n)}`;
}

// ---------------------------------------------------------------------------
// Daily report template (Telegram HTML mode)
// ---------------------------------------------------------------------------

export interface PaperPortfolioSummary {
  startingBalanceUsd: number;
  cashUsd: number;
  deployedUsd: number;
  totalYieldUsd: number;
  totalValueUsd: number;
  totalReturnPct: number;
  openPositions: number;
}

export interface BookSummary {
  book: 'core' | 'scout' | 'unassigned';
  openPositions: number;
  deployedUsd: number;
  cashFlowPnlUsd: number;
  mtmPnlUsd: number;
}

export interface ReportData {
  openPositions: Position[];
  cashFlowPnls: CashFlowPnl[];
  mtmPnls: MtmPnl[];
  suggestions: ScoredOpportunity[];
  uncertainOpportunities: ScoredOpportunity[];
  pendingRebalance: Position[];
  circuitBreakerActive: boolean;
  deployedCapitalUsd: number;
  walletBalanceUsd: number;
  bookSummaries?: BookSummary[];
  paperPortfolio?: PaperPortfolioSummary;
}

export function formatDailyReport(data: ReportData): string {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0] ?? now.toISOString();
  const timeStr = now.toUTCString().split(' ')[4] ?? '00:00:00' + ' UTC';

  const totalCashFlow = data.cashFlowPnls.reduce((s, p) => s + p.cashFlowPnlUsd, 0);
  const totalMtm = data.mtmPnls.reduce((s, p) => s + p.mtmPnlUsd, 0);
  const utilization =
    data.walletBalanceUsd > 0
      ? ((data.deployedCapitalUsd / data.walletBalanceUsd) * 100).toFixed(1)
      : '0.0';

  const lines: string[] = [
    `📊 <b>Yield Agent Daily Report</b>`,
    `${esc(dateStr)} · ${esc(timeStr)}`,
    ``,
    `💼 <b>Portfolio</b>`,
    `Open positions: ${data.openPositions.length}`,
    `Deployed capital: ${fmtUsd(data.deployedCapitalUsd)}`,
    `Capital utilization: ${utilization}%`,
    ``,
    `📈 <b>PnL (since inception)</b>`,
    `Cash flow (yield − gas): ${totalCashFlow >= 0 ? '+' : ''}${fmtUsd(totalCashFlow)}`,
    `Mark-to-market: ${totalMtm >= 0 ? '+' : ''}${fmtUsd(totalMtm)}`,
    ``,
    `🏆 <b>Active Positions</b>`,
  ];

  if (data.bookSummaries && data.bookSummaries.some((summary) => summary.openPositions > 0 || summary.deployedUsd > 0)) {
    lines.push(``, `📚 <b>Books</b>`);
    for (const summary of data.bookSummaries.filter((item) => item.openPositions > 0 || item.deployedUsd > 0)) {
      lines.push(
        `• ${esc(summary.book)} — Open: ${summary.openPositions} · Deployed: ${fmtUsd(summary.deployedUsd)} · CF PnL: ${summary.cashFlowPnlUsd >= 0 ? '+' : ''}${fmtUsd(summary.cashFlowPnlUsd)} · MtM: ${summary.mtmPnlUsd >= 0 ? '+' : ''}${fmtUsd(summary.mtmPnlUsd)}`
      );
    }
  }

  if (data.openPositions.length === 0) {
    lines.push(`<i>No active positions.</i>`);
  } else {
    for (const pos of data.openPositions) {
      const cf = data.cashFlowPnls.find((p) => p.positionId === pos.id);
      lines.push(
        `• ${esc(pos.pool_name)} (${esc(pos.protocol)})` +
          `\n  Book: ${esc(pos.book ?? 'unassigned')} · APY: ${esc(fmt(pos.entry_apy))}% · Size: ${fmtUsd(pos.size_usd)}` +
          (cf ? ` · PnL: ${cf.cashFlowPnlUsd >= 0 ? '+' : ''}${fmtUsd(cf.cashFlowPnlUsd)}` : '')
      );
    }
  }

  // Top 3 SUGGEST opportunities
  const top3 = data.suggestions.filter((s) => s.recommendation === 'SUGGEST').slice(0, 3);
  lines.push(``, `👀 <b>Tomorrow's Watchlist</b> (top 3 SUGGEST)`);
  if (top3.length === 0) {
    lines.push(`<i>No SUGGEST-tier opportunities found.</i>`);
  } else {
    for (const opp of top3) {
      lines.push(
        `• ${esc(opp.poolName)} — Score ${esc(fmt(opp.score, 1))} — APY ${esc(fmt(opp.apyUsed))}% — TVL ${fmtUsd(opp.tvlUsd)}`
      );
    }
  }

  // Flags
  lines.push(``, `⚠️ <b>Flags</b>`);
  const flags: string[] = [];

  if (data.uncertainOpportunities.length > 0) {
    flags.push(`Data uncertainty: ${data.uncertainOpportunities.length} opportunity(ies) flagged`);
    for (const opp of data.uncertainOpportunities.slice(0, 3)) {
      flags.push(`  · ${esc(opp.poolName)} (DefiLlama vs protocol APY divergence)`);
    }
  }

  if (data.pendingRebalance.length > 0) {
    flags.push(
      `Rebalance pending: ${data.pendingRebalance.map((p) => esc(p.pool_name)).join(', ')}`
    );
  }

  if (data.circuitBreakerActive) {
    flags.push(`🔴 Circuit breaker: ACTIVE — new positions paused`);
  } else {
    flags.push(`Circuit breaker: CLEAR`);
  }

  if (flags.length === 0) flags.push(`None`);
  lines.push(...flags);

  if (data.paperPortfolio) {
    const pp = data.paperPortfolio;
    const retSign = pp.totalReturnPct >= 0 ? '+' : '';
    lines.push(
      ``,
      `🎮 <b>Paper Portfolio (simulation)</b>`,
      `Starting balance: ${fmtUsd(pp.startingBalanceUsd)}`,
      `Current value: ${fmtUsd(pp.totalValueUsd)} (${retSign}${fmt(pp.totalReturnPct)}%)`,
      `Cash: ${fmtUsd(pp.cashUsd)} · Deployed: ${fmtUsd(pp.deployedUsd)}`,
      `Yield earned: +${fmtUsd(pp.totalYieldUsd)}`,
      `Open positions: ${pp.openPositions}`,
    );
  }

  lines.push(``, `<i>Next scan: 06:00 UTC</i>`);

  return lines.join('\n');
}

export interface TierPositionSummary {
  token: string;
  pnl_pct: number;
  hold_hours: number;
}

export interface TierMonitorSummary {
  total_positions: number;
  by_tier: Record<number, {
    count: number;
    value_usd: number;
    pnl_pct_avg: number;
    positions: TierPositionSummary[];
  }>;
}

export function formatTierPortfolioReport(
  positionMonitorSummary: TierMonitorSummary,
  portfolioConfig: PortfolioConfig,
  dailyPnlByTier: Record<number, number>,
  totalCapital: number,
  paperTrading: boolean,
): string {
  const modeTag = paperTrading ? 'PAPER' : 'LIVE';
  const tierEmojis: Record<number, string> = {
    1: '🔵',
    2: '🟢',
    3: '🟢',
    4: '🟡',
    5: '🟡',
    6: '🟠',
    7: '🟠',
    8: '🔴',
    9: '💀',
  };

  const lines = [
    '========================================',
    `YIELD AGENT REPORT ${modeTag}`,
    '========================================',
    `Total Capital: ${fmtUsd(totalCapital)}`,
    '',
    'TIER BREAKDOWN',
    '------------------------------',
  ];

  for (const tier of portfolioConfig.active_tiers) {
    const tierInfo = positionMonitorSummary.by_tier[tier] ?? { count: 0, value_usd: 0, pnl_pct_avg: 0, positions: [] };
    const tierConfig = portfolioConfig.getTierConfig(tier);
    const allocated = portfolioConfig.getTierCapitalUsd(tier);
    lines.push(`${tierEmojis[tier] ?? '⚪'} Tier ${tier} - ${tierConfig.label}`);
    lines.push(`  Allocated: ${fmtUsd(allocated)} | Deployed: ${fmtUsd(tierInfo.value_usd)}`);
    lines.push(`  Positions: ${tierInfo.count} | Avg PnL: ${(tierInfo.pnl_pct_avg * 100).toFixed(1)}%`);
    lines.push(`  Daily PnL: ${dailyPnlByTier[tier] ?? 0 >= 0 ? '+' : ''}${fmtUsd(dailyPnlByTier[tier] ?? 0)}`);
    for (const position of tierInfo.positions.slice(0, 3)) {
      lines.push(`  - ${esc(position.token)}: ${(position.pnl_pct * 100).toFixed(1)}% (${position.hold_hours.toFixed(1)}h)`);
    }
    lines.push('');
  }

  const totalDeployed = portfolioConfig.active_tiers.reduce(
    (sum, tier) => sum + (positionMonitorSummary.by_tier[tier]?.value_usd ?? 0),
    0,
  );
  const totalDailyPnl = Object.values(dailyPnlByTier).reduce((sum, pnl) => sum + pnl, 0);
  const deploymentPct = totalCapital > 0 ? totalDeployed / totalCapital : 0;
  lines.push('------------------------------');
  lines.push(`Total Deployed: ${fmtUsd(totalDeployed)} (${(deploymentPct * 100).toFixed(0)}%)`);
  lines.push(`Total Daily PnL: ${totalDailyPnl >= 0 ? '+' : ''}${fmtUsd(totalDailyPnl, )}`);
  lines.push(`Projected Monthly: ${totalDailyPnl >= 0 ? '+' : ''}${fmtUsd(totalDailyPnl * 30)}`);
  lines.push('========================================');
  return lines.join('\n');
}

export function formatEntryApprovalRequest(params: {
  signal: Record<string, unknown>;
  recommendation: string;
  score: number;
  positionSizeUsd: number;
  tier: number;
  tierConfig: { meteora_position_style: string; meteora_bin_step: number; take_profit_pct: number; stop_loss_pct: number; max_hold_hours: number };
  reasoning: string;
  concerns: string;
}): string {
  const tierLabels: Record<number, string> = {
    6: 'Growth',
    7: 'Aggressive',
    8: 'Degen',
    9: 'Ultra Degen',
  };
  const poolAddress = String(params.signal['poolAddress'] ?? '');
  return [
    'TRADE APPROVAL REQUIRED',
    '',
    `Tier ${params.tier} - ${tierLabels[params.tier] ?? 'Custom'} Entry Signal`,
    `Token: ${esc(String(params.signal['tokenSymbol'] ?? 'UNKNOWN'))}`,
    `Pool: ${esc(poolAddress.slice(0, 20))}...`,
    '',
    'Metrics',
    `Score: ${params.score.toFixed(0)}/100`,
    `Recommendation: ${params.recommendation}`,
    `Size: ${fmtUsd(params.positionSizeUsd)}`,
    `Confidence: ${Math.round(Number(params.signal['confidenceScore'] ?? 0) * 100)}%`,
    '',
    'Strategy',
    `Style: ${params.tierConfig.meteora_position_style}`,
    `Bin Step: ${params.tierConfig.meteora_bin_step}`,
    `TP: +${Math.round(params.tierConfig.take_profit_pct * 100)}% | SL: -${Math.round(Math.abs(params.tierConfig.stop_loss_pct) * 100)}%`,
    `Max Hold: ${params.tierConfig.max_hold_hours}h`,
    '',
    'Analysis',
    params.reasoning,
    '',
    'Concerns',
    params.concerns.length > 0 ? params.concerns : 'None',
    '',
    `Approve: /approve_${poolAddress.slice(0, 8)}`,
    `Reject: /reject_${poolAddress.slice(0, 8)}`,
  ].join('\n');
}

export function formatExitNotification(exitResult: Record<string, unknown>, tier: number): string {
  const pnlPct = Number(exitResult['pnlPct'] ?? 0);
  const pnlUsd = Number(exitResult['pnlUsd'] ?? 0);
  const claimedFeesUsd = Number(exitResult['claimedFeesUsd'] ?? 0);
  const totalReturnUsd = Number(exitResult['totalReturnUsd'] ?? 0);
  const exitReason = String(exitResult['exitReason'] ?? 'unknown');
  const reasonEmoji: Record<string, string> = {
    take_profit: '🎯',
    stop_loss: '🛑',
    time_stop: '⏰',
    out_of_range: '📏',
    rug_detected: '🚨',
  };
  return [
    `${reasonEmoji[exitReason] ?? '📤'} POSITION EXITED - Tier ${tier}`,
    '',
    `Token: ${esc(String(exitResult['tokenSymbol'] ?? 'UNKNOWN'))}`,
    `Reason: ${esc(exitReason.replaceAll('_', ' '))}`,
    `PnL: ${pnlPct >= 0 ? '+' : ''}${(pnlPct * 100).toFixed(1)}% (${pnlUsd >= 0 ? '+' : ''}${fmtUsd(pnlUsd)})`,
    `Fees Claimed: ${fmtUsd(claimedFeesUsd)}`,
    `Total Return: ${fmtUsd(totalReturnUsd)}`,
  ].join('\n');
}

export function formatRebalanceNotification(params: {
  reason: string;
  currentAllocations: Record<number, number>;
  targetAllocations: Record<number, number>;
  capitalToMoveUsd: number;
  solPriceChangePct: number;
}): string {
  const tiers = [...new Set([...Object.keys(params.currentAllocations), ...Object.keys(params.targetAllocations)].map(Number))]
    .sort((a, b) => a - b);
  const lines = [
    'PORTFOLIO REBALANCE',
    '',
    `Reason: ${params.reason.replaceAll('_', ' ')}`,
    `Capital To Move: ${fmtUsd(params.capitalToMoveUsd)}`,
    `SOL Move: ${params.solPriceChangePct >= 0 ? '+' : ''}${(params.solPriceChangePct * 100).toFixed(1)}%`,
    '',
    'Allocations',
  ];

  for (const tier of tiers) {
    lines.push(
      `Tier ${tier}: ${((params.currentAllocations[tier] ?? 0) * 100).toFixed(0)}% -> ${((params.targetAllocations[tier] ?? 0) * 100).toFixed(0)}%`
    );
  }

  return lines.join('\n');
}
