/**
 * Token research via Jupiter DataAPI (datapi.jup.ag).
 *
 * Provides:
 *   - Token info: organic score, market cap, global fees (scam detection), audit flags
 *   - Holder distribution: top-10 concentration, bundler detection
 *   - Smart wallet cross-reference: KOL/alpha presence in holder list
 *
 * All functions return null on failure — callers should treat null as
 * "data unavailable" and proceed without blocking the scanner.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { listSmartWallets } from './smart-wallets.js';

const DATAPI_BASE = 'https://datapi.jup.ag/v1';
const TIMEOUT_MS = 10_000;

// Build auth headers from JUPITER_API_KEY env var (optional — requests proceed without it
// but datapi.jup.ag returns 403 for holder/asset endpoints without a valid key).
const jupiterApiKey = process.env['JUPITER_API_KEY'];
const DATAPI_HEADERS = jupiterApiKey
  ? { Authorization: `Bearer ${jupiterApiKey}` }
  : {};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenAudit {
  mintDisabled: boolean;
  freezeDisabled: boolean;
  topHoldersPct: number;
  botHoldersPct: number;
}

export interface TokenInfo {
  mint: string;
  name: string;
  symbol: string;
  mcap: number | null;
  price: number | null;
  holders: number | null;
  organicScore: number | null;
  organicLabel: string | null;
  /** Global priority + jito fees paid by traders, in SOL. <30 SOL = likely scam/bundled. */
  globalFeesSol: number | null;
  launchpad: string | null;
  graduated: boolean;
  audit: TokenAudit | null;
}

export interface HolderStats {
  mint: string;
  /** Percentage held by top 10 real (non-pool) wallets. */
  top10Pct: number;
  /** Percentage held by detected bundler wallets (common funder or same funding window). */
  bundlerPct: number;
  /** Number of bundler wallets identified. */
  bundlerCount: number;
  /** KOL/alpha wallet addresses found in the top holders. */
  smartWalletsHolding: string[];
}

export interface TokenResearch {
  info: TokenInfo | null;
  holders: HolderStats | null;
}

// ---------------------------------------------------------------------------
// Token info
// ---------------------------------------------------------------------------

