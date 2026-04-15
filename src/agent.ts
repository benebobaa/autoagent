import { loadConfig } from './config/loader.js';
import { Database } from './positions/db.js';
import { getConnection, getKitRpc } from './utils/rpc.js';
import { TelegramReporter } from './reporter/telegram.js';
import { logger } from './utils/logger.js';
import { startSupervisedSignalLoop } from './signals/supervisor.js';
import { createLLM } from './llm/factory.js';
import { createScannerTools } from './graph/tools/scanner-tools.js';
import { createRiskTools } from './graph/tools/risk-tools.js';
import { createExecutorTools } from './graph/tools/executor-tools.js';
import { createReporterTools } from './graph/tools/reporter-tools.js';
import { createRagTools } from './graph/tools/rag-tools.js';
import { createMeteoraTools } from './graph/tools/meteora-tools.js';
import { buildGraph } from './graph/graph.js';
import { createEmbeddingModel } from './embeddings/factory.js';
import { RAGStore } from './rag/store.js';
import { ApprovalStore } from './graph/hitl/approval-store.js';
import { TelegramApprovalBridge } from './graph/hitl/telegram-approval.js';
import type { Signal } from './signals/types.js';
import type { MarketSnapshot } from './signals/snapshot.js';
import type { DispatchBatch } from './signals/dispatcher.js';
import { runHeartbeat } from './graph/agents/heartbeat.js';
import { startHealthServer } from './utils/health.js';
import { ingestDecisionLog, ingestProtocolDocs } from './rag/ingest.js';

// ---------------------------------------------------------------------------
// Agent Entry Point — event-driven Investment Team
// ---------------------------------------------------------------------------

