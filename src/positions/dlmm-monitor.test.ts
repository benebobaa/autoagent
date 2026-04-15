import { describe, expect, it } from 'vitest';
import { evaluateHardCloseRules, evaluateTrailingTakeProfit, type PositionPnlData } from './dlmm-monitor.js';
import type { AgentConfig } from '../config/loader.js';
import type { DlmmPosition } from './db.js';

function makeManagement(overrides: Partial<NonNullable<AgentConfig['meteora']['management']>> = {}) {
  return {
    out_of_range_wait_minutes: 30,
    out_of_range_bins_to_close: 10,
    stop_loss_pct: -50,
    take_profit_pct: 5,
    trailing_take_profit_enabled: true,
    trail_arm_profit_pct: 5,
    trail_drawdown_pct: 2,
    min_fee_per_tvl_24h: 7,
    min_claim_amount_usd: 5,
    auto_swap_after_close: true,
    management_interval_minutes: 10,
    ...overrides,
  };
}

function makePnl(overrides: Partial<PositionPnlData> = {}): PositionPnlData {
  return {
    pnlUsd: 3,
    pnlPct: 6,
    currentValueUsd: 103,
    unclaimedFeesUsd: 0.5,
    allTimeFeesUsd: 1,
    feePerTvl24h: 10,
    inRange: true,
    activeBinId: 5,
    lowerBinId: 2,
    upperBinId: 8,
    currentPrice: null,
    ageMinutes: 120,
    ...overrides,
  };
}

function makeDlmmPosition(overrides: Partial<DlmmPosition> = {}): DlmmPosition {
  return {
    id: 'dlmm-1',
    position_id: 'position-1',
    position_pubkey: 'position-pubkey',
    pool_pubkey: 'pool-pubkey',
    lower_bin_id: 2,
    upper_bin_id: 8,
    active_bin_at_deploy: 5,
    strategy: 'Spot',
    bins_below: 2,
    bins_above: 2,
    amount_x_deployed: 10,
    amount_y_deployed: 10,
    initial_value_usd: 100,
    bin_step: 5,
    volatility_at_deploy: 1,
    fee_tvl_ratio_at_deploy: 10,
    organic_score_at_deploy: 80,
    base_mint: 'So111',
    peak_pnl_pct: null,
    last_pnl_pct: null,
    trailing_armed_at: null,
    last_monitored_at: null,
    deployed_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('DLMM trailing take profit', () => {
  it('arms trailing and records the initial peak once profit threshold is reached', () => {
    const result = evaluateTrailingTakeProfit(
      makeDlmmPosition(),
      makePnl({ pnlPct: 6 }),
      makeManagement(),
      '2026-04-04T00:00:00.000Z',
    );

    expect(result.trailingArmedAt).toBe('2026-04-04T00:00:00.000Z');
    expect(result.peakPnlPct).toBe(6);
    expect(result.decision).toBeNull();
  });

  it('triggers a trailing close after enough drawdown from peak', () => {
    const result = evaluateTrailingTakeProfit(
      makeDlmmPosition({ peak_pnl_pct: 8, trailing_armed_at: '2026-04-04T00:00:00.000Z' }),
      makePnl({ pnlPct: 5.5 }),
      makeManagement({ trail_drawdown_pct: 2 }),
      '2026-04-04T00:05:00.000Z',
    );

    expect(result.drawdownPct).toBeCloseTo(2.5, 6);
    expect(result.decision?.signalType).toBe('DLMM_TRAILING_TP');
    expect(result.decision?.closeReason).toBe('trailing_take_profit');
  });

  it('keeps fixed take profit only when trailing is disabled', () => {
    const result = evaluateHardCloseRules(
      makePnl({ pnlPct: 6 }),
      makeManagement({ trailing_take_profit_enabled: false }),
      0,
    );

    expect(result?.signalType).toBe('DLMM_TAKE_PROFIT');
    expect(result?.closeReason).toBe('take_profit');
  });
});
