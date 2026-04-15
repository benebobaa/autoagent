import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { Database, Position } from '../../positions/db.js';
import type { TelegramReporter } from '../../reporter/telegram.js';
import { formatDailyReport, formatTierPortfolioReport, type BookSummary, type PaperPortfolioSummary } from '../../reporter/format.js';
import { computeCashFlowPnl, computeMtmPnl } from '../../positions/pnl.js';
import type { ScoredOpportunity } from '../../scoring/engine.js';
import type { AgentConfig } from '../../config/loader.js';
import type { Opportunity } from '../../positions/db.js';
import { getActivePortfolio } from '../../config/portfolio-config.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sc = <T extends z.ZodRawShape>(s: z.ZodObject<T>): any => s;

function oppToScored(o: Opportunity): ScoredOpportunity {
  return {
    poolId: o.pool_id, protocol: o.protocol as ScoredOpportunity['protocol'],
    poolName: o.pool_name, apyDefillama: o.apy_defillama, apyProtocol: o.apy_protocol,
    apyUsed: o.apy_used, tvlUsd: o.tvl_usd ?? 0, dataUncertain: o.data_uncertain === 1,
    score: o.score, apyScore: 0, liquidityScore: 0, trustScore: 0, riskPenalty: 0, regimePenalty: 0,
    recommendation: 'SUGGEST' as const,
  };
}

async function buildBookSummaries(db: Database) {
  const active = await db.getPositionsByState('ACTIVE');
  const cfPnls = active.map((p) => computeCashFlowPnl(p));
  const mtmPnls = await Promise.all(active.map(async (p) => computeMtmPnl(p, await db.getLatestPnlSnapshot(p.id, 'mark_to_market'))));
  const books: Array<BookSummary['book']> = ['core', 'scout', 'unassigned'];

  return books.map((book) => {
    const positions = active.filter((position) => (position.book ?? 'unassigned') === book);
    const positionIds = new Set(positions.map((position) => position.id));

    return {
      book,
      openPositions: positions.length,
      deployedUsd: positions.reduce((sum, position) => sum + position.size_usd, 0),
      cashFlowPnlUsd: cfPnls.filter((pnl) => positionIds.has(pnl.positionId)).reduce((sum, pnl) => sum + pnl.cashFlowPnlUsd, 0),
      mtmPnlUsd: mtmPnls.filter((pnl) => positionIds.has(pnl.positionId)).reduce((sum, pnl) => sum + pnl.mtmPnlUsd, 0),
    } satisfies BookSummary;
  });
}

