import type { Connection } from '@solana/web3.js';
import { createSolanaRpc } from '@solana/rpc';
import type { AgentConfig } from '../config/loader.js';

type KitRpc = ReturnType<typeof createSolanaRpc>;
import { fetchDefiLlamaPools } from './defillama.js';
import { fetchKaminoLendingOpportunities, fetchKaminoVaultOpportunities } from './kamino.js';
import { fetchMarginfiOpportunities } from './marginfi.js';
import { fetchJitoOpportunities } from './jito.js';
import { fetchMeteoraOpportunities } from './meteora.js';
import type { RawOpportunity } from '../scoring/engine.js';
import { logger } from '../utils/logger.js';

export type { RawOpportunity };

/**
 * Run a full scan across all enabled protocols.
 *
 * Uses Promise.allSettled so a single protocol failure never crashes the scan.
 * Partial data is always better than no data.
 */
export async function runScan(
  config: AgentConfig,
  connection: Connection,
  kitRpc: KitRpc,
  cooledBaseMints: Set<string> = new Set(),
): Promise<RawOpportunity[]> {
  // Step 1: Fetch DefiLlama data first — used by all other scanners for cross-validation
  logger.info('Starting scan: fetching DefiLlama pools...');
  const llamaPools = await fetchDefiLlamaPools(config.defillamaBaseUrl);
  logger.info({ count: llamaPools.size }, 'DefiLlama pools loaded');

  // Step 2: Run all protocol scanners in parallel (allSettled = no crash on partial failure)
  const [kaminoLending, kaminoVaults, marginfi, jitoResult, meteoraResult] = await Promise.allSettled([
    fetchKaminoLendingOpportunities(kitRpc, llamaPools, config),
    fetchKaminoVaultOpportunities(kitRpc, llamaPools, config),
    fetchMarginfiOpportunities(connection, llamaPools, config),
    Promise.resolve(fetchJitoOpportunities(llamaPools, config)),
    fetchMeteoraOpportunities(llamaPools, config, cooledBaseMints),
  ]);

  // Step 3: Log failures, collect successes
  const all: RawOpportunity[] = [];

  const scannerResults = [
    { name: 'kamino_lending', result: kaminoLending },
    { name: 'kamino_vaults', result: kaminoVaults },
    { name: 'marginfi', result: marginfi },
    { name: 'jito', result: jitoResult },
    { name: 'meteora_dlmm', result: meteoraResult },
  ] as const;

  for (const { name, result } of scannerResults) {
    if (result.status === 'fulfilled') {
      all.push(...result.value);
      logger.info({ protocol: name, count: result.value.length }, 'Scanner completed');
    } else {
      const reason = result.reason;
      const errorType = (reason as { type?: string })?.type ?? 'UNKNOWN';
      logger.error(
        { protocol: name, errorType, err: reason },
        'Scanner failed — continuing with partial data'
      );
    }
  }

  logger.info({ total: all.length }, 'Scan complete');
  return all;
}
