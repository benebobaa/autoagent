import type { VectorWhere } from '../storage/types.js';
import type { RAGStore, RAGQueryResult } from './store.js';

// ---------------------------------------------------------------------------
// RAG Query Helpers
// ---------------------------------------------------------------------------
// Domain-specific query functions that agents call via tools.
// Each function wraps a similarity search with appropriate filtering.
// ---------------------------------------------------------------------------

/** Find past decisions that were made in response to similar signal types. */
export async function queryPastDecisions(
  store: RAGStore,
  signalTypes: string[],
  k = 3
): Promise<RAGQueryResult[]> {
  const queryText = `agent decision when signals: ${signalTypes.join(', ')}`;
  return store.query(queryText, {
    n: k,
    where: { type: { $eq: 'decision_log' } } satisfies VectorWhere,
  });
}

/**
 * Query protocol documentation for a specific topic.
 * E.g. queryProtocolInfo(store, 'kamino', 'liquidation risk')
 */
export async function queryProtocolInfo(
  store: RAGStore,
  protocol: string,
  topic: string,
  k = 3
): Promise<RAGQueryResult[]> {
  const queryText = `${protocol} ${topic}`;
  return store.query(queryText, {
    n: k,
    where: { $and: [{ type: { $eq: 'protocol_doc' } }, { protocol: { $eq: protocol } }] } satisfies VectorWhere,
  });
}

/**
 * Query historical PnL for a specific pool or protocol.
 * E.g. queryPnlContext(store, 'jito') or queryPnlContext(store, undefined, 'apy_drop')
 */
export async function queryPnlContext(
  store: RAGStore,
  protocol?: string,
  closeReason?: string,
  k = 5
): Promise<RAGQueryResult[]> {
  const queryText = [
    'position PnL history performance',
    protocol ?? '',
    closeReason ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const filters: VectorWhere[] = [{ type: { $eq: 'pnl_history' } }];
  if (protocol) filters.push({ protocol: { $eq: protocol } });
  if (closeReason) filters.push({ close_reason: { $eq: closeReason } });

  const where: VectorWhere = filters.length === 1 ? filters[0]! : { $and: filters };
  return store.query(queryText, { n: k, where });
}

/** General knowledge base search without filters. */
export async function searchKnowledgeBase(
  store: RAGStore,
  query: string,
  k = 5
): Promise<RAGQueryResult[]> {
  return store.query(query, { n: k });
}

/** Find lessons learned from similar situations (signal types + regime). */
export async function queryLessonsLearned(
  store: RAGStore,
  signalTypes: string[],
  regime?: string,
  k = 5
): Promise<RAGQueryResult[]> {
  const queryText = [
    'lesson learned from',
    ...signalTypes,
    regime ?? '',
  ].filter(Boolean).join(' ');

  return store.query(queryText, {
    n: k,
    where: { type: { $eq: 'lesson_learned' } } satisfies VectorWhere,
  });
}

/** Find the best and worst decisions the agent has made. */
export async function queryExtremeDecisions(
  store: RAGStore,
  grade: 'EXCELLENT' | 'TERRIBLE',
  k = 3
): Promise<RAGQueryResult[]> {
  const queryText = grade === 'EXCELLENT'
    ? 'best decision excellent outcome high performance'
    : 'worst decision terrible loss avoid';

  return store.query(queryText, {
    n: k,
    where: { $and: [{ type: { $eq: 'lesson_learned' } }, { grade: { $eq: grade } }] } satisfies VectorWhere,
  });
}

/** Find past decisions made in the same market regime. */
export async function queryRegimeExperience(
  store: RAGStore,
  regime: string,
  k = 5
): Promise<RAGQueryResult[]> {
  const queryText = `past decisions and outcomes in ${regime} market regime`;

  return store.query(queryText, {
    n: k,
    where: { $and: [{ type: { $eq: 'lesson_learned' } }, { regime: { $eq: regime } }] } satisfies VectorWhere,
  });
}
