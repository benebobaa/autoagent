import { describe, expect, it } from 'vitest';
import { computeBinRange, emergencyExitTier } from './active-dlmm.js';

describe('active-dlmm executor helpers', () => {
  it('computes a wider upside range for one-sided SOL positions', () => {
    const range = computeBinRange(100, 'tight', 70, 100, 'one_sided_sol');
    expect(range.minPrice).toBeCloseTo(98);
    expect(range.maxPrice).toBeGreaterThan(115);
  });

  it('returns simulated exits for a batch tier emergency exit', async () => {
    const results = await emergencyExitTier(
      [
        { positionId: 'pos-1', poolAddress: 'pool-1', tokenSymbol: 'MEME', valueUsd: 100 },
        { positionId: 'pos-2', poolAddress: 'pool-2', tokenSymbol: 'SOL', valueUsd: 50 },
      ],
      'circuit_breaker',
    );

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.simulated)).toBe(true);
  });
});
