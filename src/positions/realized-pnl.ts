import type { Position } from './db.js';

export interface ApySnapshot {
  positionId: string;
  snapshotAt: string;
  currentApyPct: number;
  poolTvlUsd: number;
}

export interface RealizedPnL {
  positionId: string;
  tokenADeposited: number;
  tokenBDeposited: number;
  tokenAWithdrawn: number;
  tokenBWithdrawn: number;
  feesClaimedUsd: number;
  ilUsd: number;
  gasPaidUsd: number;
  netPnlUsd: number;
  timeWeightedCapitalUsd: number;
  realizedApyPct: number;
}

export function computeTimeWeightedApy(snapshots: ApySnapshot[]): number {
  if (snapshots.length < 2) return 0;

  const sorted = [...snapshots].sort(
    (a, b) => new Date(a.snapshotAt).getTime() - new Date(b.snapshotAt).getTime()
  );

  let weightedSum = 0;
  let totalDuration = 0;

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;

    const prevTime = new Date(prev.snapshotAt).getTime();
    const currTime = new Date(curr.snapshotAt).getTime();
    const durationHours = (currTime - prevTime) / (1000 * 60 * 60);

    weightedSum += prev.currentApyPct * durationHours;
    totalDuration += durationHours;
  }

  if (totalDuration === 0) return 0;
  return weightedSum / totalDuration;
}

export function computeRealizedPnl(params: {
  position: Position;
  apySnapshots: ApySnapshot[];
  tokenPrices: { tokenA: number; tokenB: number };
  gasPaidSol: number;
  solPriceUsd: number;
}): RealizedPnL {
  const { position, apySnapshots, tokenPrices, gasPaidSol, solPriceUsd } = params;

  const timeWeightedApy = computeTimeWeightedApy(apySnapshots);

  const openedAt = position.opened_at
    ? new Date(position.opened_at).getTime()
    : new Date(position.created_at).getTime();
  const closedAt = position.closed_at
    ? new Date(position.closed_at).getTime()
    : Date.now();

  const daysHeld = Math.max(0, (closedAt - openedAt) / (1000 * 60 * 60 * 24));
  const yearsHeld = daysHeld / 365;

  const timeWeightedCapitalUsd = position.size_usd;
  const feesClaimedUsd = timeWeightedCapitalUsd * (timeWeightedApy / 100) * yearsHeld;

  const gasPaidUsd = gasPaidSol * solPriceUsd;

  const netPnlUsd = feesClaimedUsd - gasPaidUsd;

  const realizedApyPct = yearsHeld > 0
    ? (netPnlUsd / timeWeightedCapitalUsd) * (365 / daysHeld) * 100
    : 0;

  return {
    positionId: position.id,
    tokenADeposited: 0,
    tokenBDeposited: 0,
    tokenAWithdrawn: 0,
    tokenBWithdrawn: 0,
    feesClaimedUsd,
    ilUsd: 0,
    gasPaidUsd,
    netPnlUsd,
    timeWeightedCapitalUsd,
    realizedApyPct,
  };
}
