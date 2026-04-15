import { describe, expect, it } from 'vitest';
import {
  evaluateBaseMintHistoryPolicy,
  evaluateProtocolHistoryPolicy,
  type BaseMintBookStatsMap,
  type ProtocolBookStatsMap,
} from './history-policy.js';

function makeStats(entries: Array<{ protocol: string; book: 'core' | 'scout'; count: number; avgPnl: number; winRate: number }>): ProtocolBookStatsMap {
  const stats: ProtocolBookStatsMap = new Map();
  for (const entry of entries) {
    const existing = stats.get(entry.protocol) ?? {};
    existing[entry.book] = entry;
    stats.set(entry.protocol, existing);
  }
  return stats;
}

const allocator = {
  history_enabled: true,
  core_history_min_samples: 3,
  core_history_min_win_rate_pct: 40,
  core_history_min_avg_pnl_usd: 0,
  scout_history_min_samples: 4,
  scout_bad_win_rate_pct: 20,
  scout_bad_avg_pnl_usd: -1,
};

describe('evaluateHistoryPolicy', () => {
  it('blocks core deployment on sufficiently bad protocol history', () => {
    const result = evaluateProtocolHistoryPolicy('jito', 'core', allocator, makeStats([{ protocol: 'jito', book: 'core', count: 4, avgPnl: -0.5, winRate: 25 }]));

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('blocked by core protocol history');
  });

  it('keeps core deployment neutral on cold-start history', () => {
    const result = evaluateProtocolHistoryPolicy('jito', 'core', allocator, makeStats([{ protocol: 'jito', book: 'core', count: 1, avgPnl: -2, winRate: 0 }]));

    expect(result.allowed).toBe(true);
    expect(result.rankAdjustment).toBe(0);
  });

  it('softly downranks scout deployment on weak but not catastrophic history', () => {
    const result = evaluateProtocolHistoryPolicy('jito', 'scout', allocator, makeStats([{ protocol: 'jito', book: 'scout', count: 5, avgPnl: -0.2, winRate: 35 }]));

    expect(result.allowed).toBe(true);
    expect(result.rankAdjustment).toBeLessThan(0);
    expect(result.reason).toContain('weak scout protocol history');
  });

  it('softly downranks token history separately from protocol history', () => {
    const stats: BaseMintBookStatsMap = new Map([
      ['wen-mint', { scout: { baseMint: 'wen-mint', book: 'scout', count: 5, avgPnl: -0.3, winRate: 30 } }],
    ]);

    const result = evaluateBaseMintHistoryPolicy('wen-mint', 'scout', allocator, stats);

    expect(result.allowed).toBe(true);
    expect(result.rankAdjustment).toBeLessThan(0);
    expect(result.reason).toContain('token');
  });
});
