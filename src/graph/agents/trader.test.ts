import { describe, expect, it } from 'vitest';
import { TRADER_SYSTEM, formatCapitalIntents } from './trader.js';
import type { CapitalIntent } from '../../portfolio/intents.js';

describe('trader agent prompt', () => {
  it('documents the tier 8/9 paper approval exception', () => {
    expect(TRADER_SYSTEM).toContain('tier 8/9');
    expect(TRADER_SYSTEM).toContain('Telegram HITL gate');
  });

  it('formats open capital intents with tier-aware metadata when present', () => {
    const intent: CapitalIntent = {
      id: 'intent-1',
      action: 'open',
      reason: 'core_allocator',
      createdAt: new Date().toISOString(),
      signalTypes: ['MEME_POOL_DISCOVERED'],
      notes: 'test',
      book: 'core',
      positionId: null,
      opportunityId: 'pool-1',
      poolId: 'pool-1',
      protocol: 'meteora_dlmm',
      poolName: 'MEME-SOL',
      sizeUsd: 50,
      closeReason: null,
      opportunity: {
        poolId: 'pool-1',
        protocol: 'meteora_dlmm',
        poolName: 'MEME-SOL',
        apyDefillama: null,
        apyProtocol: 120,
        apyUsed: 120,
        tvlUsd: 75000,
        dataUncertain: false,
        score: 82,
        apyScore: 0,
        liquidityScore: 0,
        trustScore: 0,
        riskPenalty: 0,
        regimePenalty: 0,
        recommendation: 'SUGGEST',
        raw_data: {
          recommendedTier: 8,
          deploymentMode: 'active',
          positionStyle: 'one_sided_sol',
        },
      },
    };

    const text = formatCapitalIntents([intent]);

    expect(text).toContain('tier=8');
    expect(text).toContain('deploymentMode=active');
    expect(text).toContain('positionStyle=one_sided_sol');
  });
});
