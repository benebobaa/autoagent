import { Annotation, MessagesAnnotation } from '@langchain/langgraph';
import type { Signal } from '../signals/types.js';
import type { MarketSnapshot } from '../signals/snapshot.js';
import type { ScoredOpportunity } from '../scoring/engine.js';
import type { MarketRegime } from '../signals/regime.js';
import type { CapitalIntent } from '../portfolio/intents.js';

// Position shape from DB (minimal subset needed in graph state)
export interface ActivePosition {
  id: string;
  protocol: string;
  pool_name: string;
  pool_id: string;
  state: string;
  tier?: number | null;
  deployment_mode?: 'passive' | 'active' | null;
  position_style?: string | null;
  size_usd: number;
  entry_apy: number;
  opened_at: string | null;
}

// A pending action waiting for human approval
export interface PendingAction {
  type: 'create_position' | 'execute_transaction';
  positionId?: string;
  opportunityId?: string;
  details: Record<string, unknown>;
  interruptPayload: unknown;
}

// Result of a human decision via Telegram inline keyboard
export interface HumanDecision {
  actionType: string;
  positionId?: string;
  decision: 'approve' | 'reject';
  timestamp: string;
}

// ---------------------------------------------------------------------------
// AgentState — shared state flowing through the LangGraph graph
// ---------------------------------------------------------------------------

export const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,

  // Signals that triggered this graph invocation
  currentSignals: Annotation<Signal[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),

  // Latest market data snapshot
  marketSnapshot: Annotation<MarketSnapshot | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // Current portfolio positions
  activePositions: Annotation<ActivePosition[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),

  // Scored opportunities from the latest scan
  opportunities: Annotation<ScoredOpportunity[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),

  capitalIntents: Annotation<CapitalIntent[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),

  // Actions the trader agent is proposing (awaiting human approval)
  pendingActions: Annotation<PendingAction[]>({
    reducer: (existing, next) => [...existing, ...next],
    default: () => [],
  }),

  // Human approval/rejection decisions (filled by HITL bridge)
  humanDecisions: Annotation<HumanDecision[]>({
    reducer: (existing, next) => [...existing, ...next],
    default: () => [],
  }),

  // Which specialist agent the supervisor most recently activated
  lastActiveAgent: Annotation<string | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // Free-text reasoning from the supervisor for audit trail
  supervisorReasoning: Annotation<string>({
    reducer: (_, next) => next,
    default: () => '',
  }),

  // Current market regime detected from SOL price history
  currentRegime: Annotation<MarketRegime | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
});

export type AgentStateType = typeof AgentState.State;
