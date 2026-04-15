import axios from 'axios';
import { z } from 'zod';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const DefiLlamaPoolSchema = z.object({
  pool: z.string(),
  chain: z.string(),
  project: z.string(),
  symbol: z.string(),
  tvlUsd: z.number(),
  apy: z.number().nullable(),
  apyBase: z.number().nullable(),
  apyReward: z.number().nullable().optional(),
  apyMean30d: z.number().nullable().optional(),
  il7d: z.number().nullable().optional(),
  rewardTokens: z.array(z.string()).nullable().optional(),
  underlyingTokens: z.array(z.string()).nullable().optional(),
  poolMeta: z.string().nullable().optional(),
});

export type DefiLlamaPool = z.infer<typeof DefiLlamaPoolSchema>;

const DefiLlamaResponseSchema = z.object({
  status: z.literal('success'),
  data: z.array(DefiLlamaPoolSchema),
});

const DefiLlamaChartPointSchema = z.object({
  timestamp: z.string(),
  tvlUsd: z.number(),
  apy: z.number(),
  apyBase: z.number().nullable().optional(),
  apyReward: z.number().nullable().optional(),
});

export type DefiLlamaChartPoint = z.infer<typeof DefiLlamaChartPointSchema>;

const DefiLlamaChartResponseSchema = z.object({
  status: z.literal('success'),
  data: z.array(DefiLlamaChartPointSchema),
});

// ---------------------------------------------------------------------------
// Known project slugs on DefiLlama for our protocols
// ---------------------------------------------------------------------------

export const DEFILLAMA_PROJECTS = new Set([
  'kamino-lend',
  'kamino-liquidity',
  'marginfi-lst',
  'jito-liquid-staking',
  'meteora-dlmm',
]);

// ---------------------------------------------------------------------------
// Fetch all Solana pools from DefiLlama
// ---------------------------------------------------------------------------

export async function fetchDefiLlamaPools(
  baseUrl: string
): Promise<Map<string, DefiLlamaPool>> {
  try {
    const resp = await axios.get<unknown>(`${baseUrl}/pools`, {
      timeout: 30_000,
    });

    const parsed = DefiLlamaResponseSchema.safeParse(resp.data);
    if (!parsed.success) {
      logger.error({ errors: parsed.error.issues }, 'DefiLlama /pools response validation failed');
      return new Map();
    }

    const solanaPools = parsed.data.data.filter(
      (p) => p.chain === 'Solana' && DEFILLAMA_PROJECTS.has(p.project)
    );

    logger.info({ count: solanaPools.length }, 'DefiLlama Solana pools fetched');

    return new Map(solanaPools.map((p) => [p.pool, p]));
  } catch (err) {
    logger.error({ err }, 'Failed to fetch DefiLlama pools');
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Fetch historical chart data for a single pool (used by backtest runner)
// ---------------------------------------------------------------------------

export async function fetchPoolHistory(
  poolId: string,
  baseUrl: string
): Promise<DefiLlamaChartPoint[]> {
  try {
    const resp = await axios.get<unknown>(`${baseUrl}/chart/${poolId}`, {
      timeout: 30_000,
    });

    const parsed = DefiLlamaChartResponseSchema.safeParse(resp.data);
    if (!parsed.success) {
      logger.warn({ poolId, errors: parsed.error.issues }, 'DefiLlama chart validation failed');
      return [];
    }

    return parsed.data.data;
  } catch (err) {
    const e = err as { code?: string; message?: string; response?: { status?: number } };
    logger.warn({ poolId, code: e.code, status: e.response?.status, message: e.message }, 'Failed to fetch DefiLlama pool history');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the best-matching DefiLlama pool for a given symbol + project slug.
 * Tries exact project match first, then fuzzy symbol match.
 */
export function findLlamaPool(
  pools: Map<string, DefiLlamaPool>,
  project: string,
  symbol: string
): DefiLlamaPool | undefined {
  const symbolLower = symbol.toLowerCase();

  // Exact project + symbol match
  for (const pool of pools.values()) {
    if (pool.project === project && pool.symbol.toLowerCase() === symbolLower) {
      return pool;
    }
  }

  // Partial symbol match within project
  for (const pool of pools.values()) {
    if (
      pool.project === project &&
      (pool.symbol.toLowerCase().includes(symbolLower) ||
        symbolLower.includes(pool.symbol.toLowerCase()))
    ) {
      return pool;
    }
  }

  return undefined;
}
