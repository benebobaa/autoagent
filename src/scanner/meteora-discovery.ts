/**
 * Meteora DLMM Pool Discovery Scanner
 *
 * Uses the Pool Discovery API (pool-discovery-api.datapi.meteora.ag) to find
 * high-yield DLMM pools in the $10k-$150k TVL sweet spot — the range where
 * fee/TVL ratios are highest and competition is lowest.
 *
 * Strategy:
 *  - Server-side filter: mcap, holders, TVL, bin step, fee/TVL ratio, organic score
 *  - Client-side hard skips: global_fees_sol, top-10 concentration, bundlers
 *  - Optional token research for top N candidates (Jupiter DataAPI)
 *  - Returns RawOpportunity[] ready for scoring engine
 */

import axios from 'axios';
import { z } from 'zod';
import type { AgentConfig } from '../config/loader.js';
import type { RawOpportunity } from '../scoring/engine.js';
import { logger } from '../utils/logger.js';
import { researchToken, checkHardSkip } from './token-research.js';

const DISCOVERY_API_BASE = 'https://pool-discovery-api.datapi.meteora.ag';

// ---------------------------------------------------------------------------
// Zod schema — Discovery API response
// ---------------------------------------------------------------------------

const DiscoveryTokenSchema = z.object({
  address: z.string(),
  symbol: z.string(),
  organic_score: z.number().optional().nullable(),
  warnings: z.array(z.union([z.string(), z.record(z.unknown())])).optional().default([]),
  market_cap: z.number().optional().nullable(),
});

const DiscoveryPoolSchema = z.object({
  pool_address: z.string(),
  name: z.string(),
  pool_type: z.string().optional(),
  dlmm_params: z
    .object({ bin_step: z.number() })
    .optional()
    .nullable(),
  fee_pct: z.number().optional().nullable(),
  active_tvl: z.number(),
  fee: z.number(),
  volume: z.number(),
  fee_active_tvl_ratio: z.number(),
  volatility: z.number().optional().nullable(),
  token_x: DiscoveryTokenSchema,
  token_y: DiscoveryTokenSchema,
  base_token_holders: z.number().optional().nullable(),
  pool_price: z.number().optional().nullable(),
  pool_price_change_pct: z.number().optional().nullable(),
  price_trend: z.union([z.string(), z.array(z.unknown())]).optional().nullable(),
  active_positions: z.number().optional().nullable(),
  active_positions_pct: z.number().optional().nullable(),
  open_positions: z.number().optional().nullable(),
  volume_change_pct: z.number().optional().nullable(),
  fee_change_pct: z.number().optional().nullable(),
  swap_count: z.number().optional().nullable(),
  unique_traders: z.number().optional().nullable(),
});

const DiscoveryResponseSchema = z.object({
  data: z.array(DiscoveryPoolSchema),
  total: z.number().optional(),
});

type DiscoveryPool = z.infer<typeof DiscoveryPoolSchema>;

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build the discovery API URL with all server-side filters.
 */
function buildDiscoveryUrl(cfg: AgentConfig['meteora']['discovery'], pageSize: number): string {
  const filters = [
    'base_token_has_critical_warnings=false',
    'quote_token_has_critical_warnings=false',
    'base_token_has_high_single_ownership=false',
    'pool_type=dlmm',
    `base_token_market_cap>=${cfg.min_mcap}`,
    `base_token_market_cap<=${cfg.max_mcap}`,
    `base_token_holders>=${cfg.min_holders}`,
    `volume>=${cfg.min_volume}`,
    `tvl>=${cfg.min_tvl}`,
    `tvl<=${cfg.max_tvl}`,
    `fee_active_tvl_ratio>=${cfg.min_fee_tvl_ratio}`,
    // organic_score is nested inside token_x — filtered client-side below
  ].join('&&');

  return (
    `${DISCOVERY_API_BASE}/pools` +
    `?page_size=${pageSize}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${cfg.timeframe}` +
    `&sort_by=fee_active_tvl_ratio` +
    `&sort_order=desc`
  );
}

// ---------------------------------------------------------------------------
// Main discovery function
// ---------------------------------------------------------------------------

