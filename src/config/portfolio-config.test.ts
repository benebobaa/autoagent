import { afterEach, describe, expect, it } from 'vitest';
import { getActivePortfolio, resetActivePortfolio } from './portfolio-config.js';

describe('portfolio-config', () => {
  afterEach(() => {
    delete process.env['PAPER_TRADING'];
    delete process.env['TOTAL_CAPITAL_USD'];
    delete process.env['ACTIVE_TIERS'];
    delete process.env['TIER_2_ALLOCATION'];
    delete process.env['TIER_5_ALLOCATION'];
    delete process.env['TIER_8_ALLOCATION'];
    resetActivePortfolio();
  });

  it('returns the default paper portfolio with 2/5/8 tiers and 50/30/20 allocation', () => {
    process.env['PAPER_TRADING'] = 'true';
    process.env['TOTAL_CAPITAL_USD'] = '500';

    const portfolio = getActivePortfolio();

    expect(portfolio.active_tiers).toEqual([2, 5, 8]);
    expect(portfolio.getTierConfig(2).capital_allocation_pct).toBe(0.5);
    expect(portfolio.getTierConfig(5).capital_allocation_pct).toBe(0.3);
    expect(portfolio.getTierConfig(8).capital_allocation_pct).toBe(0.2);
    expect(portfolio.validateAllocations()).toBe(true);
  });
});
