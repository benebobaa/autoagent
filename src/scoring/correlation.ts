import type { Position } from '../positions/db.js';

export type CorrelationGroup =
  | 'SOL_LENDING'
  | 'SOL_LP'
  | 'STABLECOIN_LENDING'
  | 'LST_STAKING'
  | 'STABLECOIN_LP';

export function classifyPool(protocol: string, poolName: string): CorrelationGroup {
  const name = poolName.toLowerCase();

  if (protocol === 'jito') {
    return 'LST_STAKING';
  }

  if (name.includes('msol') || name.includes('jsol') || name.includes('stsol')) {
    return 'LST_STAKING';
  }

  if (protocol === 'meteora_dlmm' || protocol === 'kamino_vaults') {
    if (name.includes('usdc') || name.includes('usdt') || name.includes('dust')) {
      if (name.includes('sol')) {
        return 'SOL_LP';
      }
      return 'STABLECOIN_LP';
    }
    return 'SOL_LP';
  }

  if (protocol === 'kamino_lending' || protocol === 'marginfi') {
    if (name.includes('usdc') || name.includes('usdt') || name.includes('dust')) {
      return 'STABLECOIN_LENDING';
    }
    return 'SOL_LENDING';
  }

  if (name.includes('sol')) {
    return 'SOL_LENDING';
  }

  return 'STABLECOIN_LENDING';
}

export function getExposureByGroup(positions: Position[]): Map<CorrelationGroup, number> {
  const exposure = new Map<CorrelationGroup, number>();

  for (const pos of positions) {
    if (pos.state !== 'ACTIVE') continue;

    const group = classifyPool(pos.protocol, pos.pool_name);
    const current = exposure.get(group) ?? 0;
    exposure.set(group, current + pos.size_usd);
  }

  return exposure;
}

export interface ConcentrationCheckResult {
  allowed: boolean;
  reason: string;
}

export function checkConcentrationRisk(params: {
  currentExposure: Map<CorrelationGroup, number>;
  newPosition: { group: CorrelationGroup; sizeUsd: number };
  maxGroupConcentrationPct: number;
  totalCapitalUsd: number;
}): ConcentrationCheckResult {
  const { currentExposure, newPosition, maxGroupConcentrationPct, totalCapitalUsd } = params;

  if (totalCapitalUsd <= 0) {
    return { allowed: true, reason: 'No capital deployed yet' };
  }

  const currentGroupExposure = currentExposure.get(newPosition.group) ?? 0;
  const projectedGroupExposure = currentGroupExposure + newPosition.sizeUsd;
  const projectedGroupPct = (projectedGroupExposure / totalCapitalUsd) * 100;

  if (projectedGroupPct > maxGroupConcentrationPct) {
    return {
      allowed: false,
      reason: `Would exceed ${maxGroupConcentrationPct}% concentration limit in ${newPosition.group}: ` +
        `current ${((currentGroupExposure / totalCapitalUsd) * 100).toFixed(1)}% + ` +
        `new ${((newPosition.sizeUsd / totalCapitalUsd) * 100).toFixed(1)}% = ` +
        `${projectedGroupPct.toFixed(1)}% (max: ${maxGroupConcentrationPct}%)`,
    };
  }

  return {
    allowed: true,
    reason: `Concentration check passed: ${newPosition.group} would be ${projectedGroupPct.toFixed(1)}% of portfolio`,
  };
}
