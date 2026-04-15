import type { Position, PnlSnapshot } from './db.js';

// ---------------------------------------------------------------------------
// Cash Flow PnL
// Formula: yield_earned_usd - gas_paid_usd
// yield_earned_usd = size_usd * (entry_apy / 100) * (days_held / 365)
// ---------------------------------------------------------------------------

export interface CashFlowPnl {
  positionId: string;
  daysHeld: number;
  yieldEarnedUsd: number;
  gasPaidUsd: number;
  cashFlowPnlUsd: number;
}

export function computeCashFlowPnl(
  position: Position,
  gasPaidUsd = 0
): CashFlowPnl {
  const openedAt = position.opened_at
    ? new Date(position.opened_at).getTime()
    : new Date(position.created_at).getTime();

  const closedAt = position.closed_at
    ? new Date(position.closed_at).getTime()
    : Date.now();

  const daysHeld = Math.max(0, (closedAt - openedAt) / (1000 * 60 * 60 * 24));
  const yieldEarnedUsd = position.size_usd * (position.entry_apy / 100) * (daysHeld / 365);
  const cashFlowPnlUsd = yieldEarnedUsd - gasPaidUsd;

  return {
    positionId: position.id,
    daysHeld,
    yieldEarnedUsd,
    gasPaidUsd,
    cashFlowPnlUsd,
  };
}

// ---------------------------------------------------------------------------
// Mark-to-Market PnL
// Formula: current_value_usd - cost_basis_usd
// Phase 1: current_value_usd = size_usd + yield_earned_usd (no live price feed)
// ---------------------------------------------------------------------------

export interface MtmPnl {
  positionId: string;
  costBasisUsd: number;
  currentValueUsd: number;
  mtmPnlUsd: number;
}

export function computeMtmPnl(
  position: Position,
  latestSnapshot?: PnlSnapshot
): MtmPnl {
  const costBasisUsd = position.size_usd;

  // If we have a saved snapshot with a current value, use it
  // Otherwise estimate from entry APY
  let currentValueUsd: number;
  if (latestSnapshot?.current_value_usd != null) {
    currentValueUsd = latestSnapshot.current_value_usd;
  } else {
    const cf = computeCashFlowPnl(position);
    currentValueUsd = costBasisUsd + cf.yieldEarnedUsd;
  }

  return {
    positionId: position.id,
    costBasisUsd,
    currentValueUsd,
    mtmPnlUsd: currentValueUsd - costBasisUsd,
  };
}

// ---------------------------------------------------------------------------
// Portfolio summary
// ---------------------------------------------------------------------------

export function computeBlendedApy(positions: Position[]): number {
  const active = positions.filter((p) => p.state === 'ACTIVE');
  if (active.length === 0) return 0;

  const totalSize = active.reduce((sum, p) => sum + p.size_usd, 0);
  if (totalSize === 0) return 0;

  const weighted = active.reduce((sum, p) => sum + p.entry_apy * p.size_usd, 0);
  return weighted / totalSize;
}

export function computeCapitalUtilization(
  positions: Position[],
  walletBalanceUsd: number
): number {
  if (walletBalanceUsd <= 0) return 0;
  const deployed = positions
    .filter((p) => p.state === 'ACTIVE')
    .reduce((sum, p) => sum + p.size_usd, 0);
  return (deployed / walletBalanceUsd) * 100;
}
