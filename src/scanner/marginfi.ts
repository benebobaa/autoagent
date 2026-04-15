import { Connection } from '@solana/web3.js';
import { MarginfiClient, getConfig } from '@mrgnlabs/marginfi-client-v2';
import type { AgentConfig } from '../config/loader.js';
import { getDummyKeypair, makeReadOnlyWallet } from '../utils/rpc.js';
import type { DefiLlamaPool } from './defillama.js';
import type { RawOpportunity } from '../scoring/engine.js';
import { logger } from '../utils/logger.js';

/**
 * Returns USD price estimates for well-known Solana token mints.
 * Stablecoins → $1. SOL/LST variants → solPriceUsd. Others → 0 (will be skipped by TVL filter).
 * This avoids external API calls — prices for the major MarginFi assets (USDC, SOL, USDT, JitoSOL)
 * are stable enough that hardcoded approximations pass the TVL filter reliably.
 */
function buildMintPriceMap(solPriceUsd: number): Map<string, number> {
  return new Map([
    // Stablecoins ($1)
    ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 1], // USDC
    ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 1], // USDT
    ['USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX', 1],  // USDH
    ['UXPhBoR3qG4UCiGNJfV7MqhHyFqKN68g45GoYvAeL2M', 1],  // UXD
    ['7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', 1], // stSOL/stableSOL
    // SOL and LST variants (use live SOL price)
    ['So11111111111111111111111111111111111111112', solPriceUsd],   // WSOL
    ['J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', solPriceUsd], // JitoSOL
    ['mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', solPriceUsd], // mSOL
    ['7Q2afV64in6N6SeZsAAB81TJzwDoD6zpqmHkzi9Dcavn', solPriceUsd], // JSOL
    ['bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', solPriceUsd],  // bSOL
    ['Jito4APyf642JPFzW5GKX5bEHZpOk5V22UZYXfXR7mNg', solPriceUsd], // JTO (approx)
  ]);
}

interface MarginfiTypedError extends Error {
  readonly type: string;
}

class MarginfiBorshDecodeError extends Error {
  readonly type = 'BORSH_DECODE' as const;
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super('Marginfi Borsh decode failed — RPC returned truncated/corrupt data (check RPC tier) or IDL mismatch');
    this.name = 'MarginfiBorshDecodeError';
    this.cause = cause;
  }
}

class MarginfiRpcUnhealthyError extends Error {
  readonly type = 'RPC_UNHEALTHY' as const;
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super('Marginfi RPC unhealthy — group account fetch failed');
    this.name = 'MarginfiRpcUnhealthyError';
    this.cause = cause;
  }
}

class MarginfiRpcTimeoutError extends Error {
  readonly type = 'RPC_TIMEOUT' as const;
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super('Marginfi RPC timeout');
    this.name = 'MarginfiRpcTimeoutError';
    this.cause = cause;
  }
}

class MarginfiRpcRateLimitError extends Error {
  readonly type = 'RPC_RATE_LIMIT' as const;
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super('Marginfi RPC rate limited');
    this.name = 'MarginfiRpcRateLimitError';
    this.cause = cause;
  }
}

class MarginfiRpcBatchFetchError extends Error {
  readonly type = 'RPC_BATCH_FETCH' as const;
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super('Marginfi RPC batch fetch failed — RPC may lack capacity for large account batch fetches');
    this.name = 'MarginfiRpcBatchFetchError';
    this.cause = cause;
  }
}

function classifyMarginfiError(err: unknown): MarginfiTypedError {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  if (msg.includes('Cannot read properties of null') && (msg.includes('property') || stack?.includes('Union.decode'))) {
    return new MarginfiBorshDecodeError(err);
  }
  if (msg.includes('Failed to fetch account infos after')) {
    return new MarginfiRpcBatchFetchError(err);
  }
  if (msg.includes('ETIMEDOUT') || msg.includes('fetch failed')) {
    return new MarginfiRpcTimeoutError(err);
  }
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('429 Too Many Requests')) {
    return new MarginfiRpcRateLimitError(err);
  }
  if (msg.includes('Group account empty') || msg.includes('Failed to fetch the on-chain group')) {
    return new MarginfiRpcUnhealthyError(err);
  }
  return new MarginfiBorshDecodeError(err);
}

