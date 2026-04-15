import type { VectorWhere } from '../storage/types.js';
import type { RAGStore, RAGQueryResult } from './store.js';
import type { Database } from '../positions/db.js';
import type { MarketRegime } from '../signals/regime.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Experience Injector — builds concise context for agent prompts
// ---------------------------------------------------------------------------
// Retrieves relevant past experience from PostgreSQL structured analytics
// and pgvector-backed semantic memory to inject into supervisor + agent prompts.
//
// Design: recency-weighted, capped at ~500 tokens to avoid context bloat.
// ---------------------------------------------------------------------------

export interface ExperienceContext {
  signalTypes: string[];
  regime: MarketRegime | null;
  poolIds?: string[];
  protocol?: string;
  book?: 'core' | 'scout' | null;
}

export interface ExperienceBrief {
  /** Formatted text suitable for injection into an LLM prompt */
  text: string;
  /** Number of relevant lessons found */
  lessonCount: number;
  /** Whether the brief contains any actionable insights */
  hasInsights: boolean;
}

/**
 * Build a concise experience brief for injection into agent prompts.
 * Combines:
 * 1. Recent lessons from PostgreSQL (recency-weighted)
 * 2. Similar past decisions from semantic vector memory
 * 3. Protocol-specific win/loss stats from PostgreSQL
 */
export async function buildExperienceBrief(
  db: Database,
  ragStore: RAGStore,
  context: ExperienceContext
): Promise<ExperienceBrief> {
  const sections: string[] = [];
  let lessonCount = 0;
  const bookLabel = context.book ? `${context.book} book` : null;

  // 1. Recent lessons (recency-weighted from PostgreSQL)
  const recentLessons = context.book
    ? await db.getRecentLessonsByBook(context.book, 5)
    : await db.getRecentLessons(5);
  if (recentLessons.length > 0) {
    const lessonLines = recentLessons.map((l) => {
      const age = daysSince(l.decision_at);
      const recencyTag = age < 7 ? '(recent)' : age < 30 ? '' : '(older)';
      const lessonBook = context.book ? '' : l.book ? `[${l.book}] ` : '';
      return `  • ${lessonBook}${l.lesson_learned} ${recencyTag}`;
    });
    sections.push(`${bookLabel ? `${capitalize(bookLabel)} Recent Lessons` : 'Recent Lessons'}:\n${lessonLines.join('\n')}`);
    lessonCount += recentLessons.length;
  }

  // 2. Protocol-specific performance (structured analytics from PostgreSQL)
  if (context.protocol) {
    const protocolEpisodes = context.book
      ? await db.getEpisodesByProtocolAndBook(context.protocol, context.book, 5)
      : await db.getEpisodesByProtocol(context.protocol, 5);
    if (protocolEpisodes.length > 0) {
      const wins = protocolEpisodes.filter(e => (e.outcome_net_pnl_usd ?? 0) > 0).length;
      const avgPnl = protocolEpisodes.reduce((s, e) => s + (e.outcome_net_pnl_usd ?? 0), 0) / protocolEpisodes.length;
      sections.push(
        `${context.protocol} ${bookLabel ? `${bookLabel} ` : ''}Track Record: ${wins}/${protocolEpisodes.length} wins, avg PnL: $${avgPnl.toFixed(4)}`
      );
    }
  }

  // 3. Regime-specific experience (from PostgreSQL)
  if (context.regime) {
    const regimeEpisodes = await db.getEpisodesByRegime(context.regime, 5);
    if (regimeEpisodes.length > 0) {
      const wins = regimeEpisodes.filter(e => (e.outcome_net_pnl_usd ?? 0) > 0).length;
      const avgPnl = regimeEpisodes.reduce((s, e) => s + (e.outcome_net_pnl_usd ?? 0), 0) / regimeEpisodes.length;
      sections.push(
        `${context.regime} Regime Experience: ${wins}/${regimeEpisodes.length} wins, avg PnL: $${avgPnl.toFixed(4)}`
      );
    }
  }

  // 4. Semantic recall from vector memory (past decisions for similar signals)
  if (ragStore.isAvailable && context.signalTypes.length > 0) {
    try {
      const queryText = `past decisions when signals: ${context.signalTypes.join(', ')}`;
      const filters: VectorWhere[] = [{ type: { $eq: 'lesson_learned' } }];
      if (context.book) {
        filters.push({ book: { $eq: context.book } });
      }
      const where: VectorWhere = filters.length === 1 ? filters[0]! : { $and: filters };
      const ragResults = await ragStore.query(queryText, {
        n: 3,
        where,
      });

      const relevantResults = ragResults.filter(r => r.distance < 0.8);
      if (relevantResults.length > 0) {
        const ragLines = relevantResults.map(r => `  • ${r.text}`);
        sections.push(`Similar Past Situations:\n${ragLines.join('\n')}`);
        lessonCount += relevantResults.length;
      }
    } catch (err) {
      logger.debug({ err }, 'RAG query for experience brief failed — non-critical');
    }
  }

  // 5. Overall stats summary
  const stats = await db.getEpisodeStats();
  if (stats.graded > 0) {
    if (context.book) {
      const bookStats = stats.byBook[context.book];
      if (bookStats) {
        sections.push(
          `${capitalize(context.book)} Book Stats: ${bookStats.count} graded, ${bookStats.winRate.toFixed(0)}% win rate, avg PnL $${bookStats.avgPnl.toFixed(4)}`
        );
      }
    } else {
      const winCount = (stats.byGrade['EXCELLENT'] ?? 0) + (stats.byGrade['GOOD'] ?? 0);
      const lossCount = (stats.byGrade['BAD'] ?? 0) + (stats.byGrade['TERRIBLE'] ?? 0);
      sections.push(
        `Lifetime Stats: ${stats.graded} graded decisions, ${winCount} wins, ${lossCount} losses, ${stats.byGrade['NEUTRAL'] ?? 0} neutral`
      );

      const bookLines = ['core', 'scout'].flatMap((book) => {
        const bookStats = stats.byBook[book];
        if (!bookStats) return [];
        return [`  • ${capitalize(book)}: ${bookStats.count} graded, ${bookStats.winRate.toFixed(0)}% win rate, avg PnL $${bookStats.avgPnl.toFixed(4)}`];
      });

      if (bookLines.length > 0) {
        sections.push(`Book Split:\n${bookLines.join('\n')}`);
      }
    }
  }

  const text = sections.length > 0
    ? `## Institutional Memory\n\n${sections.join('\n\n')}`
    : '';

  return {
    text,
    lessonCount,
    hasInsights: lessonCount > 0,
  };
}

