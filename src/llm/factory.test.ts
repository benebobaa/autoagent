import { describe, expect, it } from 'vitest';
import { createLLM } from './factory.js';

describe('createLLM', () => {
  it('creates an OpenRouter-backed chat model', async () => {
    const llm = await createLLM({
      provider: 'openrouter',
      model: 'anthropic/claude-4-sonnet',
      temperature: 0,
      apiKey: 'openrouter-test-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      siteUrl: 'https://yield-agent.example.com',
      siteName: 'Yield Agent',
    });

    const openRouterModel = llm as {
      model?: string;
      apiKey?: string;
      baseURL?: string;
      siteUrl?: string;
      siteName?: string;
      _llmType?: () => string;
    };

    expect(openRouterModel.model).toBe('anthropic/claude-4-sonnet');
    expect(openRouterModel.apiKey).toBe('openrouter-test-key');
    expect(openRouterModel.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(openRouterModel.siteUrl).toBe('https://yield-agent.example.com');
    expect(openRouterModel.siteName).toBe('Yield Agent');
    expect(openRouterModel._llmType?.()).toBe('openrouter');
  });
});
