import type { ScoredOpportunity } from '../scoring/engine.js';
import type { Position } from '../positions/db.js';
import {
  classifyPool,
  getExposureByGroup,
  checkConcentrationRisk,
  type CorrelationGroup,
} from '../scoring/correlation.js';
import {
  evaluateBaseMintHistoryPolicy,
  evaluateProtocolHistoryPolicy,
  type AllocatorHistoryConfig,
  type BaseMintBookStatsMap,
  type ProtocolBookStatsMap,
} from './history-policy.js';
import { extractBaseMintFromOpportunity } from './token-memory.js';

export interface AllocatorConfig extends AllocatorHistoryConfig {
  enabled: boolean;
  live_enabled: boolean;
  live_scout_enabled: boolean;
  live_gas_reserve_sol: number;
  target_utilization_pct: number;
  scout_enabled_paper: boolean;
  scout_min_score: number;
  scout_max_positions: number;
  scout_position_usd: number;
}

export interface AllocationInputs {
  opportunities: ScoredOpportunity[];
  activePoolIds: Set<string>;
  cooledPoolIds: Set<string>;
  activePositions: Position[];
  paperTrading: boolean;
  portfolioUsd: number;
  availableCashUsd: number;
  activePositionCount: number;
  maxOpenPositions: number;
  minPositionUsd: number;
  maxPositionUsd: number;
  maxGroupConcentrationPct: number;
  protocolBookStats: ProtocolBookStatsMap;
  baseMintBookStats: BaseMintBookStatsMap;
  allocator: AllocatorConfig;
}

export interface AllocationIntent {
  book: 'core' | 'scout';
  opportunity: ScoredOpportunity;
  sizeUsd: number;
  historyReason: string | null;
}

function clampPositionSize(sizeUsd: number, minPositionUsd: number, maxPositionUsd: number): number | null {
  if (sizeUsd < minPositionUsd) {
    return null;
  }

  return Math.min(maxPositionUsd, Math.round(sizeUsd * 100) / 100);
}

function filterEligible(
  opportunities: ScoredOpportunity[],
  activePoolIds: Set<string>,
  cooledPoolIds: Set<string>
): ScoredOpportunity[] {
  return opportunities.filter(
    (opportunity) => !activePoolIds.has(opportunity.poolId) && !cooledPoolIds.has(opportunity.poolId)
  );
}

/**
 * Filter candidates that would breach concentration limits given current exposure.
 * Returns only candidates that pass the concentration check with the proposed size.
 */
function filterByConcentration(
  candidates: ScoredOpportunity[],
  sizeUsd: number,
  activePositions: Position[],
  portfolioUsd: number,
  maxGroupConcentrationPct: number
): ScoredOpportunity[] {
  const exposure = getExposureByGroup(activePositions);
  const simulatedExposure = new Map<CorrelationGroup, number>(exposure);
  const result: ScoredOpportunity[] = [];

  for (const opp of candidates) {
    const group = classifyPool(opp.protocol, opp.poolName);
    const check = checkConcentrationRisk({
      currentExposure: simulatedExposure,
      newPosition: { group, sizeUsd },
      maxGroupConcentrationPct,
      totalCapitalUsd: portfolioUsd,
    });

    if (!check.allowed) continue;

    // Simulate this position being opened so subsequent picks respect its exposure
    simulatedExposure.set(group, (simulatedExposure.get(group) ?? 0) + sizeUsd);
    result.push(opp);
  }

  return result;
}

function applyHistoryPolicy(
  candidates: ScoredOpportunity[],
  book: 'core' | 'scout',
  allocator: AllocatorConfig,
  protocolBookStats: ProtocolBookStatsMap,
  baseMintBookStats: BaseMintBookStatsMap,
): Array<{ opportunity: ScoredOpportunity; historyReason: string | null }> {
  return candidates
    .flatMap((opportunity) => {
      const protocolPolicy = evaluateProtocolHistoryPolicy(opportunity.protocol, book, allocator, protocolBookStats);
      const baseMint = extractBaseMintFromOpportunity(opportunity);
      const tokenPolicy = baseMint === null
        ? { allowed: true, rankAdjustment: 0, reason: null }
        : evaluateBaseMintHistoryPolicy(baseMint, book, allocator, baseMintBookStats);

      if (!protocolPolicy.allowed || !tokenPolicy.allowed) {
        return [];
      }

      const reasons = [protocolPolicy.reason, tokenPolicy.reason].filter(
        (reason): reason is string =>
          reason !== null &&
          reason.length > 0 &&
          !reason.endsWith('history cold start')
      );

      return [{
        opportunity,
        historyReason: reasons.length > 0 ? reasons.join('; ') : null,
        effectiveScore: opportunity.score + protocolPolicy.rankAdjustment + tokenPolicy.rankAdjustment,
      }];
    })
    .sort((a, b) => b.effectiveScore - a.effectiveScore)
    .map(({ opportunity, historyReason }) => ({ opportunity, historyReason }));
}

