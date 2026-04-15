import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { loadConfig, resetConfig } from './loader.js';

const originalEnv = {
  ...process.env,
};

function writeTempConfig(transform: (base: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), 'yield-agent-config-'));
  const filePath = join(dir, 'agent_config.yaml');
  const base = readFileSync(resolve(process.cwd(), 'agent_config.yaml'), 'utf-8');
  writeFileSync(filePath, transform(base), 'utf-8');
  return filePath;
}

afterEach(() => {
  resetConfig();
  process.env = { ...originalEnv };
});

describe('loadConfig', () => {
  it('injects the OpenRouter key and attribution fields for the default provider', () => {
    process.env['SOLANA_RPC_URL'] = 'https://example.invalid';
    process.env['DATABASE_URL'] = 'postgresql://yield_agent:yield_agent@localhost:5432/yield_agent';
    process.env['OPENROUTER_API_KEY'] = 'openrouter-test-key';
    process.env['OPENROUTER_SITE_URL'] = 'https://yield-agent.example.com';
    process.env['OPENROUTER_SITE_NAME'] = 'Yield Agent';
    process.env['OPENROUTER_BASE_URL'] = 'https://openrouter.ai/api/v1';

    const configPath = writeTempConfig((base) =>
      base
        .replace('provider: deepseek', 'provider: openrouter')
        .replace('model: deepseek-reasoner', 'model: anthropic/claude-4-sonnet')
        .replace('temperature: 1   # reasoner models require temperature=1', 'temperature: 0'),
    );

    try {
      const config = loadConfig(configPath);

      expect(config.llm.default.provider).toBe('openrouter');
      expect(config.llm.default.apiKey).toBe('openrouter-test-key');
      expect(config.llm.default.baseUrl).toBe('https://openrouter.ai/api/v1');
      expect(config.llm.default.siteUrl).toBe('https://yield-agent.example.com');
      expect(config.llm.default.siteName).toBe('Yield Agent');
    } finally {
      rmSync(dirname(configPath), { recursive: true, force: true });
    }
  });

  it('injects the OpenRouter key for per-agent overrides', () => {
    process.env['SOLANA_RPC_URL'] = 'https://example.invalid';
    process.env['DATABASE_URL'] = 'postgresql://yield_agent:yield_agent@localhost:5432/yield_agent';
    process.env['OPENROUTER_API_KEY'] = 'openrouter-override-key';

    const configPath = writeTempConfig((base) =>
      base.replace(
        /llm:\n  default:\n    provider: deepseek\n    model: deepseek-reasoner\n    temperature: 1   # reasoner models require temperature=1\n(?:[\s\S]*?)# Polling intervals \(Tier 1 \+ Tier 2\)/,
        `llm:
  default:
    provider: anthropic
    model: claude-sonnet-4-20250514
    temperature: 0
  overrides:
    reporter:
      provider: openrouter
      model: openai/gpt-4o-mini
      temperature: 0

# Polling intervals (Tier 1 + Tier 2)`,
      ),
    );

    try {
      const config = loadConfig(configPath);

      expect(config.llm.default.provider).toBe('anthropic');
      expect(config.llm.overrides?.['reporter']?.provider).toBe('openrouter');
      expect(config.llm.overrides?.['reporter']?.apiKey).toBe('openrouter-override-key');
    } finally {
      rmSync(dirname(configPath), { recursive: true, force: true });
    }
  });
});