function aprToApy(apr: number): number {
  return (Math.pow(1 + apr / 365, 365) - 1) * 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps a Connection so that the MarginFi SDK's internal _rpcBatchRequest calls
 * are de-batched into sequential individual _rpcRequest calls, each sub-chunked to
 * stay within the RPC provider's getMultipleAccounts account-count limit.
 *
 * Background: @mrgnlabs/mrgn-common's chunkedGetRawMultipleAccountInfoOrdered calls
 * connection._rpcBatchRequest directly (bypassing getMultipleAccountsInfo entirely).
 * Many RPC providers (QuickNode Discover plan: max 5 accounts, paid plans: 100+) reject
 * large getMultipleAccounts calls. This Proxy:
 *   1. De-batches JSON-RPC batch requests into sequential individual _rpcRequest calls
 *   2. Sub-chunks each getMultipleAccounts call to ≤ maxAccountsPerCall and merges results
 *   3. Spaces calls by delayMs to avoid 429s
 */
function makeThrottledConnection(
  connection: Connection,
  delayMs = 300,
  maxAccountsPerCall = 5,
): Connection {
  let lastCallTs = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rpcRequest = (connection as any)._rpcRequest.bind(connection);

  /** Throttled single RPC call — respects delayMs between calls */
  async function singleCall(method: string, args: unknown[]): Promise<unknown> {
    const wait = delayMs - (Date.now() - lastCallTs);
    if (wait > 0) await sleep(wait);
    lastCallTs = Date.now();
    return rpcRequest(method, args);
  }

  /**
   * For getMultipleAccounts, sub-chunk the account list to maxAccountsPerCall
   * and merge the resulting value arrays back into a single JSON-RPC response.
   * Other methods are passed through as-is.
   */
  async function chunkedCall(method: string, args: unknown[]): Promise<unknown> {
    if (method !== 'getMultipleAccounts') {
      return singleCall(method, args);
    }

    const accounts = args[0] as string[];
    const config = args[1];

    if (accounts.length <= maxAccountsPerCall) {
      return singleCall(method, args);
    }

    // Sub-chunk and merge
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let merged: any = null;
    for (let i = 0; i < accounts.length; i += maxAccountsPerCall) {
      const chunk = accounts.slice(i, i + maxAccountsPerCall);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await singleCall(method, [chunk, config]) as any;
      if (!merged) {
        merged = res;
      } else {
        merged.result.value.push(...(res?.result?.value ?? []));
      }
    }

    logger.debug(
      { totalAccounts: accounts.length, chunkSize: maxAccountsPerCall },
      'MarginFi getMultipleAccounts sub-chunk merge complete',
    );
    return merged;
  }

  return new Proxy(connection, {
    get(target, prop: string | symbol) {
      if (prop === '_rpcBatchRequest') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return async (requests: Array<{ methodName: string; args: unknown[] }>) => {
          logger.debug({ requestCount: requests.length }, 'MarginFi _rpcBatchRequest intercepted — de-batching');
          const results: unknown[] = [];
          for (const req of requests) {
            try {
              const result = await chunkedCall(req.methodName, req.args);
              results.push(result);
            } catch (err) {
              logger.error({ err, method: req.methodName }, 'MarginFi de-batched _rpcRequest failed');
              throw err;
            }
          }
          logger.debug({ resultCount: results.length }, 'MarginFi de-batch complete');
          return results;
        };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (target as any)[prop];
    },
  });
}

async function validateMarginfiRpc(connection: Connection, config: AgentConfig): Promise<void> {
  const mfiConfig = getConfig(config.marginfiEnv as 'production' | 'staging');
  const groupPk = mfiConfig.groupPk;
  const accountInfo = await connection.getAccountInfo(groupPk);
  if (!accountInfo || accountInfo.data.length === 0) {
    throw new MarginfiRpcUnhealthyError(new Error('Group account empty or fetch failed'));
  }
}

async function fetchMarginfiClient(
  connection: Connection,
  config: AgentConfig,
  attempt: number
): Promise<MarginfiClient> {
  const keypair = getDummyKeypair();
  const wallet = makeReadOnlyWallet(keypair);
  const mfiConfig = getConfig(config.marginfiEnv as 'production' | 'staging');

  // Throttle + sub-chunk account fetches for RPC providers with low getMultipleAccounts limits.
  // QuickNode Discover plan: max 5 accounts per call. Paid plans allow 100+.
  // 400 ms between calls ≈ ~2.5 req/s — well within typical rate limits.
  const throttledConnection = makeThrottledConnection(connection, 400, 5);

  try {
    const client = await Promise.race([
      MarginfiClient.fetch(mfiConfig, wallet, throttledConnection, { readOnly: true }),
      new Promise<never>((_, reject) =>
        // 180s — ceiling for sub-chunked batch fetches (5 accts/call × 400ms × many chunks)
        setTimeout(() => reject(new Error('MarginfiClient.fetch timeout')), 180_000)
      ),
    ]);
    return client;
  } catch (err) {
    logger.error({ attempt, err }, 'MarginfiClient.fetch attempt failed');
    throw err;
  }
}

export async function fetchMarginfiOpportunities(
  connection: Connection,
  llamaPools: Map<string, DefiLlamaPool>,
  config: AgentConfig,
  solPriceUsd = 0,
): Promise<RawOpportunity[]> {
  if (!config.protocols.marginfi.enabled) return [];

  try {
    await validateMarginfiRpc(connection, config);
  } catch (err) {
    logger.error({ err }, 'Marginfi RPC health check failed');
    throw err;
  }

  const delays = [2_000, 4_000, 8_000];
  let client: MarginfiClient | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      client = await fetchMarginfiClient(connection, config, attempt + 1);
      break;
    } catch (err) {
      lastError = err;
      if (attempt < delays.length) {
        const delay = delays[attempt]!;
        logger.info({ attempt: attempt + 1, delayMs: delay }, 'Retrying MarginfiClient.fetch');
        await sleep(delay);
      }
    }
  }

  if (!client) {
    const classified = classifyMarginfiError(lastError);
    logger.error(
      { errorType: classified.type, cause: lastError },
      'MarginfiClient.fetch failed after retries'
    );
    throw classified;
  }

  // mintPrice=0 in readOnly mode — use hardcoded map for major assets
  const mintPrices = buildMintPriceMap(solPriceUsd > 0 ? solPriceUsd : 80);

  const results: RawOpportunity[] = [];

  for (const [, bank] of client.banks) {
    try {
      const symbol = bank.tokenSymbol ?? bank.address.toBase58().slice(0, 8);
      const rates = bank.computeInterestRates();
      const lendingApr = rates.lendingRate.toNumber();
      const apyPct = aprToApy(lendingApr);

      const mintAddress = bank.mint.toBase58();
      const tokenPrice = mintPrices.get(mintAddress) ?? 0;
      const rawTokenAmount = bank.assetShareValue.times(bank.totalAssetShares).toNumber();
      const tvlUsd = tokenPrice > 0 ? rawTokenAmount * tokenPrice : 0;

      if (apyPct < config.scoring.min_apy_pct) continue;
      if (tvlUsd < config.scoring.min_tvl_usd) continue;

      const apyDefillama: number | null = null; // marginfi lending not tracked on DefiLlama

      const diffPct = apyDefillama !== null
        ? Math.abs(apyDefillama - apyPct) / Math.max(apyPct, 0.001) * 100
        : null;

      const dataUncertain = apyDefillama === null ? true :
        (diffPct ?? 0) > config.scoring.data_uncertainty_threshold_pct;

      results.push({
        poolId: `marginfi-${bank.address.toBase58()}`,
        protocol: 'marginfi',
        poolName: `Marginfi: ${symbol}`,
        apyDefillama,
        apyProtocol: apyPct,
        apyUsed: apyPct,
        tvlUsd,
        dataUncertain,
      });
    } catch (err) {
      logger.warn({ bank: bank.address?.toBase58(), err }, 'Failed to process Marginfi bank');
    }
  }

  logger.info({ count: results.length }, 'Marginfi opportunities fetched');
  return results;
}