export function buildAllocationPlan(inputs: AllocationInputs): AllocationIntent[] {
  const {
    opportunities,
    activePoolIds,
    cooledPoolIds,
    activePositions,
    paperTrading,
    portfolioUsd,
    availableCashUsd,
    activePositionCount,
    maxOpenPositions,
    minPositionUsd,
    maxPositionUsd,
    maxGroupConcentrationPct,
    protocolBookStats,
    baseMintBookStats,
    allocator,
  } = inputs;

  if (!allocator.enabled || availableCashUsd < minPositionUsd) {
    return [];
  }

  const remainingSlots = Math.max(0, maxOpenPositions - activePositionCount);
  if (remainingSlots === 0) {
    return [];
  }

  const eligible = filterEligible(opportunities, activePoolIds, cooledPoolIds);
  const coreCandidates = eligible.filter((opportunity) => opportunity.recommendation === 'SUGGEST');

  if (coreCandidates.length > 0) {
    const openCount = Math.min(
      coreCandidates.length,
      remainingSlots,
      Math.floor(availableCashUsd / minPositionUsd)
    );
    if (openCount === 0) {
      return [];
    }

    const sizeUsd = clampPositionSize(availableCashUsd / openCount, minPositionUsd, maxPositionUsd);
    if (sizeUsd === null) {
      return [];
    }

    // Filter out candidates that would breach concentration limits
    const concentrationSafe = filterByConcentration(
      coreCandidates,
      sizeUsd,
      activePositions,
      portfolioUsd,
      maxGroupConcentrationPct
    );
    if (concentrationSafe.length === 0) {
      return [];
    }

    const historyEligible = applyHistoryPolicy(concentrationSafe, 'core', allocator, protocolBookStats, baseMintBookStats);
    if (historyEligible.length === 0) {
      return [];
    }

    const actualCount = Math.min(openCount, historyEligible.length);
    return historyEligible.slice(0, actualCount).map(({ opportunity, historyReason }) => ({
      book: 'core' as const,
      opportunity,
      sizeUsd,
      historyReason,
    }));
  }

  const scoutEnabled = paperTrading ? allocator.scout_enabled_paper : allocator.live_scout_enabled;
  if (!scoutEnabled) {
    return [];
  }

  const deployedUsd = Math.max(0, portfolioUsd - availableCashUsd);
  const currentUtilizationPct = portfolioUsd > 0 ? (deployedUsd / portfolioUsd) * 100 : 0;
  if (currentUtilizationPct >= allocator.target_utilization_pct) {
    return [];
  }

  const scoutCandidates = eligible.filter(
    (opportunity) =>
      opportunity.recommendation === 'WATCH' && opportunity.score >= allocator.scout_min_score
  );
  if (scoutCandidates.length === 0) {
    return [];
  }

  const targetDeploymentUsd = (allocator.target_utilization_pct / 100) * portfolioUsd;
  const missingDeploymentUsd = Math.max(0, targetDeploymentUsd - deployedUsd);
  const scoutPositionUsd = clampPositionSize(
    allocator.scout_position_usd,
    minPositionUsd,
    maxPositionUsd
  );
  if (scoutPositionUsd === null) {
    return [];
  }

  const desiredScoutCount = Math.ceil(missingDeploymentUsd / scoutPositionUsd);
  const scoutOpenCount = Math.min(
    scoutCandidates.length,
    allocator.scout_max_positions,
    remainingSlots,
    Math.floor(availableCashUsd / scoutPositionUsd),
    Math.max(1, desiredScoutCount)
  );
  if (scoutOpenCount === 0) {
    return [];
  }

  // Filter scout candidates by concentration too
  const concentrationSafeScouts = filterByConcentration(
    scoutCandidates,
    scoutPositionUsd,
    activePositions,
    portfolioUsd,
    maxGroupConcentrationPct
  );
  if (concentrationSafeScouts.length === 0) {
    return [];
  }

  const historyEligibleScouts = applyHistoryPolicy(concentrationSafeScouts, 'scout', allocator, protocolBookStats, baseMintBookStats);
  if (historyEligibleScouts.length === 0) {
    return [];
  }

  const actualScoutCount = Math.min(scoutOpenCount, historyEligibleScouts.length);
  return historyEligibleScouts.slice(0, actualScoutCount).map(({ opportunity, historyReason }) => ({
    book: 'scout' as const,
    opportunity,
    sizeUsd: scoutPositionUsd,
    historyReason,
  }));
}