/**
 * Lightweight version for the risk manager — just protocol + pool specific experience.
 */
export async function buildPoolExperienceBrief(
  db: Database,
  ragStore: RAGStore,
  protocol: string,
  poolId: string,
  book?: 'core' | 'scout' | null,
): Promise<string> {
  const lines: string[] = [];

  // Protocol win rate from PostgreSQL
  const protocolEpisodes = book
    ? await db.getEpisodesByProtocolAndBook(protocol, book, 10)
    : await db.getEpisodesByProtocol(protocol, 10);
  if (protocolEpisodes.length > 0) {
    const wins = protocolEpisodes.filter(e => (e.outcome_net_pnl_usd ?? 0) > 0).length;
    const avgHold = protocolEpisodes.reduce((s, e) => s + (e.outcome_days_held ?? 0), 0) / protocolEpisodes.length;
    lines.push(`${protocol}${book ? ` ${book} book` : ''}: ${wins}/${protocolEpisodes.length} wins, avg hold ${avgHold.toFixed(0)}d`);
  }

  // Pool-specific history from RAG
  if (ragStore.isAvailable) {
    try {
      const filters: VectorWhere[] = [{ type: { $eq: 'pnl_history' } }];
      if (book) {
        filters.push({ book: { $eq: book } });
      }
      const where: VectorWhere = filters.length === 1 ? filters[0]! : { $and: filters };
      const results = await ragStore.query(`position performance pool ${poolId} ${protocol}`, {
        n: 3,
        where,
      });
      const relevant = results.filter(r => r.distance < 0.7);
      for (const r of relevant) {
        lines.push(`Past: ${r.text}`);
      }
    } catch {
      // non-critical
    }
  }

  return lines.length > 0 ? lines.join('\n') : '';
}

function daysSince(isoDate: string): number {
  return (Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