export async function fetchMeteoraDiscoveryOpportunities(
  config: AgentConfig,
  cooledBaseMints: Set<string> = new Set(),
): Promise<RawOpportunity[]> {
  const discovCfg = config.meteora.discovery;
  if (!discovCfg.enabled) return [];

  const PAGE_SIZE = 50;
  const RESEARCH_TOP_N = 10; // How many base tokens to deep-research
  const url = buildDiscoveryUrl(discovCfg, PAGE_SIZE);

  logger.info({ url: url.substring(0, 120) + '...' }, 'Meteora Discovery: fetching pools');

  // ── Fetch with retry ─────────────────────────────────────────────────────
  let rawPools: DiscoveryPool[] = [];
  const delays = [2_000, 4_000, 8_000];

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await axios.get<unknown>(url, { timeout: 15_000 });
      const parsed = DiscoveryResponseSchema.safeParse(res.data);
      if (!parsed.success) {
        logger.warn({ errors: parsed.error.issues.slice(0, 3) }, 'Meteora Discovery: response validation failed');
        break;
      }
      rawPools = parsed.data.data;
      logger.info({ count: rawPools.length }, 'Meteora Discovery: raw pools fetched');
      break;
    } catch (err: unknown) {
      const axErr = err as { response?: { status: number }; message?: string };
      if (axErr.response?.status === 404) {
        logger.warn({ status: 404 }, 'Meteora Discovery: 404 — endpoint may have changed');
        break;
      }
      logger.warn({ message: axErr.message, attempt: attempt + 1 }, 'Meteora Discovery: fetch error');
      if (attempt < delays.length) {
        const delay = delays[attempt]!;
        await sleep(delay);
      }
    }
  }

  if (rawPools.length === 0) {
    logger.warn('Meteora Discovery: no pools returned');
    return [];
  }

  // ── Apply client-side filters ────────────────────────────────────────────
  const blacklist = new Set(config.meteora.discovery.blacklisted_tokens ?? []);
  const afterBlacklist = rawPools.filter((p) => {
    if (cooledBaseMints.has(p.token_x.address)) {
      logger.debug({ mint: p.token_x.address, pool: p.name }, 'Discovery: OOR-cooled token skipped');
      return false;
    }
    if (blacklist.has(p.token_x.address)) {
      logger.debug({ mint: p.token_x.address, pool: p.name }, 'Discovery: blacklisted token skipped');
      return false;
    }
    // Organic score is nested in token_x — apply threshold client-side
    const organicScore = (p.token_x as Record<string, unknown>)['organic_score'];
    if (typeof organicScore === 'number' && organicScore < discovCfg.min_organic_score) {
      logger.debug({ pool: p.name, organicScore }, 'Discovery: organic score too low');
      return false;
    }
    return true;
  });

  // ── Token research for top N candidates ─────────────────────────────────
  // Research the base tokens of the top candidates (sorted by fee/TVL already).
  const toResearch = afterBlacklist.slice(0, RESEARCH_TOP_N);
  const researchResults = await Promise.allSettled(
    toResearch.map((p) => researchToken(p.token_x.address))
  );

  const researchMap = new Map<string, Awaited<ReturnType<typeof researchToken>>>();
  toResearch.forEach((p, i) => {
    const result = researchResults[i];
    if (result?.status === 'fulfilled') {
      researchMap.set(p.token_x.address, result.value);
    }
  });

  // ── Build RawOpportunity[] ───────────────────────────────────────────────
  const results: RawOpportunity[] = [];

  for (const pool of afterBlacklist) {
    const research = researchMap.get(pool.token_x.address) ?? null;

    // Apply hard-skip checks when research data is available
    if (research) {
      const skip = checkHardSkip(research, {
        minGlobalFeesSol: discovCfg.min_global_fees_sol,
        maxTop10Pct: discovCfg.max_top10_holder_pct,
        maxBundlerPct: discovCfg.max_bundler_pct,
        blacklistedLaunchpads: discovCfg.blacklisted_launchpads ?? ['pump.fun', 'letsbonk.fun'],
      });

      if (skip.skip) {
        logger.debug({ pool: pool.name, reason: skip.reason }, 'Discovery: hard skip');
        continue;
      }
    }

    // Compute apyUsed from fee_active_tvl_ratio
    // fee_active_tvl_ratio is expressed as a percent (e.g., 0.05 = 0.05% fee/TVL in window).
    // We treat this directly as an APY proxy: ratio * 100 → maps to our scoring range.
    // A ratio of 0.05 → 5% APY, 0.5 → 50% APY. This keeps relative ordering correct.
    const apyUsed = pool.fee_active_tvl_ratio * 100;

    // tvlUsd: use active_tvl (only the liquidity actually earning fees)
    const tvlUsd = pool.active_tvl;

    // Organic score from discovery API
    const organicScore = pool.token_x.organic_score ?? null;

    // Smart wallet presence from deep research
    const hasSmartWallet =
      (research?.holders?.smartWalletsHolding?.length ?? 0) > 0;

    // Holder data
    const top10HolderPct = research?.holders?.top10Pct ?? null;
    const bundlerPct = research?.holders?.bundlerPct ?? null;
    const globalFeesSol = research?.info?.globalFeesSol ?? null;

    results.push({
      poolId: pool.pool_address,
      protocol: 'meteora_dlmm',
      poolName: `Meteora DLMM: ${pool.name}`,
      apyDefillama: null,   // discovery API doesn't cross-ref DefiLlama
      apyProtocol: apyUsed,
      apyUsed,
      tvlUsd,
      dataUncertain: false, // discovery API is authoritative for these pools
      raw_data: {
        // discovery metadata
        isDiscovery: true,
        feeTvlRatio: pool.fee_active_tvl_ratio,
        fee24h: pool.fee,
        volume24h: pool.volume,
        volatility: pool.volatility ?? null,
        binStep: pool.dlmm_params?.bin_step ?? null,
        feePct: pool.fee_pct ?? null,
        organicScore,
        holderCount: pool.base_token_holders ?? null,
        mcap: pool.token_x.market_cap ?? null,
        tokenA: pool.token_x.symbol,
        tokenB: pool.token_y.symbol,
        tokenAMint: pool.token_x.address,
        tokenBMint: pool.token_y.address,
        baseMint: pool.token_x.address,
        currentPrice: pool.pool_price ?? null,
        priceChangePct: pool.pool_price_change_pct ?? null,
        priceTrend: pool.price_trend ?? null,
        activePositions: pool.active_positions ?? null,
        activePositionsPct: pool.active_positions_pct ?? null,
        volumeChangePct: pool.volume_change_pct ?? null,
        feeChangePct: pool.fee_change_pct ?? null,
        swapCount: pool.swap_count ?? null,
        uniqueTraders: pool.unique_traders ?? null,
        // Token research results
        globalFeesSol,
        top10HolderPct,
        bundlerPct,
        hasSmartWallet,
        narrativeFetched: research !== null,
        // Scoring hints
        needs_sdk_bin_check: true,
      },
    });
  }

  logger.info(
    { returned: results.length, totalFetched: rawPools.length, afterBlacklist: afterBlacklist.length },
    'Meteora Discovery: opportunities ready'
  );

  return results;
}
