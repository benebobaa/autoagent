import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

// ---------------------------------------------------------------------------
// Multi-LLM Adapter
// ---------------------------------------------------------------------------
// Uses LangChain's BaseChatModel as the common interface so every agent is
// provider-agnostic. Dynamic imports keep unused SDKs from failing at startup.
// ---------------------------------------------------------------------------

export type LLMProvider = 'anthropic' | 'openai' | 'deepseek' | 'openrouter';

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  temperature?: number;
  apiKey?: string;
  baseUrl?: string;
  siteUrl?: string;
  siteName?: string;
}

// Per-agent overrides (keyed by agent name: 'analyst'|'risk'|'trader'|'reporter'|'supervisor')
export interface AgentLLMConfig {
  default: LLMConfig;
  overrides?: Partial<Record<string, LLMConfig>>;
}

export const DEFAULT_LLM_CONFIG: AgentLLMConfig = {
  default: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    temperature: 0,
  },
};

export async function createLLM(config: LLMConfig): Promise<BaseChatModel> {
  switch (config.provider) {
    case 'anthropic': {
      const { ChatAnthropic } = await import('@langchain/anthropic');
      const apiKey = config.apiKey ?? process.env['ANTHROPIC_API_KEY'];
      return new ChatAnthropic({
        model: config.model,
        temperature: config.temperature ?? 0,
        ...(apiKey !== undefined ? { apiKey } : {}),
      }) as unknown as BaseChatModel;
    }
    case 'openai': {
      const { ChatOpenAI } = await import('@langchain/openai');
      const apiKey = config.apiKey ?? process.env['OPENAI_API_KEY'];
      return new ChatOpenAI({
        model: config.model,
        temperature: config.temperature ?? 0,
        ...(apiKey !== undefined ? { apiKey } : {}),
      }) as unknown as BaseChatModel;
    }
    case 'deepseek': {
      const { ChatDeepSeek } = await import('@langchain/deepseek');
      const apiKey = config.apiKey ?? process.env['DEEPSEEK_API_KEY'];
      return new ChatDeepSeek({
        model: config.model,
        temperature: config.temperature ?? 0,
        ...(apiKey !== undefined ? { apiKey } : {}),
      }) as unknown as BaseChatModel;
    }
    case 'openrouter': {
      const { ChatOpenRouter } = await import('@langchain/openrouter');
      const apiKey = config.apiKey ?? process.env['OPENROUTER_API_KEY'];
      return new ChatOpenRouter({
        model: config.model,
        temperature: config.temperature ?? 0,
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(config.baseUrl !== undefined ? { baseURL: config.baseUrl } : {}),
        ...(config.siteUrl !== undefined ? { siteUrl: config.siteUrl } : {}),
        ...(config.siteName !== undefined ? { siteName: config.siteName } : {}),
      }) as unknown as BaseChatModel;
    }
    default: {
      const _exhaustive: never = config.provider;
      throw new Error(`Unknown LLM provider: ${String(_exhaustive)}`);
    }
  }
}

// Resolves per-agent model overrides and creates the LLM instance.
// Agents call this once at startup; the result is reused for all invocations.
export async function createAgentLLM(
  agentName: string,
  agentLLMConfig: AgentLLMConfig = DEFAULT_LLM_CONFIG
): Promise<BaseChatModel> {
  const override = agentLLMConfig.overrides?.[agentName];
  const resolved = override ?? agentLLMConfig.default;
  return createLLM(resolved);
}