export async function fetchTokenInfo(mint: string): Promise<TokenInfo | null> {
  try {
    const { data } = await axios.get<unknown[]>(
      `${DATAPI_BASE}/assets/search?query=${encodeURIComponent(mint)}`,
      { timeout: TIMEOUT_MS, headers: DATAPI_HEADERS }
    );

    const tokens = Array.isArray(data) ? data : [data];
    const t = tokens[0] as Record<string, unknown> | undefined;
    if (!t) return null;

    const audit = t['audit'] as Record<string, unknown> | undefined;

    return {
      mint,
      name: (t['name'] as string | undefined) ?? '',
      symbol: (t['symbol'] as string | undefined) ?? '',
      mcap: typeof t['mcap'] === 'number' ? t['mcap'] : null,
      price: typeof t['usdPrice'] === 'number' ? t['usdPrice'] : null,
      holders: typeof t['holderCount'] === 'number' ? t['holderCount'] : null,
      organicScore: typeof t['organicScore'] === 'number' ? t['organicScore'] : null,
      organicLabel: typeof t['organicScoreLabel'] === 'string' ? t['organicScoreLabel'] : null,
      globalFeesSol: typeof t['fees'] === 'number' ? parseFloat(t['fees'].toFixed(2)) : null,
      launchpad: typeof t['launchpad'] === 'string' ? t['launchpad'] : null,
      graduated: !!(t['graduatedPool']),
      audit: audit
        ? {
            mintDisabled: !!(audit['mintAuthorityDisabled']),
            freezeDisabled: !!(audit['freezeAuthorityDisabled']),
            topHoldersPct: typeof audit['topHoldersPercentage'] === 'number' ? audit['topHoldersPercentage'] : 0,
            botHoldersPct: typeof audit['botHoldersPercentage'] === 'number' ? audit['botHoldersPercentage'] : 0,
          }
        : null,
    };
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 403 || status === 401) {
      logger.debug({ mint }, 'token-research: fetchTokenInfo skipped (no DataAPI access)');
    } else {
      logger.warn({ mint, err }, 'token-research: fetchTokenInfo failed');
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Holder distribution + bundler detection
// ---------------------------------------------------------------------------

export async function fetchHolderStats(mint: string): Promise<HolderStats | null> {
  try {
    // Fetch holders and total supply in parallel
    const [holdersRes, tokenRes] = await Promise.all([
      axios.get<unknown>(`${DATAPI_BASE}/holders/${mint}?limit=100`, { timeout: TIMEOUT_MS, headers: DATAPI_HEADERS }),
      axios.get<unknown[]>(`${DATAPI_BASE}/assets/search?query=${encodeURIComponent(mint)}`, { timeout: TIMEOUT_MS, headers: DATAPI_HEADERS }),
    ]);

    const holdersRaw = holdersRes.data;
    const holders: Record<string, unknown>[] = Array.isArray(holdersRaw)
      ? (holdersRaw as Record<string, unknown>[])
      : ((holdersRaw as Record<string, unknown>)['holders'] as Record<string, unknown>[] | undefined) ?? [];

    const tokenData = Array.isArray(tokenRes.data) ? tokenRes.data[0] : tokenRes.data;
    const t = tokenData as Record<string, unknown> | undefined;
    const totalSupply: number | null =
      typeof t?.['totalSupply'] === 'number'
        ? t['totalSupply']
        : typeof t?.['circSupply'] === 'number'
        ? (t['circSupply'] as number)
        : null;

    // Map holders — exclude pool accounts
    const mapped = holders.slice(0, 100).map((h) => {
      const tags = (h['tags'] as Array<Record<string, string>> | undefined) ?? [];
      const tagNames = tags.map((tag) => (tag['name'] ?? tag['id'] ?? '').toString());
      const isPool = tagNames.some((tag) => /pool|amm|liquidity|raydium|orca|meteora/i.test(tag));

      const rawAmount = typeof h['amount'] === 'number' ? h['amount'] : 0;
      const pct: number | null = totalSupply
        ? (rawAmount / totalSupply) * 100
        : typeof h['percentage'] === 'number'
        ? h['percentage']
        : null;

      const fundingRaw = h['addressInfo'] as Record<string, unknown> | undefined;
      const funding = fundingRaw?.['fundingAddress']
        ? {
            address: fundingRaw['fundingAddress'] as string,
            slot: typeof fundingRaw['fundingSlot'] === 'number' ? fundingRaw['fundingSlot'] : null,
          }
        : null;

      return {
        address: (h['address'] ?? h['wallet'] ?? '') as string,
        pct,
        isPool,
        funding,
      };
    });

    const realHolders = mapped.filter((h) => !h.isPool);

    // Top-10 concentration
    const top10Pct = realHolders
      .slice(0, 10)
      .reduce((sum, h) => sum + (h.pct ?? 0), 0);

    // ── Bundler Detection ──────────────────────────────────────────────
    // Method 1: common funder — 2+ wallets funded by same address
    const funderGroups = new Map<string, string[]>();
    for (const h of realHolders) {
      if (h.funding?.address) {
        const group = funderGroups.get(h.funding.address) ?? [];
        group.push(h.address);
        funderGroups.set(h.funding.address, group);
      }
    }
    const commonFunderSet = new Set<string>(
      [...funderGroups.values()]
        .filter((g) => g.length >= 2)
        .flat()
    );

    // Method 2: funded within ±5000 slots of each other
    const SLOT_WINDOW = 5000;
    const withSlots = realHolders
      .filter((h) => h.funding?.slot !== null && h.funding?.slot !== undefined)
      .sort((a, b) => (a.funding!.slot! - b.funding!.slot!));

    const sameWindowSet = new Set<string>();
    for (let i = 0; i < withSlots.length; i++) {
      for (let j = i + 1; j < withSlots.length; j++) {
        const hi = withSlots[i]!;
        const hj = withSlots[j]!;
        if (hj.funding!.slot! - hi.funding!.slot! <= SLOT_WINDOW) {
          sameWindowSet.add(hi.address);
          sameWindowSet.add(hj.address);
        } else {
          break;
        }
      }
    }

    const bundlers = realHolders.filter(
      (h) => commonFunderSet.has(h.address) || sameWindowSet.has(h.address)
    );
    const bundlerPct = bundlers.reduce((sum, b) => sum + (b.pct ?? 0), 0);

    // ── Smart Wallet Cross-reference ───────────────────────────────────
    const smartWallets = listSmartWallets();
    const holderAddressSet = new Set(realHolders.map((h) => h.address));
    const smartWalletsHolding = smartWallets
      .filter((sw) => holderAddressSet.has(sw.address))
      .map((sw) => sw.address);

    return {
      mint,
      top10Pct,
      bundlerPct,
      bundlerCount: bundlers.length,
      smartWalletsHolding,
    };
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 403 || status === 401) {
      logger.debug({ mint }, 'token-research: fetchHolderStats skipped (no DataAPI access)');
    } else {
      logger.warn({ mint, err }, 'token-research: fetchHolderStats failed');
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Combined research (runs both calls in parallel)
// ---------------------------------------------------------------------------

export async function researchToken(mint: string): Promise<TokenResearch> {
  const [info, holders] = await Promise.allSettled([
    fetchTokenInfo(mint),
    fetchHolderStats(mint),
  ]);

  return {
    info: info.status === 'fulfilled' ? info.value : null,
    holders: holders.status === 'fulfilled' ? holders.value : null,
  };
}

// ---------------------------------------------------------------------------
// Hard-skip checks (apply before adding to candidate list)
// ---------------------------------------------------------------------------

export interface SkipReason {
  skip: true;
  reason: string;
}
export interface NoSkip {
  skip: false;
}

/**
 * Returns whether a token should be hard-skipped based on research data.
 * Applies quality screening hard rules (organic score, bundler %, holder concentration).
 */
export function checkHardSkip(
  research: TokenResearch,
  opts: {
    minGlobalFeesSol?: number;
    maxTop10Pct?: number;
    maxBundlerPct?: number;
    blacklistedLaunchpads?: string[];
  } = {}
): SkipReason | NoSkip {
  const {
    minGlobalFeesSol = 30,
    maxTop10Pct = 60,
    maxBundlerPct = 30,
    blacklistedLaunchpads = ['pump.fun', 'letsbonk.fun'],
  } = opts;

  const { info, holders } = research;

  // Global fees too low → likely bundled/scam
  if (info?.globalFeesSol !== null && info?.globalFeesSol !== undefined) {
    if (info.globalFeesSol < minGlobalFeesSol) {
      return { skip: true, reason: `global_fees_sol ${info.globalFeesSol} < ${minGlobalFeesSol} (bundled/scam)` };
    }
  }

  // Top-10 holder concentration too high
  if (holders?.top10Pct !== undefined && holders.top10Pct > maxTop10Pct) {
    return { skip: true, reason: `top10_holders_pct ${holders.top10Pct.toFixed(1)}% > ${maxTop10Pct}%` };
  }

  // Bundler concentration too high
  if (holders?.bundlerPct !== undefined && holders.bundlerPct > maxBundlerPct) {
    return { skip: true, reason: `bundler_pct ${holders.bundlerPct.toFixed(1)}% > ${maxBundlerPct}%` };
  }

  // Blacklisted launchpad
  if (info?.launchpad) {
    const lp = info.launchpad.toLowerCase();
    if (blacklistedLaunchpads.some((b) => lp.includes(b))) {
      return { skip: true, reason: `blacklisted launchpad: ${info.launchpad}` };
    }
  }

  return { skip: false };
}
