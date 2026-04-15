import { describe, expect, it } from 'vitest';
import { formatApprovalMessage } from './telegram-approval.js';

describe('telegram approval formatting', () => {
  it('renders tier-aware create position approvals', () => {
    const text = formatApprovalMessage({
      action: 'create_position',
      message: 'Open meteora_dlmm/MEME-SOL at 180% APY for $50 in scout book?',
      opportunityId: 'pool-1234567890',
      poolName: 'MEME-SOL',
      protocol: 'meteora_dlmm',
      sizeUsd: 50,
      tier: 8,
      score: 82,
      confidenceScore: 0.8,
    });

    expect(text).toContain('Tier 8');
    expect(text).toContain('Score: 82/100');
    expect(text).toContain('Approve: /approve_');
  });

  it('renders execution approvals with tier metadata', () => {
    const text = formatApprovalMessage({
      action: 'execute_transaction',
      message: 'Execute open for meteora_dlmm/MEME-SOL? (Sim: DRY_RUN)',
      protocol: 'meteora_dlmm',
      poolName: 'MEME-SOL',
      tier: 8,
      deploymentMode: 'active',
      positionStyle: 'one_sided_sol',
      txAction: 'open',
    });

    expect(text).toContain('TRANSACTION APPROVAL REQUIRED');
    expect(text).toContain('Tier: 8');
    expect(text).toContain('Style: one_sided_sol');
  });
});
