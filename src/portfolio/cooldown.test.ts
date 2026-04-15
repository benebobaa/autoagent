import { describe, expect, it } from 'vitest';
import { buildCooldownUntil, shouldStartPoolCooldown } from './cooldown.js';

describe('pool cooldown policy', () => {
  it('starts cooldowns for bad exit reasons', () => {
    expect(shouldStartPoolCooldown('stop_loss')).toBe(true);
    expect(shouldStartPoolCooldown('apy_drop')).toBe(true);
    expect(shouldStartPoolCooldown('fee_yield_low')).toBe(true);
  });

  it('does not start cooldowns for manual or profit-taking exits', () => {
    expect(shouldStartPoolCooldown('manual')).toBe(false);
    expect(shouldStartPoolCooldown('take_profit')).toBe(false);
    expect(shouldStartPoolCooldown('rebalance')).toBe(false);
  });

  it('builds an ISO cooldown deadline in the future', () => {
    const now = '2026-04-03T21:00:00.000Z';
    const cooldownUntil = buildCooldownUntil(now, 12);

    expect(cooldownUntil).toBe('2026-04-04T09:00:00.000Z');
  });
});
