import { z } from 'zod';
import type { AgentConfig } from '../config/loader.js';
import { type DefiLlamaPool, findLlamaPool } from './defillama.js';
import type { RawOpportunity } from '../scoring/engine.js';
import { logger } from '../utils/logger.js';
import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchMeteoraDiscoveryOpportunities } from './meteora-discovery.js';

// ---------------------------------------------------------------------------
// Zod schemas for Meteora DLMM API (dlmm.datapi.meteora.ag)
// ---------------------------------------------------------------------------

const MeteoraTokenSchema = z.object({
  address: z.string(),
  symbol: z.string(),
  decimals: z.number(),
  price: z.number().optional(),
});

const MeteoraPoolConfigSchema = z.object({
  bin_step: z.number(),
  base_fee_pct: z.number(),
  max_fee_pct: z.number(),
  protocol_fee_pct: z.number(),
});

const MeteoraVolumeSchema = z.object({
  '30m': z.number().optional(),
  '1h': z.number().optional(),
  '2h': z.number().optional(),
  '4h': z.number().optional(),
  '12h': z.number().optional(),
  '24h': z.number().optional(),
});

const MeteoraFeesSchema = z.object({
  '30m': z.number().optional(),
  '1h': z.number().optional(),
  '2h': z.number().optional(),
  '4h': z.number().optional(),
  '12h': z.number().optional(),
  '24h': z.number().optional(),
});

const MeteoraPoolSchema = z.object({
  address: z.string(),
  name: z.string(),
  token_x: MeteoraTokenSchema,
  token_y: MeteoraTokenSchema,
  pool_config: MeteoraPoolConfigSchema,
  dynamic_fee_pct: z.number().optional(),
  tvl: z.number(),
  apr: z.number().optional(),
  apy: z.number().optional(),
  volume: MeteoraVolumeSchema.optional(),
  fees: MeteoraFeesSchema.optional(),
  fee_tvl_ratio: MeteoraFeesSchema.optional(),
  current_price: z.number(),
  reserve_x: z.string().optional(),
  reserve_y: z.string().optional(),
  created_at: z.number().optional(),
  is_blacklisted: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});

const MeteoraPaginatedResponseSchema = z.object({
  pages: z.number(),
  current_page: z.number(),
  page_size: z.number(),
  data: z.array(MeteoraPoolSchema),
});

export type MeteoraPoolResponse = z.infer<typeof MeteoraPoolSchema>;
export type MeteoraApiResponse = z.infer<typeof MeteoraPaginatedResponseSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assessBinStep(binStep: number, pairName: string, config: AgentConfig): string {
  const upperPair = pairName.toUpperCase();
  const rules = config.meteora.bin_step_rules;

  if (upperPair.includes('USDC') && upperPair.includes('USDT')) {
    if (binStep > rules.stablecoin_pairs.max_bin_step) return 'inappropriate (too wide for stable)';
    return 'good (stable)';
  }

  if (upperPair.includes('SOL') || upperPair.includes('ETH') || upperPair.includes('BTC') || upperPair.includes('CBTC')) {
    if (binStep > rules.bluechip_pairs.max_bin_step) return 'inappropriate (too wide for bluechip)';
    return 'good (bluechip)';
  }

  if (binStep > rules.volatile_pairs.max_bin_step) return 'inappropriate (too wide for volatile)';
  return 'good (volatile)';
}

// ---------------------------------------------------------------------------
// Fallback logic
// ---------------------------------------------------------------------------

function meteoraDefiLlamaFallback(
  llamaPools: Map<string, DefiLlamaPool>,
  config: AgentConfig
): RawOpportunity[] {
  const results: RawOpportunity[] = [];

  for (const pool of llamaPools.values()) {
    if (pool.project !== 'meteora-dlmm') continue;

    const pairMatchesAllowed = config.meteora.allowed_pairs.some(
      (pair) => pair === pool.symbol || pool.symbol?.includes(pair)
    );
    if (!pairMatchesAllowed) continue;

    if ((pool.apy ?? 0) < config.meteora.min_fee_apr * 100) continue;
    if (pool.tvlUsd < config.meteora.min_tvl_usd) continue;

    results.push({
      poolId: pool.pool,
      protocol: 'meteora_dlmm',
      poolName: `Meteora DLMM: ${pool.symbol}`,
      apyDefillama: pool.apy,
      apyProtocol: null,
      apyUsed: pool.apy ?? 0,
      tvlUsd: pool.tvlUsd,
      dataUncertain: true,
    });
  }

  logger.info({ count: results.length }, 'Meteora DefiLlama fallback used');
  return results;
}

// ---------------------------------------------------------------------------
// Main Scanner
// ---------------------------------------------------------------------------