export function createReporterTools(db: Database, reporter: TelegramReporter, config?: AgentConfig) {
  const sendTelegramMessage = tool(
    async ({ text }: { text: string }) => {
      await reporter.sendMessage(text);
      return JSON.stringify({ sent: true });
    },
    {
      name: 'send_telegram_message',
      description: 'Send a plain text or HTML message via Telegram.',
      schema: sc(z.object({ text: z.string() })),
    }
  );

  const buildPaperPortfolioSummary = async (): Promise<PaperPortfolioSummary | undefined> => {
    if (!config?.paperTrading) return undefined;
    const portfolio = await db.getPaperPortfolio();
    if (!portfolio) return undefined;
    const active = await db.getPositionsByState('ACTIVE');
    const closed = await db.getPositionsByState('CLOSED');
    const cfPnls = active.map((p) => computeCashFlowPnl(p));
    const totalYieldUsd = cfPnls.reduce((s, p) => s + p.yieldEarnedUsd, 0);
    const deployedUsd = active.reduce((s, p) => s + p.size_usd, 0);
    // Realized gains from closed positions flow back to cash
    const realizedGainsUsd = closed.reduce((s, p) => s + computeCashFlowPnl(p).cashFlowPnlUsd, 0);
    const cashUsd = Math.max(0, portfolio.starting_balance_usd - deployedUsd + realizedGainsUsd);
    const totalValueUsd = cashUsd + deployedUsd + totalYieldUsd;
    const totalReturnPct =
      portfolio.starting_balance_usd > 0
        ? ((totalValueUsd - portfolio.starting_balance_usd) / portfolio.starting_balance_usd) * 100
        : 0;
    return { startingBalanceUsd: portfolio.starting_balance_usd, cashUsd, deployedUsd, totalYieldUsd, totalValueUsd, totalReturnPct, openPositions: active.length };
  };

  const buildReportData = async (db: Database) => {
    const active = await db.getPositionsByState('ACTIVE');
    const pending = await db.getPositionsByState('PENDING_REBALANCE');
    const cfPnls = active.map((p) => computeCashFlowPnl(p));
    const mtmPnls = await Promise.all(active.map(async (p) => computeMtmPnl(p, await db.getLatestPnlSnapshot(p.id, 'mark_to_market'))));

    // Read live scores from latest market snapshot (updated every 5 min) instead of
    // the stale opportunities table (only written when a position is first opened).
    const suggestThreshold = config?.scoring.min_score_to_suggest ?? 50;
    const activePoolIds = new Set(active.map((p) => p.pool_id));
    const latestSnapshot = await db.getLatestSnapshot() as { pools?: Array<Record<string, unknown>> } | null;
    const snapshotPools = latestSnapshot?.pools ?? [];
    const suggestions: ScoredOpportunity[] = snapshotPools
      .filter((p) => typeof p['score'] === 'number' && (p['score'] as number) >= suggestThreshold && !activePoolIds.has(String(p['poolId'] ?? '')))
      .sort((a, b) => (b['score'] as number) - (a['score'] as number))
      .slice(0, 10)
      .map((p) => ({
        poolId: String(p['poolId'] ?? ''),
        protocol: String(p['protocol'] ?? '') as ScoredOpportunity['protocol'],
        poolName: String(p['poolName'] ?? ''),
        apyDefillama: null,
        apyProtocol: null,
        apyUsed: typeof p['apyPct'] === 'number' ? p['apyPct'] : 0,
        tvlUsd: typeof p['tvlUsd'] === 'number' ? p['tvlUsd'] : 0,
        dataUncertain: false,
        score: p['score'] as number,
        apyScore: 0, liquidityScore: 0, trustScore: 0, riskPenalty: 0, regimePenalty: 0,
        recommendation: 'SUGGEST' as const,
      }));
    const uncertain: ScoredOpportunity[] = [];
    return {
      active,
      pending,
      cfPnls,
      mtmPnls,
      suggestions,
      uncertain,
      deployedCapital: active.reduce((s, p) => s + p.size_usd, 0),
      bookSummaries: await buildBookSummaries(db),
      paperPortfolio: await buildPaperPortfolioSummary(),
    };
  };

  const buildTierReportData = async () => {
    const portfolio = getActivePortfolio();
    const active = await db.getPositionsByState('ACTIVE');
    const mtmByPosition = new Map<string, ReturnType<typeof computeMtmPnl>>();
    const cfByPosition = new Map<string, ReturnType<typeof computeCashFlowPnl>>();

    for (const position of active) {
      mtmByPosition.set(position.id, computeMtmPnl(position, await db.getLatestPnlSnapshot(position.id, 'mark_to_market')));
      cfByPosition.set(position.id, computeCashFlowPnl(position));
    }

    const byTier = Object.fromEntries(
      portfolio.active_tiers.map((tier) => {
        const tierPositions = active.filter((position) => (position.tier ?? null) === tier);
        const entries = tierPositions.map((position) => {
          const mtm = mtmByPosition.get(position.id);
          const pnlPct = mtm && position.size_usd > 0 ? mtm.mtmPnlUsd / position.size_usd : 0;
          const openedAt = position.opened_at ?? position.created_at;
          const holdHours = Math.max(0, (Date.now() - new Date(openedAt).getTime()) / 3_600_000);
          return {
            token: position.pool_name,
            pnl_pct: pnlPct,
            hold_hours: holdHours,
            current_value_usd: mtm?.currentValueUsd ?? position.size_usd,
          };
        });
        const avgPnl = entries.length > 0 ? entries.reduce((sum, entry) => sum + entry.pnl_pct, 0) / entries.length : 0;
        return [
          tier,
          {
            count: entries.length,
            value_usd: entries.reduce((sum, entry) => sum + entry.current_value_usd, 0),
            pnl_pct_avg: avgPnl,
            positions: entries.map(({ token, pnl_pct, hold_hours }) => ({ token, pnl_pct, hold_hours })),
          },
        ];
      }),
    );

    const dailyPnlByTier = Object.fromEntries(
      portfolio.active_tiers.map((tier) => {
        const pnl = active
          .filter((position) => (position.tier ?? null) === tier)
          .reduce((sum, position) => sum + (cfByPosition.get(position.id)?.cashFlowPnlUsd ?? 0), 0);
        return [tier, pnl];
      }),
    );

    return {
      portfolio,
      summary: { total_positions: active.length, by_tier: byTier },
      dailyPnlByTier,
    };
  };

  const formatDailyReportTool = tool(
    async () => {
      const { active, pending, cfPnls, mtmPnls, suggestions, uncertain, deployedCapital, bookSummaries, paperPortfolio } = await buildReportData(db);
      const html = formatDailyReport({
        openPositions: active, cashFlowPnls: cfPnls, mtmPnls, suggestions, uncertainOpportunities: uncertain,
        pendingRebalance: pending, circuitBreakerActive: false,
        deployedCapitalUsd: deployedCapital, walletBalanceUsd: deployedCapital,
        bookSummaries,
        ...(paperPortfolio !== undefined && { paperPortfolio }),
      });
      return JSON.stringify({ html, length: html.length });
    },
    {
      name: 'format_daily_report',
      description: 'Format the daily portfolio report as HTML. Returns HTML ready to send.',
      schema: sc(z.object({})),
    }
  );

  const sendDailyReportTool = tool(
    async () => {
      const { active, pending, cfPnls, mtmPnls, suggestions, uncertain, deployedCapital, bookSummaries, paperPortfolio } = await buildReportData(db);
      await reporter.sendDailyReport({
        openPositions: active, cashFlowPnls: cfPnls, mtmPnls, suggestions, uncertainOpportunities: uncertain,
        pendingRebalance: pending, circuitBreakerActive: false,
        deployedCapitalUsd: deployedCapital, walletBalanceUsd: deployedCapital,
        bookSummaries,
        ...(paperPortfolio !== undefined && { paperPortfolio }),
      });
      return JSON.stringify({ sent: true });
    },
    {
      name: 'send_daily_report',
      description: 'Format and send the daily portfolio report via Telegram.',
      schema: sc(z.object({})),
    }
  );

  const sendTierPortfolioReportTool = tool(
    async () => {
      const { portfolio, summary, dailyPnlByTier } = await buildTierReportData();
      const html = formatTierPortfolioReport(
        summary,
        portfolio,
        dailyPnlByTier,
        portfolio.total_capital_usd,
        config?.paperTrading ?? true,
      );
      await reporter.sendMessage(html);
      return JSON.stringify({ sent: true, length: html.length });
    },
    {
      name: 'send_tier_portfolio_report',
      description: 'Send the tier-aware portfolio report via Telegram.',
      schema: sc(z.object({})),
    }
  );

  const sendExitNotificationTool = tool(
    async ({ tokenSymbol, tier, exitReason, pnlPct, pnlUsd, claimedFeesUsd, totalReturnUsd }: {
      tokenSymbol: string;
      tier: number;
      exitReason: string;
      pnlPct: number;
      pnlUsd: number;
      claimedFeesUsd: number;
      totalReturnUsd: number;
    }) => {
      await reporter.sendExitNotification({ tokenSymbol, exitReason, pnlPct, pnlUsd, claimedFeesUsd, totalReturnUsd }, tier);
      return JSON.stringify({ sent: true });
    },
    {
      name: 'send_exit_notification',
      description: 'Send a tier-aware exit notification via Telegram.',
      schema: sc(z.object({
        tokenSymbol: z.string(),
        tier: z.number().int(),
        exitReason: z.string(),
        pnlPct: z.number(),
        pnlUsd: z.number(),
        claimedFeesUsd: z.number(),
        totalReturnUsd: z.number(),
      })),
    }
  );

  const sendRebalanceNotificationTool = tool(
    async ({
      reason,
      currentAllocations,
      targetAllocations,
      capitalToMoveUsd,
      solPriceChangePct,
    }: {
      reason: string;
      currentAllocations: Record<string, number>;
      targetAllocations: Record<string, number>;
      capitalToMoveUsd: number;
      solPriceChangePct: number;
    }) => {
      await reporter.sendRebalanceNotification({
        reason,
        currentAllocations: Object.fromEntries(Object.entries(currentAllocations).map(([key, value]) => [Number(key), value])),
        targetAllocations: Object.fromEntries(Object.entries(targetAllocations).map(([key, value]) => [Number(key), value])),
        capitalToMoveUsd,
        solPriceChangePct,
      });
      return JSON.stringify({ sent: true });
    },
    {
      name: 'send_rebalance_notification',
      description: 'Send a tier-aware rebalance or circuit-breaker summary via Telegram.',
      schema: sc(z.object({
        reason: z.string(),
        currentAllocations: z.record(z.number()),
        targetAllocations: z.record(z.number()),
        capitalToMoveUsd: z.number(),
        solPriceChangePct: z.number(),
      })),
    }
  );

  return {
    sendTelegramMessage,
    formatDailyReportTool,
    sendDailyReportTool,
    sendTierPortfolioReportTool,
    sendExitNotificationTool,
    sendRebalanceNotificationTool,
  };
}

export type ReporterTools = ReturnType<typeof createReporterTools>;
