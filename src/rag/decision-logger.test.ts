import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from '../positions/db.js';
import { logPositionDecisionEpisode } from './decision-logger.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createDb() {
  const dir = mkdtempSync(join(tmpdir(), 'yield-agent-decision-log-'));
  tempDirs.push(dir);
  return new Database(join(dir, 'agent.db'));
}

describe('logPositionDecisionEpisode', () => {
  it('writes a linked position episode with default portfolio context', async () => {
    const db = createDb();

    const opportunity = await db.insertOpportunity({
      protocol: 'jito',
      pool_id: 'pool-1',
      pool_name: 'JitoSOL',
      apy_defillama: 8,
      apy_protocol: 8,
      apy_used: 8,
      data_uncertain: 0,
      tvl_usd: 10_000_000,
      score: 70,
      raw_data: null,
    });

    const position = await db.insertPosition({
      opportunity_id: opportunity.id,
      protocol: opportunity.protocol,
      pool_id: opportunity.pool_id,
      pool_name: opportunity.pool_name,
      state: 'PENDING_OPEN',
      book: 'core',
      base_mint: null,
      size_usd: 75,
      entry_apy: opportunity.apy_used,
      entry_price_sol: null,
      opened_at: null,
      closed_at: null,
      close_reason: null,
      notes: null,
    });

    const episode = await logPositionDecisionEpisode({
      db,
      position,
      action: 'open',
      signalTypes: ['CLI_OPEN'],
      reasoning: 'Opened from test',
      marketRegime: null,
      solPriceUsd: null,
      source: 'paper',
    });

    expect(episode.position_id).toBe(position.id);
    expect(episode.target_pool_id).toBe('pool-1');
    expect(episode.action).toBe('open');
    expect(episode.signal_types).toBe('CLI_OPEN');

    const linked = await db.getEpisodesByPositionId(position.id);
    expect(linked).toHaveLength(1);
    expect(linked[0]?.reasoning).toBe('Opened from test');
  });
});