export async function fetchMeteoraOpportunities(
  llamaPools: Map<string, DefiLlamaPool>,
  config: AgentConfig,
  cooledBaseMints: Set<string> = new Set(),
): Promise<RawOpportunity[]> {
  if (!config.meteora.enabled) return [];

  // Discovery mode: run BOTH standard and discovery scans, then merge.
  // Standard scan finds high-TVL established pools; discovery finds new high-fee pools.
  if (config.meteora.discovery.enabled) {
    logger.info('Meteora: running standard + discovery mode (merged)');
    const [standard, discovery] = await Promise.allSettled([
      fetchStandardMeteoraOpportunities(llamaPools, config),
      fetchMeteoraDiscoveryOpportunities(config, cooledBaseMints),
    ]);
    const standardPools = standard.status === 'fulfilled' ? standard.value : [];
    const discoveryPools = discovery.status === 'fulfilled' ? discovery.value : [];
    if (standard.status === 'rejected') logger.warn({ err: standard.reason }, 'Meteora standard scan failed in merged mode');
    if (discovery.status === 'rejected') logger.warn({ err: discovery.reason }, 'Meteora discovery scan failed in merged mode');
    // Deduplicate by poolId — prefer standard data when available
    const seen = new Set(standardPools.map((p) => p.poolId));
    const merged = [...standardPools, ...discoveryPools.filter((p) => !seen.has(p.poolId))];
    logger.info({ standard: standardPools.length, discovery: discoveryPools.length, merged: merged.length }, 'Meteora merged scan complete');
    return merged;
  }

  return fetchStandardMeteoraOpportunities(llamaPools, config);
}

async function fetchStandardMeteoraOpportunities(
  llamaPools: Map<string, DefiLlamaPool>,
  config: AgentConfig
): Promise<RawOpportunity[]> {
  const baseUrl = config.meteoraApiBaseUrl;
  const PAGE_SIZE = 50;
  const MAX_PAGES_PER_PAIR = 3; // 150 pools max per pair — more than enough
  const delays = [2_000, 4_000, 8_000];

  // Query each allowed pair individually, sorted by TVL descending.
  // The Meteora DLMM API has 100k+ pools — paginating all of them is impractical.
  // Using ?query={pair}&sort_by=tvl:desc&page_size=50 gets the highest-liquidity
  // instances of each named pair efficiently without scanning the entire pool list.
  const allPools: MeteoraPoolResponse[] = [];
  const seenAddresses = new Set<string>();

  for (const pair of config.meteora.allowed_pairs) {
    const pairPools: MeteoraPoolResponse[] = [];
    let page = 1;
    let totalPages = 1;

    paginationLoop: while (page <= Math.min(totalPages, MAX_PAGES_PER_PAIR)) {
      const url = `${baseUrl}/pools?query=${encodeURIComponent(pair)}&sort_by=tvl:desc&page=${page}&page_size=${PAGE_SIZE}`;
      logger.debug({ url, pair, page }, 'Fetching Meteora DLMM pools (standard)');

      let succeeded = false;
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
          const response = await axios.get<MeteoraApiResponse>(url, { timeout: 15_000 });
          const parsed = MeteoraPaginatedResponseSchema.safeParse(response.data);
          if (!parsed.success) {
            logger.warn({ pair, errors: parsed.error.issues }, 'Meteora API response validation failed');
            break paginationLoop;
          }
          pairPools.push(...parsed.data.data);
          totalPages = parsed.data.pages;
          succeeded = true;
          break;
        } catch (err: any) {
          if (err.response?.status === 404) {
            logger.warn({ baseUrl, pair, status: 404 }, 'Meteora API 404 — endpoint may have changed');
            break paginationLoop;
          }
          logger.warn({ err: err.message, pair, attempt: attempt + 1 }, 'Meteora API error');
          if (attempt < delays.length) {
            await sleep(delays[attempt]!);
          } else {
            break paginationLoop;
          }
        }
      }
      if (!succeeded) break;
      page++;
    }

    logger.debug({ pair, fetched: pairPools.length }, 'Meteora standard pair fetched');
    for (const pool of pairPools) {
      if (!seenAddresses.has(pool.address)) {
        seenAddresses.add(pool.address);
        allPools.push(pool);
      }
    }
  }

  if (allPools.length === 0) {
    logger.warn('Meteora standard scan returned no pools — using DefiLlama fallback');
    return meteoraDefiLlamaFallback(llamaPools, config);
  }

  const results: RawOpportunity[] = [];

  for (const raw of allPools) {
    const pool = raw;

    // Filter by allowed pairs — check both forward and reversed token order
    // e.g. "USDC-SOL" should match allowed pair "SOL-USDC"
    const reversedName = pool.name?.split('-').reverse().join('-') ?? '';
    const pairMatchesAllowed = config.meteora.allowed_pairs.some(
      (pair) => pool.name?.includes(pair) || reversedName.includes(pair)
    );
    if (!pairMatchesAllowed) continue;

    // TVL
    const tvlUsd = pool.tvl ?? 0;
    if (tvlUsd < config.meteora.min_tvl_usd) continue;

    // Use APR from API directly (annualized fee revenue / TVL)
    const feeApr24h = (pool.apr ?? 0) as number;
    const apyPct = feeApr24h * 100;

    if (apyPct < config.meteora.min_fee_apr * 100) continue;

    // Bin step check
    const binStep = pool.pool_config?.bin_step ?? 0;
    const binStepAssessment = assessBinStep(binStep, pool.name, config);
    if (binStepAssessment.includes('inappropriate')) {
      logger.debug({ pool: pool.name, binStep }, 'Skipping pool: inappropriate bin step');
      continue;
    }

    // Volume 24h
    const volume24hUsd = pool.volume?.['24h'] ?? 0;

    // Fees 24h
    const fees24hUsd = pool.fees?.['24h'] ?? 0;

    // Cross-reference with DefiLlama
    const llamaPool = findLlamaPool(llamaPools, 'meteora-dlmm', pool.name);
    const apyDefillama = llamaPool?.apy ?? null;

    const diffPct = apyDefillama !== null
      ? Math.abs(apyDefillama - apyPct) / Math.max(apyPct, 0.001) * 100
      : null;

    const dataUncertain = apyDefillama === null || (diffPct ?? 0) > config.scoring.data_uncertainty_threshold_pct;

    // Token symbols for raw_data
    const tokenASymbol = pool.token_x?.symbol ?? '';
    const tokenBSymbol = pool.token_y?.symbol ?? '';

    // fee_tvl_ratio.24h is a bin-activity proxy: low ratio + high vol = bins may be thin
    // See METEORA_BIN_LIQUIDITY_THIN signal logic in detector.ts
    const feeTvlRatio24h = pool.fee_tvl_ratio?.['24h'] ?? null;

    results.push({
      poolId: pool.address,
      protocol: 'meteora_dlmm',
      poolName: `Meteora DLMM: ${pool.name}`,
      apyDefillama,
      apyProtocol: apyPct,
      apyUsed: apyPct,
      tvlUsd,
      dataUncertain,
      raw_data: {
        binStep,
        feeApr24h,
        volume24hUsd,
        fees24hUsd,
        currentPrice: pool.current_price,
        dynamicFeePct: pool.dynamic_fee_pct,
        baseFeePct: pool.pool_config?.base_fee_pct,
        tokenA: tokenASymbol,
        tokenB: tokenBSymbol,
        tokenAMint: pool.token_x?.address,
        tokenBMint: pool.token_y?.address,
        baseMint: pool.token_x?.address ?? null,
        tokenAPriceUsd: pool.token_x?.price,
        tokenBPriceUsd: pool.token_y?.price,
        feeTvlRatio24h,
        // Lazy evaluation: bin liquidity requires on-chain SDK call. Proxy available now;
        // real bin liquidity fetched on-demand in scan_meteora_pools tool.
        needs_sdk_bin_check: true,
      },
    });
  }

  logger.info({ count: results.length, totalScanned: allPools.length }, 'Meteora opportunities fetched');
  return results;
}

