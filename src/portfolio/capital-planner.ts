import { v4 as uuidv4 } from 'uuid';
import type { Position } from '../positions/db.js';
import type { Signal } from '../signals/types.js';
import { buildAllocationPlan, type AllocationInputs, type AllocationIntent } from './allocator.js';
import type { CapitalIntent, CapitalIntentCloseReason, CapitalIntentReason } from './intents.js';

export interface CapitalPlanningInputs extends AllocationInputs {
  signals: Signal[];
}

interface CloseIntentCandidate {
  signal: Signal;
  reason: CapitalIntentReason;
  closeReason: CapitalIntentCloseReason;
  notes: string;
  priority: number;
}

interface ClaimIntentCandidate {
  signal: Signal;
  reason: CapitalIntentReason;
  notes: string;
}

function mapCloseSignal(signal: Signal): CloseIntentCandidate | null {
  const payload = signal.payload as Record<string, unknown>;
  const positionId = typeof payload.positionId === 'string' ? payload.positionId : null;
  if (positionId === null) {
    return null;
  }

  switch (signal.type) {
    case 'DLMM_STOP_LOSS':
      return {
        signal,
        reason: 'dlmm_stop_loss',
        closeReason: 'stop_loss',
        notes: `Deterministic close: stop loss triggered at ${String(payload.pnlPct ?? 'unknown')}% PnL.`,
        priority: 4,
      };
    case 'DLMM_TAKE_PROFIT':
      return {
        signal,
        reason: 'dlmm_take_profit',
        closeReason: 'take_profit',
        notes: `Deterministic close: take profit triggered at ${String(payload.pnlPct ?? 'unknown')}% PnL.`,
        priority: 1,
      };
    case 'DLMM_TRAILING_TP':
      return {
        signal,
        reason: 'dlmm_trailing_take_profit',
        closeReason: 'trailing_take_profit',
        notes: `Deterministic close: trailing TP retraced from ${String(payload.peakPnlPct ?? 'unknown')}% to ${String(payload.currentPnlPct ?? payload.pnlPct ?? 'unknown')}% (drawdown ${String(payload.drawdownPct ?? 'unknown')}%).`,
        priority: 1,
      };
    case 'DLMM_OOR_CLOSE': {
      const rawReason = payload.reason;
      const isPumped = rawReason === 'pumped';
      return {
        signal,
        reason: 'dlmm_oor_close',
        closeReason: isPumped ? 'pumped_past_range' : 'oor_timeout',
        notes: isPumped
          ? `Deterministic close: active bin pumped beyond range (${String(payload.activeBinId ?? 'unknown')}).`
          : `Deterministic close: out of range for ${String(payload.minutesOor ?? 'unknown')} minutes.`,
        priority: 3,
      };
    }
    case 'DLMM_FEE_YIELD_LOW':
      return {
        signal,
        reason: 'dlmm_fee_yield_low',
        closeReason: 'fee_yield_low',
        notes: `Deterministic close: fee yield fell below threshold (${String(payload.feePerTvl24h ?? 'unknown')}%).`,
        priority: 2,
      };
    case 'POSITION_AUTO_EXIT': {
      const exitReason = typeof payload.exitReason === 'string' ? payload.exitReason : 'manual';
      const mappedCloseReason =
        exitReason === 'take_profit' ||
        exitReason === 'stop_loss' ||
        exitReason === 'time_stop' ||
        exitReason === 'out_of_range' ||
        exitReason === 'rug_detected' ||
        exitReason === 'trailing_take_profit' ||
        exitReason === 'oor_timeout' ||
        exitReason === 'pumped_past_range'
          ? exitReason
          : 'manual';
      return {
        signal,
        reason: 'dlmm_stop_loss',
        closeReason: mappedCloseReason,
        notes: `Deterministic close: position auto-exit triggered for ${exitReason}.`,
        priority: 5,
      };
    }
    default:
      return null;
  }
}