async function main() {
  logger.info('Solana Yield Agent starting (Investment Team mode)...');

  const config = loadConfig();
  const db = new Database(config.databaseUrl);
  const connection = getConnection(config);
  const kitRpc = getKitRpc(config);

  // Enable polling so the bot can receive inline keyboard callbacks for HITL
  const reporter = new TelegramReporter(config, true);

  logger.info({ dryRun: config.dryRun, paperTrading: config.paperTrading }, 'Agent initialized');

  if (config.paperTrading) {
    await db.initPaperPortfolio(config.paperStartingBalanceUsd);
    logger.info({ startingBalanceUsd: config.paperStartingBalanceUsd }, 'Paper trading mode: virtual portfolio initialized');
  }

  // ---------------------------------------------------------------------------
  // RAG Store
  // ---------------------------------------------------------------------------
  const embeddingModel = createEmbeddingModel(config);
  const ragStore = new RAGStore(config, embeddingModel);
  await ragStore.init();
  logger.info('RAG store initialized');
  // Ingest protocol docs on startup (safe to re-run — upserts by stable id)
  ingestProtocolDocs(ragStore).catch((err) => logger.warn({ err }, 'Protocol doc ingestion failed — non-critical'));

  // ---------------------------------------------------------------------------
  // LLM
  // ---------------------------------------------------------------------------
  // Cast away exactOptionalPropertyTypes mismatch — runtime is correct
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const llmConfig = config.llm.default as any;
  const llm = await createLLM(llmConfig);
  logger.info({ provider: llmConfig.provider, model: llmConfig.model }, 'LLM initialized');

  // ---------------------------------------------------------------------------
  // Tool factories (named objects — no array destructuring)
  // ---------------------------------------------------------------------------
  const scannerTools = createScannerTools(config, db, connection, kitRpc);
  const riskTools = createRiskTools(config, db, connection, kitRpc, ragStore);
  const executorTools = createExecutorTools(config, db, connection, ragStore);
  const reporterTools = createReporterTools(db, reporter, config);
  const ragTools = createRagTools(ragStore);
  const meteoraTools = createMeteoraTools(config, db);

  // ---------------------------------------------------------------------------
  // LangGraph — Investment Team graph
  // ---------------------------------------------------------------------------
  const graph = buildGraph({
    llm,
    db,
    ragStore,
    tools: { scannerTools, riskTools, executorTools, reporterTools, ragTools, meteoraTools },
    maxOpenPositions: config.position.max_open_positions,
  });

  logger.info('LangGraph Investment Team initialized');

  // ---------------------------------------------------------------------------
  // HITL Approval Bridge
  // ---------------------------------------------------------------------------
  const approvalStore = new ApprovalStore(db);
  const bot = reporter.getBot();
  if (bot && config.telegramChatId) {
    new TelegramApprovalBridge(graph, bot, config.telegramChatId, approvalStore);
    logger.info('Telegram HITL bridge initialized');
  } else {
    logger.warn('Telegram not configured — HITL approvals will auto-reject');
  }

  // ---------------------------------------------------------------------------
  // Dispatcher → LangGraph handler
  // ---------------------------------------------------------------------------
  async function langGraphHandler(batch: DispatchBatch, threadId: string): Promise<void> {
    const { signals, capitalIntents, marketSnapshot, opportunities } = batch;
    logger.info({ count: signals.length, threadId }, 'Dispatching signals to LangGraph');

    const positionsBefore = [
      ...(await db.getPositionsByState('ACTIVE')),
      ...(await db.getPositionsByState('PENDING_OPEN')),
    ];
    const positionIdsBefore = new Set(positionsBefore.map((position) => position.id));

    const activePositions = (await db.getPositionsByState('ACTIVE')).map((p) => ({
      id: p.id,
      protocol: p.protocol,
      pool_name: p.pool_name,
      pool_id: p.pool_id,
      state: p.state,
      tier: p.tier ?? null,
      deployment_mode: p.deployment_mode ?? null,
      position_style: p.position_style ?? null,
      size_usd: p.size_usd,
      entry_apy: p.entry_apy,
      opened_at: p.opened_at,
    }));

    const runtimeSnapshot = marketSnapshot ?? (await db.getLatestSnapshot() as unknown as MarketSnapshot | null);

    // Route HEARTBEAT-only OR HEARTBEAT+LOW-only batches through the lightweight
    // heartbeat handler. This prevents mixed LOW batches (HEARTBEAT + NEW_HIGH_YIELD_POOL)
    // from triggering the full graph.invoke() which can loop to recursion limit (~8M tokens).
    const isHeartbeat =
      signals.every((s) => s.type === 'HEARTBEAT') ||
      (signals.some((s) => s.type === 'HEARTBEAT') && signals.every((s) => s.priority === 'LOW'));

    if (isHeartbeat) {
      const result = await runHeartbeat(graph, ragStore, db, threadId, {
        currentSignals: signals,
        activePositions,
        marketSnapshot: runtimeSnapshot,
      });
      logger.info({ threadId, outcome: result.outcome, durationMs: result.durationMs }, 'Heartbeat run finished');
      return;
    }

    let supervisorReasoning = '';
    let outcome: 'completed' | 'interrupted' | 'failed' = 'completed';
    let opportunitiesScored: Record<string, any>[] = [];

    try {
      const result = await graph.invoke(
        {
          messages: [{ role: 'user', content: `Process ${signals.length} market signal(s): ${signals.map((s) => s.type).join(', ')}` }],
          currentSignals: signals,
          activePositions,
          marketSnapshot: runtimeSnapshot,
          opportunities,
          capitalIntents,
          pendingActions: [],
          humanDecisions: [],
          lastActiveAgent: null,
          supervisorReasoning: '',
        },
        { configurable: { thread_id: threadId }, recursionLimit: 50 }
      );
      supervisorReasoning = result.supervisorReasoning ?? '';
      opportunitiesScored = result.opportunities ?? [];
      logger.info({ threadId }, 'Graph run completed');
    } catch (err: unknown) {
      const isInterrupt = err instanceof Error && err.constructor.name === 'GraphInterrupt';
      const isRecursion =
        err instanceof Error &&
        (err.message.toLowerCase().includes('recursion limit') ||
          err.constructor.name === 'GraphRecursionError');
      if (isInterrupt) {
        outcome = 'interrupted';
        logger.info({ threadId }, 'Graph paused at interrupt — waiting for Telegram approval');
      } else if (isRecursion) {
        outcome = 'failed';
        logger.warn({ threadId }, 'Graph hit recursion limit — marking signals processed to prevent retry loop');
        // Do NOT rethrow — return normally so dispatcher marks signals processed
      } else {
        outcome = 'failed';
        logger.error({ err, threadId }, 'Graph run failed');
        throw err;
      }
    }

    // Ingest episode into PostgreSQL
    if (outcome !== 'failed') {
      try {
        const regime = runtimeSnapshot?.regime ?? null;
        const positionsAfter = [
          ...(await db.getPositionsByState('ACTIVE')),
          ...(await db.getPositionsByState('PENDING_OPEN')),
        ];
        const newlyCreatedPositions = positionsAfter.filter((position) => !positionIdsBefore.has(position.id));
        const linkedPosition = newlyCreatedPositions.find(
          (position) => position.pool_id === opportunitiesScored[0]?.poolId,
        ) ?? newlyCreatedPositions[0] ?? null;

        // Extract skip decisions (opportunities the agent saw but didn't open)
        for (const opp of opportunitiesScored) {
          if (opp.recommendation === 'SKIP' || opp.recommendation === 'WATCH') {
            // Track high confidence ones where we decided not to invest
            if (opp.score > 40) { // arbitrary threshold for tracking
              await db.insertSkipEpisode({
                skipped_at: new Date().toISOString(),
                pool_id: opp.poolId,
                protocol: opp.protocol,
                pool_name: opp.poolName,
                apy_at_skip: opp.apyUsed,
                score_at_skip: opp.score,
                signal_types: signals.map((s) => s.type).join(','),
                market_regime: regime,
                skip_reason: opp.recommendation === 'WATCH' ? 'watching' : 'scored too low',
                hindsight_apy_after_48h: null,
                hindsight_tvl_change_usd: null,
                grade: null,
              });
            }
          }
        }

        // Figure out primary action taken for the episode record
        let action: 'open' | 'close' | 'rebalance' | 'hold' | 'skip' = 'hold';
        if (capitalIntents.length > 0) {
          if (capitalIntents.every((intent) => intent.action === 'close')) {
            action = 'close';
          } else if (capitalIntents.every((intent) => intent.action === 'claim_fee')) {
            action = 'hold';
          } else {
            action = 'open';
          }
        }
        else if (supervisorReasoning.toLowerCase().includes('open') || outcome === 'interrupted') action = 'open';
        else if (supervisorReasoning.toLowerCase().includes('close')) action = 'close';
        else if (supervisorReasoning.toLowerCase().includes('rebalance')) action = 'rebalance';
        else if (opportunitiesScored.length > 0 && action === 'hold') action = 'skip';

        const totalCapital = activePositions.reduce((s, p) => s + p.size_usd, 0);

        const shouldInsertGenericEpisode =
          capitalIntents.length === 0 && (
            action === 'hold' ||
            action === 'skip' ||
            outcome === 'interrupted' ||
            (action === 'open' && linkedPosition === null)
          );

        if (shouldInsertGenericEpisode) {
          await db.insertDecisionEpisode({
            decision_at: new Date().toISOString(),
            action,
            book: null,
            signal_types: signals.map((s) => s.type).join(','),
            market_regime: regime,
            sol_price_usd: runtimeSnapshot?.solPriceUsd ?? null,
            portfolio_size_usd: totalCapital,
            active_position_count: activePositions.length,
            target_pool_id: opportunitiesScored[0]?.poolId ?? linkedPosition?.pool_id ?? null,
            target_protocol: opportunitiesScored[0]?.protocol ?? linkedPosition?.protocol ?? null,
            target_pool_name: opportunitiesScored[0]?.poolName ?? linkedPosition?.pool_name ?? null,
            position_size_usd: linkedPosition?.size_usd ?? null,
            position_id: linkedPosition?.id ?? null,
            reasoning: linkedPosition?.tier
              ? `${supervisorReasoning} [tier=${linkedPosition.tier}${linkedPosition.deployment_mode ? ` mode=${linkedPosition.deployment_mode}` : ''}${linkedPosition.position_style ? ` style=${linkedPosition.position_style}` : ''}]`
              : supervisorReasoning,
            source: config.paperTrading ? 'paper' : 'live',
            outcome_resolved_at: null,
            outcome_net_pnl_usd: null,
            outcome_realized_apy_pct: null,
            outcome_days_held: null,
            outcome_exit_reason: null,
            outcome_exit_regime: null,
            outcome_exit_sol_price: null,
            grade: null,
            lesson_learned: null,
          });
        }
        
        // Also ingest into RAG vector store for semantic similarity search across future runs
        ingestDecisionLog(ragStore, {
          signalTypes: signals.map((s) => s.type),
          agentReasoning: supervisorReasoning.slice(0, 800),
          actionsDecided: action,
        }).catch((err) => logger.debug({ err }, 'Decision log RAG ingest failed — non-critical'));

        logger.debug({ threadId, action }, 'Decision episode inserted');
      } catch (err) {
        logger.warn({ err }, 'Failed to insert decision episode — non-critical');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Signal Loop — wired to LangGraph via Supervisor
  // ---------------------------------------------------------------------------
  const supervisor = startSupervisedSignalLoop(config, db, connection, kitRpc, reporter);
  const handles = supervisor.getHandles();
  
  if (handles) {
    handles.dispatcher.setDispatchHandler(langGraphHandler);
    logger.info('LangGraph dispatch handler wired');
  }
  
  // Start health server
  startHealthServer(supervisor, 3000);

  function shutdown() {
    logger.info('Shutting down...');
    supervisor.stop();
    void db.close();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info(
    {
      pollIntervalSec: config.polling.data_poll_interval_sec,
      detectIntervalSec: config.polling.signal_detect_interval_sec,
    },
    'Investment Team running. Press Ctrl+C to stop.'
  );
}

main().catch((err: unknown) => {
  logger.error({ err }, 'Fatal error in agent startup');
  process.exit(1);
});
