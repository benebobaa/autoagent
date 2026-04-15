import { describe, it, expect } from 'vitest';
import { gradeDecision, gradeSkipDecision } from './grader.js';
import type { DecisionEpisode, SkipEpisode } from './decision-types.js';

describe('rule-based decision grader', () => {
  it('grades an open decision EXCELLENT if PnL is highly positive and APY holds', () => {
    const episode: DecisionEpisode = {
      episodeId: 'test-1', decisionAt: new Date().toISOString(),
      signalTypes: ['HIGH_YIELD'], marketRegime: 'BULL_TREND',
      solPriceUsd: 150, portfolioSizeUsd: 1000, activePositionCount: 0,
      action: 'open', reasoning: '...', targetPoolId: 'pool-1',
      targetProtocol: 'protocol-A', targetPoolName: 'name-A',
      positionSizeUsd: 1000, positionId: 'pos-1',
      outcome: {
        resolvedAt: new Date().toISOString(),
        netPnlUsd: 5.0, // Significant
        realizedApyPct: 40,
        daysHeld: 10,
        exitReason: 'manual', exitMarketRegime: 'BULL_TREND', exitSolPriceUsd: 160
      },
      grade: null, lessonLearned: null, source: 'live'
    };
    
    // Add entryApy context (usually tracked in outcome/position, but for grader it uses realized vs expected)
    // Actually, our rule says if realizedApy is high enough compared to... wait, we didn't store entryApy directly in episode, we just used realizedApy. The rule checks outcome.netPnlUsd > expectedYield * 0.7.
    // 1000 * (40/100) * (10/365) = $10.95 expected yield
    // Rule says if netPnl >= 10.95 * 0.7 ($7.66) then EXCELLENT. 
    // Here netPnl is 5.0, so it should be GOOD, not EXCELLENT. Let's adjust to be EXCELLENT so the test matches the intent.
    episode.outcome!.netPnlUsd = 8.0;
    
    expect(gradeDecision(episode)).toBe('EXCELLENT');
  });
  
  it('grades an open decision TERRIBLE if there is a significant loss', () => {
    const episode: DecisionEpisode = {
      episodeId: 'test-2', decisionAt: new Date().toISOString(),
      signalTypes: ['HIGH_YIELD'], marketRegime: 'BULL_TREND',
      solPriceUsd: 150, portfolioSizeUsd: 1000, activePositionCount: 0,
      action: 'open', reasoning: '...', targetPoolId: 'pool-1',
      targetProtocol: 'protocol-A', targetPoolName: 'name-A',
      positionSizeUsd: 1000, positionId: 'pos-1',
      outcome: {
        resolvedAt: new Date().toISOString(),
        netPnlUsd: -50.0, // Lost 5%
        realizedApyPct: -100,
        daysHeld: 1,
        exitReason: 'circuit_breaker', exitMarketRegime: 'BULL_TREND', exitSolPriceUsd: 160
      },
      grade: null, lessonLearned: null, source: 'live'
    };
    expect(gradeDecision(episode)).toBe('TERRIBLE');
  });

  it('grades a skip EXCELLENT if the opportunity crashes', () => {
    const skip: SkipEpisode = {
      episodeId: 'skip-1', skippedAt: new Date().toISOString(),
      poolId: 'pool-x', protocol: 'prot-y', poolName: 'name-y',
      apyAtSkip: 50, scoreAtSkip: 65, signalTypes: ['HIGH_YIELD'], marketRegime: 'BULL_TREND',
      skipReason: 'watching',
      hindsightApyAfter48h: 10, hindsightTvlChangeUsd: -1000000,
      grade: null,
    };
    expect(gradeSkipDecision(skip)).toBe('EXCELLENT');
  });

  it('grades a skip BAD if the opportunity holds its yield', () => {
    const skip: SkipEpisode = {
      episodeId: 'skip-2', skippedAt: new Date().toISOString(),
      poolId: 'pool-x', protocol: 'prot-y', poolName: 'name-y',
      apyAtSkip: 50, scoreAtSkip: 65, signalTypes: ['HIGH_YIELD'], marketRegime: 'BULL_TREND',
      skipReason: 'watching',
      hindsightApyAfter48h: 60, hindsightTvlChangeUsd: 500000,
      grade: null,
    };
    expect(gradeSkipDecision(skip)).toBe('BAD');
  });
});
