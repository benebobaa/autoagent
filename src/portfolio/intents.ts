import type { ScoredOpportunity } from '../scoring/engine.js';
import type { TransitionOptions } from '../positions/statemachine.js';

export type CapitalIntentAction = 'open' | 'close' | 'claim_fee';

export type CapitalIntentReason =
  | 'core_allocator'
  | 'scout_allocator'
  | 'dlmm_stop_loss'
  | 'dlmm_take_profit'
  | 'dlmm_trailing_take_profit'
  | 'dlmm_oor_close'
  | 'dlmm_fee_yield_low'
  | 'dlmm_fee_claim_ready';

export type CapitalIntentBook = 'core' | 'scout';

export type CapitalIntentCloseReason = Exclude<TransitionOptions['closeReason'], undefined>;

export interface CapitalIntent {
  id: string;
  action: CapitalIntentAction;
  reason: CapitalIntentReason;
  createdAt: string;
  signalTypes: string[];
  notes: string;
  book: CapitalIntentBook | null;
  positionId: string | null;
  opportunityId: string | null;
  poolId: string | null;
  protocol: string | null;
  poolName: string | null;
  sizeUsd: number | null;
  closeReason: CapitalIntentCloseReason | null;
  opportunity: ScoredOpportunity | null;
}
