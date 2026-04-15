import type { Database } from '../positions/db.js';
import { type Signal } from './types.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Tier 3 — Signal Queue
// ---------------------------------------------------------------------------
// Thin wrapper around the DB signal_queue table with deduplication.
// INSERT OR IGNORE on dedup_key means the same logical signal never appears
// twice within a deduplication window (keyed by type:id:YYYY-MM-DD).
// ---------------------------------------------------------------------------

export class SignalQueue {
  constructor(private readonly db: Database) {}

  /**
   * Enqueue an array of signals.  Duplicates (same dedup_key) are silently
   * discarded.  Returns the count of *newly* inserted signals.
   */
  async enqueue(signals: Signal[]): Promise<number> {
    let newCount = 0;
    for (const signal of signals) {
      const inserted = await this.db.insertSignal({
        id: signal.id,
        type: signal.type,
        priority: signal.priority,
        payload: signal.payload,
        dedupKey: signal.dedupKey,
      });
      if (inserted) newCount++;
    }
    if (newCount > 0) {
      logger.info({ newCount, total: signals.length }, 'Signals enqueued');
    }
    return newCount;
  }

  /** Dequeue all unprocessed CRITICAL signals. */
  async dequeueCritical(): Promise<Signal[]> {
    return this.parseRows(await this.db.getUnprocessedSignals('CRITICAL'));
  }

  /** Dequeue all unprocessed HIGH signals. */
  async dequeueHighBatch(): Promise<Signal[]> {
    return this.parseRows(await this.db.getUnprocessedSignals('HIGH'));
  }

  /** Dequeue all unprocessed LOW signals. */
  async dequeueLowBatch(): Promise<Signal[]> {
    return this.parseRows(await this.db.getUnprocessedSignals('LOW'));
  }

  /** Mark a batch of signals as processed, associating them with a LangGraph thread_id. */
  async markProcessed(signalIds: string[], threadId: string): Promise<void> {
    await this.db.markSignalsProcessed(signalIds, threadId);
  }

  private parseRows(
    rows: Array<{ id: string; type: string; priority: string; payload: string; dedupKey: string; createdAt: string }>
  ): Signal[] {
    return rows.map((row) => ({
      id: row.id,
      type: row.type as Signal['type'],
      priority: row.priority as Signal['priority'],
      timestamp: row.createdAt,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      dedupKey: row.dedupKey,
      processed: false,
      threadId: null,
    }));
  }
}
