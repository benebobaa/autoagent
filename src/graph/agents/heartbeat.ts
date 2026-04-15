import type { AgentStateType } from '../state.js';
import type { InvestmentTeamGraph } from '../graph.js';
import type { Database } from '../../positions/db.js';
import type { RAGStore } from '../../rag/store.js';
import { logger } from '../../utils/logger.js';
import { gradeSkipDecision, generateSkipLesson } from '../../rag/grader.js';
import type { SkipEpisode } from '../../rag/decision-types.js';

// ---------------------------------------------------------------------------
// Heartbeat handler
//
// HEARTBEAT signals trigger a fixed daily review flow:
//   analyst → risk → reporter (trader only if risk explicitly recommends action)
//
// After the run, the agent's reasoning is ingested into RAG for future recall.
// ---------------------------------------------------------------------------

export interface HeartbeatRunResult {
  threadId: string;
  signalTypes: string[];
  summary: string;
  outcome: 'completed' | 'interrupted' | 'failed';
  durationMs: number;
}

/**
 * Run the daily heartbeat: invoke the graph with a HEARTBEAT signal and
 * ingest the resulting decision log into RAG for future retrieval.
 */
export async function runHeartbeat(
  graph: InvestmentTeamGraph,
  ragStore: RAGStore,
  db: Database,
  threadId: string,
  state: Partial<AgentStateType>
): Promise<HeartbeatRunResult> {
  const start = Date.now();
  const signalTypes = (state.currentSignals ?? []).map((s) => s.type);

  let outcome: HeartbeatRunResult['outcome'] = 'completed';
  let summary = '';

  try {
      const result = await graph.invoke(
      {
        messages: [{ role: 'user', content: 'Daily heartbeat: please review portfolio and send a tier-aware portfolio report when active risk tiers are configured; otherwise send the daily report.' }],
        currentSignals: state.currentSignals ?? [],
        activePositions: state.activePositions ?? [],
        marketSnapshot: state.marketSnapshot ?? null,
        opportunities: [],
        capitalIntents: [],
        pendingActions: [],
        humanDecisions: [],
        lastActiveAgent: null,
        supervisorReasoning: '',
        ...state,
      },
      { configurable: { thread_id: threadId }, recursionLimit: 50 }
    );

    // Extract summary from the last assistant message
    const messages = result.messages ?? [];
    const lastMsg = [...messages].reverse().find((m) => m._getType?.() === 'ai');
    summary = lastMsg
      ? (typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content)).slice(0, 500)
      : 'Heartbeat run completed';

    outcome = 'completed';
  } catch (err: unknown) {
    const isInterrupt = err instanceof Error && err.constructor.name === 'GraphInterrupt';
    if (isInterrupt) {
      outcome = 'interrupted';
      summary = 'Heartbeat interrupted — awaiting human approval for a tier-aware or transactional action';
    } else {
      outcome = 'failed';
      summary = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ err, threadId }, 'Heartbeat graph run failed');
    }
  }

  const durationMs = Date.now() - start;

  // Hindsight Checker: Evaluate skipped episodes older than 48 hours
  try {
    const timeThreshold = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const pendingSkips = await db.getPendingSkips(timeThreshold);
    
    let evaluatedCount = 0;
    for (const skip of pendingSkips) {
      // In a real system, we'd fetch the current APY and TVL for skip.pool_id here.
      // For this MVP, we assume the scanner or another cron job updates the hindsight
      // fields before or during this step. Since we don't have historical lookups 
      // wired for the heartbeat actively right now, we will just grade them if data
      // happens to be populated (e.g. from backtests or scanner updates).
      if (skip.hindsight_apy_after_48h !== null) {
        const fullEpisode = {
          episodeId: skip.id.toString(),
          skippedAt: skip.skipped_at,
          poolId: skip.pool_id,
          protocol: skip.protocol,
          poolName: skip.pool_name,
          apyAtSkip: skip.apy_at_skip,
          scoreAtSkip: skip.score_at_skip,
          signalTypes: skip.signal_types ? skip.signal_types.split(',') : [],
          marketRegime: skip.market_regime,
          skipReason: skip.skip_reason,
          hindsightApyAfter48h: skip.hindsight_apy_after_48h,
          hindsightTvlChangeUsd: skip.hindsight_tvl_change_usd,
          grade: null,
        };
        const grade = gradeSkipDecision(fullEpisode as unknown as SkipEpisode);
        const lesson = generateSkipLesson(fullEpisode as unknown as SkipEpisode);
        
        await db.updateSkipGrade(skip.id, grade);
        
        if (lesson) {
          await ragStore.upsert([{
            id: `lesson:skip-${skip.id}`,
            text: lesson,
            metadata: {
              type: 'lesson_learned',
              grade,
              action: 'skip',
              protocol: skip.protocol,
              date: skip.skipped_at.slice(0, 10),
            }
          }]);
        }
        evaluatedCount++;
      }
    }
    
    if (evaluatedCount > 0) {
      logger.info({ evaluatedCount }, 'Evaluated hindsight outcomes for skipped opportunities');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to run hindsight checker for skips');
  }

  // Ingest the HEARTBEAT decision into PostgreSQL
  try {
    const regime = state.marketSnapshot?.regime ?? null;
    const totalCapital = state.activePositions?.reduce((s: number, p: any) => s + p.size_usd, 0) ?? 0;
    
      await db.insertDecisionEpisode({
      decision_at: new Date().toISOString(),
      action: 'hold', // Heartbeat review
      book: null,
      signal_types: signalTypes.length > 0 ? signalTypes.join(',') : 'HEARTBEAT',
      market_regime: regime,
      sol_price_usd: state.marketSnapshot?.solPriceUsd ?? null,
      portfolio_size_usd: totalCapital,
      active_position_count: state.activePositions?.length ?? 0,
      target_pool_id: null,
      target_protocol: null,
      target_pool_name: null,
      position_size_usd: null,
      position_id: null,
      reasoning: state.supervisorReasoning ?? summary,
      source: 'live',
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
    logger.info({ threadId }, 'Heartbeat decision ingested into PostgreSQL');
  } catch (dbErr) {
    logger.warn({ dbErr }, 'Failed to ingest heartbeat decision — non-critical');
  }

  return { threadId, signalTypes, summary, outcome, durationMs };
}
