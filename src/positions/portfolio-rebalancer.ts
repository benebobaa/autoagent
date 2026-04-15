import { v4 as uuidv4 } from 'uuid';
import type { Database } from './db.js';
import type { PortfolioConfig } from '../config/portfolio-config.js';
import { SIGNAL_PRIORITY, type Signal } from '../signals/types.js';
import { logger } from '../utils/logger.js';

export class PortfolioRebalancer {
  private lastRebalanceAt = 0;

  constructor(private readonly db: Database) {}

  async recordPortfolioValue(totalValueUsd: number): Promise<void> {
    await this.db.insertPortfolioValueHistory(totalValueUsd);
  }

  async computeDrawdown48h(): Promise<number> {
    const history = await this.db.getPortfolioValueHistory(48);
    if (history.length < 2) {
      return 0;
    }
    const peak = Math.max(...history.map((row) => row.total_value_usd));
    const current = history[history.length - 1]?.total_value_usd ?? peak;
    return peak > 0 ? (current - peak) / peak : 0;
  }

  async checkCircuitBreakers(params: {
    portfolio: PortfolioConfig;
    currentValueUsd: number;
    currentAllocations: Record<number, number>;
    solPriceChangePct?: number;
    affectedPositionIds?: string[];
  }): Promise<Signal[]> {
    const { portfolio, currentAllocations, solPriceChangePct = 0, affectedPositionIds = [] } = params;
    const signals: Signal[] = [];
    const drawdown = await this.computeDrawdown48h();
    const timestamp = new Date().toISOString();
    const bucket = timestamp.slice(0, 13);

    if (drawdown <= -portfolio.global_max_drawdown_pct) {
      signals.push({
        id: uuidv4(),
        type: 'CIRCUIT_BREAKER_TRIGGERED',
        priority: SIGNAL_PRIORITY['CIRCUIT_BREAKER_TRIGGERED'],
        timestamp,
        payload: {
          triggerType: 'global_drawdown',
          triggerValue: drawdown,
          triggerThreshold: -portfolio.global_max_drawdown_pct,
          positionsAffected: affectedPositionIds,
          recommendedAction: 'close_aggressive_tiers',
        },
        dedupKey: `CIRCUIT_BREAKER_TRIGGERED:global_drawdown:${bucket}`,
        processed: false,
        threadId: null,
      });
    }

    const aggressivePct = portfolio.active_tiers
      .filter((tier) => tier >= 7)
      .reduce((sum, tier) => sum + (currentAllocations[tier] ?? 0), 0);
    if (aggressivePct > portfolio.max_aggressive_pct) {
      signals.push({
        id: uuidv4(),
        type: 'CIRCUIT_BREAKER_TRIGGERED',
        priority: SIGNAL_PRIORITY['CIRCUIT_BREAKER_TRIGGERED'],
        timestamp,
        payload: {
          triggerType: 'aggressive_cap_exceeded',
          triggerValue: aggressivePct,
          triggerThreshold: portfolio.max_aggressive_pct,
          positionsAffected: affectedPositionIds,
          recommendedAction: 'close_aggressive_tiers',
        },
        dedupKey: `CIRCUIT_BREAKER_TRIGGERED:aggressive_cap:${bucket}`,
        processed: false,
        threadId: null,
      });
    }

    if (portfolio.event_driven_rebalance && solPriceChangePct <= -portfolio.volatility_spike_threshold_pct) {
      const targetAllocations = { ...currentAllocations };
      const maxTier = Math.max(...portfolio.active_tiers);
      if (maxTier >= 7) {
        targetAllocations[maxTier] = Math.max(0, (targetAllocations[maxTier] ?? 0) - portfolio.volatility_spike_shift_pct);
        targetAllocations[2] = (targetAllocations[2] ?? 0) + portfolio.volatility_spike_shift_pct;
      }
      signals.push(this.buildRebalanceSignal({
        timestamp,
        reason: 'volatility_spike',
        currentAllocations,
        targetAllocations,
        solPriceChangePct,
        drawdown,
      }));
    }

    const hoursSinceRebalance = (Date.now() - this.lastRebalanceAt) / 3_600_000;
    if (hoursSinceRebalance >= portfolio.rebalance_interval_hours) {
      const targetAllocations = Object.fromEntries(
        portfolio.active_tiers.map((tier) => [tier, portfolio.getTierConfig(tier).capital_allocation_pct]),
      ) as Record<number, number>;
      const drift = portfolio.active_tiers.reduce(
        (sum, tier) => sum + Math.abs((currentAllocations[tier] ?? 0) - (targetAllocations[tier] ?? 0)),
        0,
      );
      if (drift > 0.05) {
        this.lastRebalanceAt = Date.now();
        signals.push(this.buildRebalanceSignal({
          timestamp,
          reason: 'scheduled',
          currentAllocations,
          targetAllocations,
          solPriceChangePct,
          drawdown,
        }));
      }
    }

    if (signals.length > 0) {
      logger.info({ count: signals.length }, 'Portfolio rebalancer emitted signals');
    }
    return signals;
  }

  private buildRebalanceSignal(params: {
    timestamp: string;
    reason: string;
    currentAllocations: Record<number, number>;
    targetAllocations: Record<number, number>;
    solPriceChangePct: number;
    drawdown: number;
  }): Signal {
    const capitalToMoveUsd = Object.entries(params.targetAllocations).reduce((sum, [tier, targetPct]) => {
      const currentPct = params.currentAllocations[Number(tier)] ?? 0;
      return sum + Math.abs(currentPct - targetPct);
    }, 0);

    return {
      id: uuidv4(),
      type: 'PORTFOLIO_REBALANCE',
      priority: SIGNAL_PRIORITY['PORTFOLIO_REBALANCE'],
      timestamp: params.timestamp,
      payload: {
        rebalanceReason: params.reason,
        currentAllocations: params.currentAllocations,
        targetAllocations: params.targetAllocations,
        capitalToMoveUsd,
        solPriceChangePct: params.solPriceChangePct,
        portfolioDrawdownPct: params.drawdown,
      },
      dedupKey: `PORTFOLIO_REBALANCE:${params.reason}:${params.timestamp.slice(0, 13)}`,
      processed: false,
      threadId: null,
    };
  }
}
