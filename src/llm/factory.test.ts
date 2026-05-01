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

  it('creates a MiMo-backed OpenAI-compatible chat model', async () => {
    const llm = await createLLM({
      provider: 'mimo',
      model: 'mimo-v2.5',
      temperature: 0.3,
      apiKey: 'mimo-test-key',
      baseUrl: 'https://api.xiaomimimo.com/v1',
    });

    const mimoModel = llm as {
      model?: string;
      modelName?: string;
      apiKey?: string;
      openAIApiKey?: string;
      temperature?: number;
      clientConfig?: { baseURL?: string };
      _llmType?: () => string;
    };

    expect(mimoModel.model ?? mimoModel.modelName).toBe('mimo-v2.5');
    expect(mimoModel.apiKey ?? mimoModel.openAIApiKey).toBe('mimo-test-key');
    expect(mimoModel.temperature).toBe(0.3);
    expect(mimoModel.clientConfig?.baseURL).toBe('https://api.xiaomimimo.com/v1');
    expect(mimoModel._llmType?.()).toBe('openai');
  });
});
