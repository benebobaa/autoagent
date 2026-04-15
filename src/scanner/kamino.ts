import { KaminoMarket } from '@kamino-finance/klend-sdk';
import { address as kitAddress, type Slot } from '@solana/kit';
import type { AgentConfig } from '../config/loader.js';
import { type DefiLlamaPool, findLlamaPool } from './defillama.js';
import type { RawOpportunity } from '../scoring/engine.js';
import { logger } from '../utils/logger.js';
import { createSolanaRpc } from '@solana/rpc';

// Use the actual return type of createSolanaRpc to avoid complex union narrowing
type KitRpc = ReturnType<typeof createSolanaRpc>;

// Kamino main lending market on mainnet
const KAMINO_MAIN_MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';

// ---------------------------------------------------------------------------
// Kamino Lending
// ---------------------------------------------------------------------------

export async function fetchKaminoLendingOpportunities(
  rpc: KitRpc,
  llamaPools: Map<string, DefiLlamaPool>,
  config: AgentConfig
): Promise<RawOpportunity[]> {
  if (!config.protocols.kamino_lending.enabled) return [];

  try {
    const marketAddress = kitAddress(KAMINO_MAIN_MARKET);
    const recentSlotDurationMs = 400; // ~400ms per slot on Solana

    // KaminoMarket.load expects Rpc<KaminoMarketRpcApi> which is a subset of SolanaRpcApi
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const market = await Promise.race([
      KaminoMarket.load(rpc as any, marketAddress, recentSlotDurationMs, undefined, true),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error('KaminoMarket.load timeout')), 20_000)
      ),
    ]);

    if (!market) {
      logger.warn('KaminoMarket.load returned null');
      return [];
    }

    // Get current slot for APY calculation
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slotResponse = await (rpc as any).getSlot().send();
    const currentSlot = slotResponse as Slot;

    const reserves = market.getReserves();
    logger.debug({ reserveCount: reserves.length }, 'Kamino lending reserves loaded');

    const results: RawOpportunity[] = [];

    for (const reserve of reserves) {
      try {
        const symbol = reserve.symbol;
        const tvlUsd = reserve.getDepositTvl().toNumber();

        // totalSupplyAPY returns a decimal multiplier (e.g. 0.08 for 8%)
        const apyDecimal = reserve.totalSupplyAPY(currentSlot);
        const apyPct = apyDecimal * 100;

        logger.debug({ symbol, apyPct, tvlUsd }, 'Kamino reserve raw data');

        // Apply filters (let scoring engine do final ranking, but filter hard zeros)
        if (tvlUsd < config.scoring.min_tvl_usd) continue;
        if (apyPct < config.scoring.min_apy_pct) continue;

        const llamaPool = findLlamaPool(llamaPools, 'kamino-lend', symbol);

        const apyDefillama = llamaPool?.apy ?? null;
        const dataUncertain =
          apyDefillama === null
            ? true
            : (Math.abs(apyDefillama - apyPct) / Math.max(apyPct, 0.001)) * 100 >
              config.scoring.data_uncertainty_threshold_pct;

        results.push({
          poolId: llamaPool?.pool ?? `kamino-lending-${reserve.address.toString()}`,
          protocol: 'kamino_lending',
          poolName: `Kamino Lending: ${symbol}`,
          apyDefillama,
          apyProtocol: apyPct,
          apyUsed: apyPct,
          tvlUsd,
          dataUncertain: apyDefillama === null ? true : dataUncertain,
        });
      } catch (err) {
        logger.warn({ symbol: reserve.symbol, err }, 'Failed to process Kamino reserve');
      }
    }

    logger.info({ count: results.length }, 'Kamino lending opportunities fetched');
    return results;
  } catch (err) {
    logger.error({ err }, 'Kamino lending scanner failed');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Kamino Vaults — DefiLlama-only (kliquidity-sdk poolMeta is always null)
// ---------------------------------------------------------------------------

export async function fetchKaminoVaultOpportunities(
  _rpc: KitRpc,
  llamaPools: Map<string, DefiLlamaPool>,
  config: AgentConfig
): Promise<RawOpportunity[]> {
  if (!config.protocols.kamino_vaults.enabled) return [];

  // kliquidity-sdk strategy addresses do not match DefiLlama pool IDs (poolMeta is null).
  // Use DefiLlama kamino-liquidity pools directly as the single source of truth.
  const results: RawOpportunity[] = [];

  for (const pool of llamaPools.values()) {
    if (pool.project !== 'kamino-liquidity') continue;
    if ((pool.apy ?? 0) < config.scoring.min_apy_pct) continue;
    if (pool.tvlUsd < config.scoring.min_tvl_usd) continue;

    results.push({
      poolId: pool.pool,
      protocol: 'kamino_vaults',
      poolName: `Kamino Vault: ${pool.symbol}`,
      apyDefillama: pool.apy,
      apyProtocol: null,
      apyUsed: pool.apy ?? 0,
      tvlUsd: pool.tvlUsd,
      dataUncertain: true, // single source (DefiLlama only)
    });
  }

  logger.info({ count: results.length }, 'Kamino vault opportunities fetched');
  return results;
}