function buildCloseIntents(signals: Signal[], activePositions: Position[]): CapitalIntent[] {
  const positionsById = new Map(activePositions.map((position) => [position.id, position]));
  const bestByPositionId = new Map<string, CloseIntentCandidate>();

  for (const signal of signals) {
    const candidate = mapCloseSignal(signal);
    const positionId = (signal.payload as Record<string, unknown>).positionId;
    if (candidate === null || typeof positionId !== 'string') {
      continue;
    }

    const existing = bestByPositionId.get(positionId);
    if (!existing || candidate.priority > existing.priority) {
      bestByPositionId.set(positionId, candidate);
    }
  }

  return [...bestByPositionId.entries()].flatMap(([positionId, candidate]) => {
    const position = positionsById.get(positionId);
    if (!position) {
      return [];
    }

    return [{
      id: uuidv4(),
      action: 'close',
      reason: candidate.reason,
      createdAt: candidate.signal.timestamp,
      signalTypes: [candidate.signal.type],
      notes: candidate.notes,
      book: null,
      positionId: position.id,
      opportunityId: position.opportunity_id,
      poolId: position.pool_id,
      protocol: position.protocol,
      poolName: position.pool_name,
      sizeUsd: position.size_usd,
      closeReason: candidate.closeReason,
      opportunity: null,
    } satisfies CapitalIntent];
  });
}

function buildClaimIntents(signals: Signal[], activePositions: Position[]): CapitalIntent[] {
  const positionsById = new Map(activePositions.map((position) => [position.id, position]));

  return signals.flatMap((signal) => {
    if (signal.type !== 'DLMM_FEE_CLAIM_READY') {
      return [];
    }

    const payload = signal.payload as Record<string, unknown>;
    const positionId = typeof payload.positionId === 'string' ? payload.positionId : null;
    if (positionId === null) {
      return [];
    }

    const position = positionsById.get(positionId);
    if (!position) {
      return [];
    }

    const candidate: ClaimIntentCandidate = {
      signal,
      reason: 'dlmm_fee_claim_ready',
      notes: `Deterministic fee claim: unclaimed fees $${String(payload.unclaimedFeesUsd ?? 'unknown')}.`,
    };

    return [{
      id: uuidv4(),
      action: 'claim_fee',
      reason: candidate.reason,
      createdAt: candidate.signal.timestamp,
      signalTypes: [candidate.signal.type],
      notes: candidate.notes,
      book: null,
      positionId: position.id,
      opportunityId: position.opportunity_id,
      poolId: position.pool_id,
      protocol: position.protocol,
      poolName: position.pool_name,
      sizeUsd: position.size_usd,
      closeReason: null,
      opportunity: null,
    } satisfies CapitalIntent];
  });
}

function allocationIntentToCapitalIntent(intent: AllocationIntent, signalTypes: string[]): CapitalIntent {
  const historySuffix = intent.historyReason ? ` History: ${intent.historyReason}.` : '';
  return {
    id: uuidv4(),
    action: 'open',
    reason: intent.book === 'core' ? 'core_allocator' : 'scout_allocator',
    createdAt: new Date().toISOString(),
    signalTypes,
    notes:
      intent.book === 'core'
        ? `Deterministic core allocation for ${intent.opportunity.protocol}/${intent.opportunity.poolName}.${historySuffix}`
        : `Deterministic scout allocation for ${intent.opportunity.protocol}/${intent.opportunity.poolName}.${historySuffix}`,
    book: intent.book,
    positionId: null,
    opportunityId: intent.opportunity.poolId,
    poolId: intent.opportunity.poolId,
    protocol: intent.opportunity.protocol,
    poolName: intent.opportunity.poolName,
    sizeUsd: intent.sizeUsd,
    closeReason: null,
    opportunity: intent.opportunity,
  };
}

export function planCapitalIntents(inputs: CapitalPlanningInputs): CapitalIntent[] {
  const closeIntents = buildCloseIntents(inputs.signals, inputs.activePositions);
  if (closeIntents.length > 0) {
    return closeIntents;
  }

  const claimIntents = buildClaimIntents(inputs.signals, inputs.activePositions);
  if (claimIntents.length > 0) {
    return claimIntents;
  }

  if (!inputs.paperTrading && !inputs.allocator.live_enabled) {
    return [];
  }

  const allocationPlan = buildAllocationPlan(inputs);
  const signalTypes = inputs.signals.length > 0 ? inputs.signals.map((signal) => signal.type) : ['HEARTBEAT'];
  return allocationPlan.map((intent) => allocationIntentToCapitalIntent(intent, signalTypes));
}

export function getOpenAllocationIntents(intents: CapitalIntent[]): AllocationIntent[] {
  return intents.flatMap((intent) => {
    if (intent.action !== 'open' || intent.book === null || intent.opportunity === null || intent.sizeUsd === null) {
      return [];
    }

    return [{
      book: intent.book,
      opportunity: intent.opportunity,
      sizeUsd: intent.sizeUsd,
      historyReason: null,
    } satisfies AllocationIntent];
  });
}
