import { describe, expect, it } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createSupervisorNode } from './supervisor.js';
import type { AgentStateType } from './state.js';

function buildState(overrides?: Partial<AgentStateType>): AgentStateType {
  return {
    messages: [],
    currentSignals: [],
    marketSnapshot: null,
    activePositions: [],
    opportunities: [],
    capitalIntents: [],
    pendingActions: [],
    humanDecisions: [],
    lastActiveAgent: null,
    supervisorReasoning: '',
    currentRegime: null,
    ...overrides,
  } as AgentStateType;
}

describe('supervisor fast-path routing', () => {
  const llm = {
    invoke: async () => ({ content: '{"reasoning":"fallback","next":"__end__","instructions":""}' }),
  } as unknown as BaseChatModel;

  const db = {} as never;
  const ragStore = {} as never;
  const supervisor = createSupervisorNode(llm, db, ragStore, 6);

  it('routes active DLMM discovery signals to analyst first', async () => {
    const result = await supervisor(buildState({
      currentSignals: [{
        id: '11111111-1111-1111-1111-111111111111',
        type: 'MEME_POOL_DISCOVERED',
        priority: 'HIGH',
        timestamp: new Date().toISOString(),
        payload: { recommendedTier: 8, confidenceScore: 0.8 },
        dedupKey: 'meme:1',
        processed: false,
        threadId: null,
      }],
    }));

    expect(result).toMatchObject({ goto: ['analyst'] });
  });

  it('routes auto-exit signals to risk first', async () => {
    const result = await supervisor(buildState({
      currentSignals: [{
        id: '22222222-2222-2222-2222-222222222222',
        type: 'POSITION_AUTO_EXIT',
        priority: 'CRITICAL',
        timestamp: new Date().toISOString(),
        payload: { exitReason: 'take_profit', tier: 8 },
        dedupKey: 'exit:1',
        processed: false,
        threadId: null,
      }],
    }));

    expect(result).toMatchObject({ goto: ['risk'] });
  });

  it('routes auto-exit follow-up from risk to trader', async () => {
    const result = await supervisor(buildState({
      lastActiveAgent: 'risk',
      currentSignals: [{
        id: '33333333-3333-3333-3333-333333333333',
        type: 'POSITION_AUTO_EXIT',
        priority: 'CRITICAL',
        timestamp: new Date().toISOString(),
        payload: { exitReason: 'stop_loss', tier: 7 },
        dedupKey: 'exit:2',
        processed: false,
        threadId: null,
      }],
    }));

    expect(result).toMatchObject({ goto: ['trader'] });
  });

  it('walks a tiered discovery sequence analyst -> risk -> trader -> reporter', async () => {
    const signal = {
      id: '44444444-4444-4444-4444-444444444444',
      type: 'MEME_POOL_DISCOVERED' as const,
      priority: 'HIGH' as const,
      timestamp: new Date().toISOString(),
      payload: { recommendedTier: 8, confidenceScore: 0.9 },
      dedupKey: 'meme:flow',
      processed: false,
      threadId: null,
    };

    const first = await supervisor(buildState({ currentSignals: [signal], lastActiveAgent: null }));
    const second = await supervisor(buildState({ currentSignals: [signal], lastActiveAgent: 'analyst' }));
    const third = await supervisor(buildState({ currentSignals: [signal], lastActiveAgent: 'risk' }));
    const fourth = await supervisor(buildState({ currentSignals: [signal], lastActiveAgent: 'trader' }));

    expect(first).toMatchObject({ goto: ['analyst'] });
    expect(second).toMatchObject({ goto: ['risk'] });
    expect(third).toMatchObject({ goto: ['trader'] });
    expect(fourth).toMatchObject({ goto: ['reporter'] });
  });
});
