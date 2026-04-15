import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from '../positions/db.js';
import { buildExperienceBrief, buildPoolExperienceBrief } from './experience-injector.js';
import type { RAGStore } from './store.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createDb() {
  const dir = mkdtempSync(join(tmpdir(), 'yield-agent-experience-'));
  tempDirs.push(dir);
  return new Database(join(dir, 'agent.db'));
}

function insertEpisode(db: Database, overrides: Partial<Parameters<Database['insertDecisionEpisode']>[0]> = {}) {
  return db.insertDecisionEpisode({
    decision_at: new Date().toISOString(),
    action: 'open',
    book: 'core',
    signal_types: 'CLI_OPEN',
    market_regime: null,
    sol_price_usd: 150,
    portfolio_size_usd: 500,
    active_position_count: 1,
    target_pool_id: 'pool-1',
    target_protocol: 'jito',
    target_pool_name: 'JitoSOL',
    position_size_usd: 50,
    position_id: 'position-1',
    reasoning: 'Opened with discipline',
    source: 'paper',
    outcome_resolved_at: new Date().toISOString(),
    outcome_net_pnl_usd: 2,
    outcome_realized_apy_pct: 9,
    outcome_days_held: 3,
    outcome_exit_reason: 'manual',
    outcome_exit_regime: null,
    outcome_exit_sol_price: 150,
    grade: 'GOOD',
    lesson_learned: 'Stay patient in core book.',
    ...overrides,
  });
}

describe('experience injector', () => {
  it('builds book-specific memory for core decisions', async () => {
    const db = createDb();
    await insertEpisode(db, { book: 'core', lesson_learned: 'Core lesson only.', target_protocol: 'jito' });
    await insertEpisode(db, { book: 'scout', lesson_learned: 'Scout lesson only.', target_protocol: 'jito', outcome_net_pnl_usd: -1, grade: 'BAD' });

    const ragStore = {
      isAvailable: false,
      query: vi.fn(),
    } as unknown as RAGStore;

    const brief = await buildExperienceBrief(db, ragStore, {
      signalTypes: ['HEARTBEAT'],
      regime: null,
      protocol: 'jito',
      book: 'core',
    });

    expect(brief.text).toContain('Core book Recent Lessons');
    expect(brief.text).toContain('Core lesson only.');
    expect(brief.text).not.toContain('Scout lesson only.');
    expect(brief.text).toContain('Core Book Stats');
    db.close();
  });

  it('includes a global core/scout split when no specific book is requested', async () => {
    const db = createDb();
    await insertEpisode(db, { book: 'core', lesson_learned: 'Core lesson only.' });
    await insertEpisode(db, { book: 'scout', lesson_learned: 'Scout lesson only.', outcome_net_pnl_usd: -1, grade: 'BAD' });

    const ragStore = {
      isAvailable: false,
      query: vi.fn(),
    } as unknown as RAGStore;

    const brief = await buildExperienceBrief(db, ragStore, {
      signalTypes: ['HEARTBEAT'],
      regime: null,
    });

    expect(brief.text).toContain('Book Split');
    expect(brief.text).toContain('[core] Core lesson only.');
    expect(brief.text).toContain('[scout] Scout lesson only.');
    db.close();
  });

  it('filters pool experience RAG lookups by book when requested', async () => {
    const db = createDb();
    await insertEpisode(db, { book: 'scout', target_protocol: 'jito' });

    const query = vi.fn().mockResolvedValue([]);
    const ragStore = {
      isAvailable: true,
      query,
    } as unknown as RAGStore;

    await buildPoolExperienceBrief(db, ragStore, 'jito', 'pool-1', 'scout');

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toMatchObject({
      where: {
        $and: [
          { type: { $eq: 'pnl_history' } },
          { book: { $eq: 'scout' } },
        ],
      },
    });
    db.close();
  });
});