// ---------------------------------------------------------------------------
// On-demand SDK helpers (lazy evaluation — only call when actually needed)
// ---------------------------------------------------------------------------


/**
 * Fetches real bin liquidity around the active bin via on-chain SDK call.
 * Use this when evaluating a specific pool for entry/rebalance decision.
 *
 * Returns liquidity distribution and total in-range depth.
 * Falls back to null on SDK error (does not crash — log and continue).
 */
export async function fetchMeteoraBinLiquidity(
  poolAddress: string,
  connection: import('@solana/web3.js').Connection,
  binsAroundActive = 5
): Promise<{ activeBinId: number; totalLiquidityInRange: number; binLiquidityMap: Map<number, number> } | null> {
  try {
    const { PublicKey } = await import('@solana/web3.js');
    const DLMM = (await import('@meteora-ag/dlmm')).default;
    const poolKey = new PublicKey(poolAddress);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const DLMMClass = DLMM as any;
    const dlmm = await DLMMClass.create(connection, poolKey);
    const activeBin = await dlmm.getActiveBin();
    const { bins } = await dlmm.getBinsAroundActiveBin(binsAroundActive);

    const binLiquidityMap = new Map<number, number>();
    let totalLiquidityInRange = 0;
    for (const bin of bins) {
      const liq = Number(bin.liquidity);
      binLiquidityMap.set(bin.binId, liq);
      totalLiquidityInRange += liq;
    }

    logger.debug(
      { poolAddress, activeBinId: activeBin.binId, totalLiquidityInRange, binCount: bins.length },
      'Fetched Meteora bin liquidity via SDK'
    );

    return {
      activeBinId: activeBin.binId,
      totalLiquidityInRange,
      binLiquidityMap,
    };
  } catch (err) {
    logger.warn({ poolAddress, err }, 'Failed to fetch Meteora bin liquidity via SDK');
    return null;
  }
}
