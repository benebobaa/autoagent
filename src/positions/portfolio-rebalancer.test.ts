import { describe, expect, it } from 'vitest';
import { PortfolioRebalancer } from './portfolio-rebalancer.js';
import { PAPER_PORTFOLIO } from '../config/portfolio-config.js';

describe('PortfolioRebalancer', () => {
  it('emits a circuit breaker signal on 48h drawdown breach', async () => {
    const db = {
      getPortfolioValueHistory: async () => [
        { id: '1', total_value_usd: 500, created_at: new Date(Date.now() - 1000).toISOString() },
        { id: '2', total_value_usd: 440, created_at: new Date().toISOString() },
      ],
      insertPortfolioValueHistory: async () => ({ id: '3', total_value_usd: 440, created_at: new Date().toISOString() }),
    } as never;
    const rebalancer = new PortfolioRebalancer(db);

    const signals = await rebalancer.checkCircuitBreakers({
      portfolio: PAPER_PORTFOLIO,
      currentValueUsd: 440,
      currentAllocations: { 2: 0.5, 5: 0.3, 8: 0.2 },
      solPriceChangePct: 0,
      affectedPositionIds: ['pos-1'],
    });

    expect(signals.some((signal) => signal.type === 'CIRCUIT_BREAKER_TRIGGERED')).toBe(true);
  });
});
