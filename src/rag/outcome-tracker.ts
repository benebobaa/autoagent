import type { Database, Position } from '../positions/db.js';
import type { RAGStore } from './store.js';
import type { DecisionEpisode, DecisionOutcome } from './decision-types.js';
import type { MarketRegime } from '../signals/regime.js';
import { computeCashFlowPnl } from '../positions/pnl.js';
import { gradeDecision, generateLesson } from './grader.js';
import { ingestPnlHistory } from './ingest.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Outcome Tracker — closes the feedback loop
// ---------------------------------------------------------------------------
// Called when a position transitions to CLOSED.
// 1. Finds the original decision episode(s) for this position
// 2. Computes realized PnL
// 3. Grades the decision
// 4. Updates the episode in PostgreSQL with outcome + grade + lesson
// 5. Ingests the lesson into pgvector-backed memory for semantic recall
// 6. Ingests PnL history into pgvector-backed memory
// ---------------------------------------------------------------------------

export async function trackPositionOutcome(
  db: Database,
  ragStore: RAGStore,
  position: Position,
  closeReason: string,
  currentRegime: MarketRegime | null,
  currentSolPrice: number | null
): Promise<void> {
  const positionId = position.id;

  // 1. Find original decision episodes for this position
  const episodes = await db.getEpisodesByPositionId(positionId);
  if (episodes.length === 0) {
    logger.debug({ positionId }, 'No decision episodes found for position — skipping outcome tracking');
    return;
  }

  // 2. Compute realized PnL
  const cfPnl = computeCashFlowPnl(position);
  const realizedPnl = await db.getRealizedPnl(positionId);

  const netPnlUsd = realizedPnl?.net_pnl_usd ?? cfPnl.cashFlowPnlUsd;
  const realizedApyPct = realizedPnl?.realized_apy_pct ?? position.entry_apy;
  const daysHeld = cfPnl.daysHeld;

  const outcome: DecisionOutcome = {
    resolvedAt: new Date().toISOString(),
    netPnlUsd,
    realizedApyPct,
    daysHeld,
    exitReason: closeReason,
    exitMarketRegime: currentRegime,
    exitSolPriceUsd: currentSolPrice,
  };

  // 3-4. Grade each episode and update in DB
  for (const episodeRow of episodes) {
    // Reconstruct the episode shape the grader expects
    const episode: DecisionEpisode = {
      episodeId: episodeRow.id,
      decisionAt: episodeRow.decision_at,
      signalTypes: episodeRow.signal_types.split(','),
      marketRegime: (episodeRow.market_regime as MarketRegime) ?? null,
      solPriceUsd: episodeRow.sol_price_usd,
      portfolioSizeUsd: episodeRow.portfolio_size_usd,
      activePositionCount: episodeRow.active_position_count,
      action: episodeRow.action,
      book: episodeRow.book,
      reasoning: episodeRow.reasoning,
      targetPoolId: episodeRow.target_pool_id,
      targetProtocol: episodeRow.target_protocol,
      targetPoolName: episodeRow.target_pool_name,
      positionSizeUsd: episodeRow.position_size_usd,
      positionId: episodeRow.position_id,
      outcome,
      grade: null,
      lessonLearned: null,
      source: episodeRow.source,
    };

    const grade = gradeDecision(episode);
    episode.grade = grade;
    const lesson = generateLesson(episode);

    await db.updateEpisodeOutcome(
      episodeRow.id,
      {
        resolvedAt: outcome.resolvedAt,
        netPnlUsd: outcome.netPnlUsd,
        realizedApyPct: outcome.realizedApyPct,
        daysHeld: outcome.daysHeld,
        exitReason: outcome.exitReason,
        exitRegime: outcome.exitMarketRegime ?? null,
        exitSolPrice: outcome.exitSolPriceUsd ?? null,
      },
      grade,
      lesson
    );

    logger.info(
      { episodeId: episodeRow.id, positionId, grade, netPnlUsd: outcome.netPnlUsd },
      'Decision episode graded'
    );

    // 5. Ingest lesson into vector memory
    if (lesson) {
      try {
        await ragStore.upsert([
          {
            id: `lesson:${episodeRow.id}`,
            text: lesson,
            metadata: {
              type: 'lesson_learned',
              grade,
              action: episodeRow.action,
              protocol: episodeRow.target_protocol ?? '',
              regime: episodeRow.market_regime ?? '',
              pnl_usd: outcome.netPnlUsd,
              days_held: outcome.daysHeld,
              book: episodeRow.book ?? '',
              source: episodeRow.source,
              date: outcome.resolvedAt.slice(0, 10),
            },
          },
        ]);
      } catch (err) {
        logger.warn({ err }, 'Failed to ingest lesson into RAG — non-critical');
      }
    }
  }

  // 6. Ingest PnL history into vector memory
  try {
    const latestOpp = (await db.getLatestOpportunities(100)).find((o) => o.pool_id === position.pool_id);
    const currentPoolApy = latestOpp?.apy_used ?? position.entry_apy;

    await ingestPnlHistory(ragStore, {
      positionId,
      protocol: position.protocol,
      poolId: position.pool_id,
      book: position.book,
      entryApy: position.entry_apy,
      exitApy: currentPoolApy,
      daysHeld,
      pnlUsd: netPnlUsd,
      closeReason,
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to ingest PnL history into RAG — non-critical');
  }
}
