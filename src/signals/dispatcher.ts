import { v4 as uuidv4 } from 'uuid';
import type { AgentConfig } from '../config/loader.js';
import type { Database } from '../positions/db.js';
import type { CapitalIntent } from '../portfolio/intents.js';
import type { TelegramReporter } from '../reporter/telegram.js';
import type { ScoredOpportunity } from '../scoring/engine.js';
import { logger } from '../utils/logger.js';
import type { MarketSnapshot } from './snapshot.js';
import type { Signal } from './types.js';
import type { SignalQueue } from './queue.js';

// ---------------------------------------------------------------------------
// Tier 4 — Signal Dispatcher
// ---------------------------------------------------------------------------
// Reads from the signal queue and routes signals to the appropriate handler:
//   CRITICAL → fire immediately
//   HIGH     → batch and fire hourly
//   LOW      → batch and fire daily (+ daily heartbeat at 00:00)
//
// The `onDispatch` callback is the integration point for LangGraph (Phase 6).
// Until Phase 6, it logs and sends a Telegram alert.
// ---------------------------------------------------------------------------

export interface DispatchBatch {
  signals: Signal[];
  capitalIntents: CapitalIntent[];
  marketSnapshot: MarketSnapshot | null;
  opportunities: ScoredOpportunity[];
}

type DispatchBatchBuilder = (signals: Signal[]) => Promise<DispatchBatch>;

export type DispatchHandler = (batch: DispatchBatch, threadId: string) => Promise<void>;

async function defaultBatchBuilder(signals: Signal[]): Promise<DispatchBatch> {
  return {
    signals,
    capitalIntents: [],
    marketSnapshot: null,
    opportunities: [],
  };
}

export class SignalDispatcher {
  private lastHighFlush = 0; // 0 = fire immediately on first tick (same as LOW)
  private lastLowFlush = 0; // 0 = fire immediately on first tick
  private lastHeartbeatDate = '';

  constructor(
    private readonly config: AgentConfig,
    private readonly db: Database,
    private readonly queue: SignalQueue,
    private readonly reporter: TelegramReporter,
    private onDispatch: DispatchHandler = defaultHandler,
    private buildBatch: DispatchBatchBuilder = defaultBatchBuilder,
  ) {}

  /** Replace the dispatch handler (used in Phase 6 to inject LangGraph). */
  setDispatchHandler(handler: DispatchHandler): void {
    this.onDispatch = handler;
  }

  setBatchBuilder(builder: DispatchBatchBuilder): void {
    this.buildBatch = builder;
  }

  /** Called on every poller tick to check what needs to be dispatched. */
  async tick(): Promise<void> {
    const now = Date.now();

    // 1. CRITICAL — always fire immediately
    const criticals = await this.queue.dequeueCritical();
    if (criticals.length > 0) {
      await this.dispatch(criticals);
    }

    // 2. HIGH — batch hourly (lock before await to prevent concurrent duplicate dispatches)
    const highIntervalMs = this.config.dispatch.high_batch_interval_sec * 1000;
    if (now - this.lastHighFlush >= highIntervalMs) {
      this.lastHighFlush = now; // lock before await
      const highs = await this.queue.dequeueHighBatch();
      if (highs.length > 0) {
        await this.dispatch(highs);
      }
    }

    // 3. LOW + HEARTBEAT — hourly
    // IMPORTANT: set lastLowFlush BEFORE the async dispatch so concurrent ticks
    // (the poller fires onSnapshot fire-and-forget) don't see stale lastLowFlush=0
    // and trigger duplicate dispatches while the graph is still running.
    const lowIntervalMs = this.config.dispatch.low_batch_interval_sec * 1000;
    if (now - this.lastLowFlush >= lowIntervalMs) {
      this.lastLowFlush = now; // lock before await
      let lows = await this.queue.dequeueLowBatch();
      if (lows.length > 0) {
        // Cap NEW_HIGH_YIELD_POOL to top 3 by score to prevent context explosion in LangGraph.
        // Discovery mode can generate 5-10 of these per scan; sending all at once burns tokens.
        const MAX_DISCOVERY_SIGNALS = 3;
        const discoverySignals = lows
          .filter((s) => s.type === 'NEW_HIGH_YIELD_POOL')
          .sort((a, b) => ((b.payload as { score?: number }).score ?? 0) - ((a.payload as { score?: number }).score ?? 0))
          .slice(0, MAX_DISCOVERY_SIGNALS);
        const otherSignals = lows.filter((s) => s.type !== 'NEW_HIGH_YIELD_POOL');
        lows = [...otherSignals, ...discoverySignals];
        await this.dispatch(lows);
      }
    }

    // 4. Hourly heartbeat — fires once per hour to keep the agent active
    await this.checkHeartbeat();
  }

  /**
   * Enqueue a HEARTBEAT signal for the current hour if not already done.
   * One per hour — matches the hourly LOW batch dispatch cadence.
   */
  async checkHeartbeat(): Promise<void> {
    const hourKey = new Date().toISOString().slice(0, 13); // "2026-04-03T17"
    if (hourKey === this.lastHeartbeatDate) return;
    this.lastHeartbeatDate = hourKey;

    const heartbeat: Signal = {
      id: uuidv4(),
      type: 'HEARTBEAT',
      priority: 'LOW',
      timestamp: new Date().toISOString(),
      payload: { triggeredAt: new Date().toISOString() },
      dedupKey: `HEARTBEAT:hourly:${hourKey}`,
      processed: false,
      threadId: null,
    };

    const inserted = await this.db.insertSignal({
      id: heartbeat.id,
      type: heartbeat.type,
      priority: heartbeat.priority,
      payload: heartbeat.payload,
      dedupKey: heartbeat.dedupKey,
    });

    if (inserted) {
      logger.info({ hourKey }, 'Hourly heartbeat signal enqueued');
    }
  }

  private async dispatch(signals: Signal[]): Promise<void> {
    const threadId = uuidv4();
    const batch = await this.buildBatch(signals);
    logger.info(
      { count: signals.length, priorities: [...new Set(signals.map((s) => s.priority))] },
      'Dispatching signals'
    );

    try {
      await this.onDispatch(batch, threadId);
      await this.queue.markProcessed(
        signals.map((s) => s.id),
        threadId
      );
    } catch (err) {
      logger.error({ err, threadId }, 'Dispatch handler failed — signals will retry on next tick');
    }
  }
}

// ---------------------------------------------------------------------------
// Default handler (Phase 3: log + Telegram alert, no LangGraph yet)
// ---------------------------------------------------------------------------

async function defaultHandler(batch: DispatchBatch, threadId: string): Promise<void> {
  const { signals, capitalIntents } = batch;
  const criticals = signals.filter((s) => s.priority === 'CRITICAL');
  const highs = signals.filter((s) => s.priority === 'HIGH');
  const lows = signals.filter((s) => s.priority === 'LOW');

  logger.info(
    { threadId, criticals: criticals.length, highs: highs.length, lows: lows.length, capitalIntents: capitalIntents.length },
    'Signal batch received (default handler — LangGraph not yet wired)'
  );

  for (const sig of signals) {
    logger.info({ type: sig.type, priority: sig.priority, payload: sig.payload }, 'Signal');
  }
}
