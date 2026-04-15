import type { AgentConfig } from '../config/loader.js';
import type { DefiLlamaPool } from './defillama.js';
import type { RawOpportunity } from '../scoring/engine.js';
import { logger } from '../utils/logger.js';

// Jito project slugs on DefiLlama
const JITO_PROJECTS = new Set(['jito-liquid-staking']);

/**
 * Jito liquid staking APY scanner.
 *
 * Phase 1: DefiLlama-only source. There is no public Jito REST or SDK endpoint
 * that exposes a simple APY figure without significant on-chain computation.
 * All Jito entries are marked data_uncertain=true (single source).
 * The high trust_score (95) in config compensates in the scoring formula.
 */
export function fetchJitoOpportunities(
  llamaPools: Map<string, DefiLlamaPool>,
  config: AgentConfig
): RawOpportunity[] {
  if (!config.protocols.jito.enabled) return [];

  const results: RawOpportunity[] = [];

  for (const pool of llamaPools.values()) {
    if (!JITO_PROJECTS.has(pool.project)) continue;
    if ((pool.apy ?? 0) < config.scoring.min_apy_pct) continue;
    if (pool.tvlUsd < config.scoring.min_tvl_usd) continue;

    results.push({
      poolId: pool.pool,
      protocol: 'jito',
      poolName: `Jito: ${pool.symbol}`,
      apyDefillama: pool.apy,
      apyProtocol: null, // no SDK source for Phase 1
      apyUsed: pool.apy ?? 0,
      tvlUsd: pool.tvlUsd,
      dataUncertain: true, // single source — DefiLlama only
    });
  }

  logger.info({ count: results.length }, 'Jito opportunities fetched');
  return results;
}
