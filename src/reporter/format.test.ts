import { describe, expect, it } from 'vitest';
import { formatDailyReport, formatEntryApprovalRequest, formatExitNotification, formatTierPortfolioReport } from './format.js';
import { PAPER_PORTFOLIO } from '../config/portfolio-config.js';

describe('formatDailyReport', () => {
  it('includes book summaries and per-position book labels', () => {
    const report = formatDailyReport({
      openPositions: [
        {
          id: 'position-1',
          opportunity_id: 'opp-1',
          protocol: 'jito',
          pool_id: 'pool-1',
          pool_name: 'JitoSOL',
          state: 'ACTIVE',
          book: 'core',
          base_mint: null,
          size_usd: 100,
          entry_apy: 8,
          entry_price_sol: null,
          opened_at: null,
          closed_at: null,
          close_reason: null,
          notes: null,
          created_at: new Date().toISOString(),
        },
      ],
      cashFlowPnls: [{ positionId: 'position-1', yieldEarnedUsd: 1, gasPaidUsd: 0.1, cashFlowPnlUsd: 0.9, daysHeld: 1 }],
      mtmPnls: [{ positionId: 'position-1', costBasisUsd: 100, mtmPnlUsd: 1.2, currentValueUsd: 101.2 }],
      suggestions: [],
      uncertainOpportunities: [],
      pendingRebalance: [],
      circuitBreakerActive: false,
      deployedCapitalUsd: 100,
      walletBalanceUsd: 200,
      bookSummaries: [
        { book: 'core', openPositions: 1, deployedUsd: 100, cashFlowPnlUsd: 0.9, mtmPnlUsd: 1.2 },
        { book: 'scout', openPositions: 0, deployedUsd: 0, cashFlowPnlUsd: 0, mtmPnlUsd: 0 },
        { book: 'unassigned', openPositions: 0, deployedUsd: 0, cashFlowPnlUsd: 0, mtmPnlUsd: 0 },
      ],
    });

    expect(report).toContain('📚 <b>Books</b>');
    expect(report).toContain('core');
    expect(report).toContain('Book: core');
  });

  it('renders tier-aware reporting and approval helpers', () => {
    const tierReport = formatTierPortfolioReport(
      {
        total_positions: 1,
        by_tier: {
          2: { count: 1, value_usd: 100, pnl_pct_avg: 0.02, positions: [{ token: 'JitoSOL', pnl_pct: 0.02, hold_hours: 4 }] },
        },
      },
      PAPER_PORTFOLIO,
      { 2: 1.25, 5: 0, 8: 0 },
      500,
      true,
    );
    const approval = formatEntryApprovalRequest({
      signal: { poolAddress: 'abcd1234efgh5678', tokenSymbol: 'MEME', confidenceScore: 0.8 },
      recommendation: 'ENTER',
      score: 82,
      positionSizeUsd: 50,
      tier: 8,
      tierConfig: PAPER_PORTFOLIO.getTierConfig(8),
      reasoning: 'Strong momentum and volume spike.',
      concerns: '',
    });
    const exit = formatExitNotification({ tokenSymbol: 'MEME', exitReason: 'take_profit', pnlPct: 0.25, pnlUsd: 12.5, claimedFeesUsd: 0.5, totalReturnUsd: 62.5 }, 8);

    expect(tierReport).toContain('Tier 2');
    expect(approval).toContain('/approve_abcd1234');
    expect(approval).toContain('/reject_abcd1234');
    expect(exit).toContain('POSITION EXITED - Tier 8');
  });
});
