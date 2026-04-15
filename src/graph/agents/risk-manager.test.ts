import { describe, expect, it } from 'vitest';
import { RISK_MANAGER_SYSTEM } from './risk-manager.js';

describe('risk manager prompt', () => {
  it('includes tier-aware scoring and protection instructions', () => {
    expect(RISK_MANAGER_SYSTEM).toContain('score_tier_opportunity');
    expect(RISK_MANAGER_SYSTEM).toContain('POSITION_AUTO_EXIT');
    expect(RISK_MANAGER_SYSTEM).toContain('PORTFOLIO_REBALANCE');
  });
});
