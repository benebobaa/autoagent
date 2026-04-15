import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { RAGStore } from './store.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// RAG Ingestor — loads documents into pgvector-backed memory
// ---------------------------------------------------------------------------

const DOCS_DIR = resolve(process.cwd(), 'data/docs');

// ---- Protocol documentation ----

/**
 * Ingest all Markdown files from data/docs/ into the RAG store.
 * Documents are tagged with `type: 'protocol_doc'` and `protocol: <filename stem>`.
 * Re-running is safe (upsert by stable id).
 */
export async function ingestProtocolDocs(store: RAGStore): Promise<void> {
  if (!existsSync(DOCS_DIR)) {
    logger.warn({ dir: DOCS_DIR }, 'data/docs/ not found — skipping protocol doc ingestion');
    return;
  }

  const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md'));
  if (files.length === 0) {
    logger.warn('No .md files found in data/docs/');
    return;
  }

  const documents = files.map((file) => {
    const protocol = file.replace('.md', '');
    const text = readFileSync(join(DOCS_DIR, file), 'utf-8');
    return {
      id: `protocol_doc:${protocol}`,
      text: `[Protocol: ${protocol}]\n\n${text}`,
      metadata: {
        type: 'protocol_doc',
        protocol,
        source: file,
      },
    };
  });

  await store.upsert(documents);
  logger.info({ count: documents.length, protocols: documents.map((d) => d.metadata['protocol']) }, 'Protocol docs ingested');
}

// ---- Agent decision log ----

export interface DecisionLogEntry {
  signalTypes: string[];
  agentReasoning: string; // supervisor + specialist agent chain of thought
  actionsDecided: string; // what the agent decided to do
  outcome?: string;       // filled in later when outcome is known
  portfolioPnlUsd?: number;
}

/**
 * Ingest a single agent decision log entry.
 * Called after each graph run to build up institutional memory.
 */
export async function ingestDecisionLog(
  store: RAGStore,
  entry: DecisionLogEntry
): Promise<void> {
  const id = `decision:${uuidv4()}`;
  const date = new Date().toISOString().slice(0, 10);

  const text = [
    `[Decision Log — ${date}]`,
    `Signals: ${entry.signalTypes.join(', ')}`,
    '',
    `Reasoning: ${entry.agentReasoning}`,
    '',
    `Decision: ${entry.actionsDecided}`,
    entry.outcome ? `Outcome: ${entry.outcome}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  await store.upsert([
    {
      id,
      text,
      metadata: {
        type: 'decision_log',
        date,
        signal_types: entry.signalTypes.join(','),
        pnl_usd: entry.portfolioPnlUsd ?? 0,
      },
    },
  ]);

  logger.debug({ id, signals: entry.signalTypes }, 'Decision log ingested into RAG');
}

// ---- PnL history ----

export interface PnlHistoryEntry {
  positionId: string;
  protocol: string;
  poolId: string;
  book: 'core' | 'scout' | null;
  entryApy: number;
  exitApy: number;
  daysHeld: number;
  pnlUsd: number;
  closeReason: string;
}

/**
 * Ingest a closed position PnL entry.
 * Enables the agent to ask "how did similar positions perform before?"
 */
export async function ingestPnlHistory(
  store: RAGStore,
  entry: PnlHistoryEntry
): Promise<void> {
  const id = `pnl:${entry.positionId}`;
  const date = new Date().toISOString().slice(0, 10);

  const text = [
    `[PnL Record — ${date}]`,
    `Protocol: ${entry.protocol}, Pool: ${entry.poolId}`,
    `Entry APY: ${entry.entryApy.toFixed(2)}%, Exit APY: ${entry.exitApy.toFixed(2)}%`,
    `Days held: ${entry.daysHeld.toFixed(0)}, PnL: $${entry.pnlUsd.toFixed(4)}`,
    `Closed because: ${entry.closeReason}`,
  ].join('\n');

  await store.upsert([
    {
      id,
      text,
      metadata: {
        type: 'pnl_history',
        protocol: entry.protocol,
        pool_id: entry.poolId,
        book: entry.book ?? '',
        close_reason: entry.closeReason,
        pnl_usd: entry.pnlUsd,
        date,
      },
    },
  ]);

  logger.debug({ positionId: entry.positionId, pnlUsd: entry.pnlUsd }, 'PnL history ingested into RAG');
}
