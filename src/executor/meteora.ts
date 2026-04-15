import { Connection, PublicKey, Transaction, Keypair, ComputeBudgetProgram } from '@solana/web3.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MeteoraStrategy = 'spot' | 'curve' | 'bid_ask';

export interface MeteoraDeployParams {
  poolAddress: string;
  amountX: number;        // token amount (human-readable)
  amountY: number;        // SOL amount (human-readable)
  strategy: MeteoraStrategy;
  binsBelow: number;
  binsAbove: number;
  singleSidedX?: boolean; // for single-sided reseed
  // Metadata for tracking
  poolName?: string;
  binStep?: number;
  volatility?: number;
  feeTvlRatio?: number;
  organicScore?: number;
  initialValueUsd?: number;
  baseMint?: string;
}

export interface MeteoraCloseParams {
  positionPubkey: string;
  poolAddress: string;
  positionKeypair?: Keypair; // if closing a position we own the keypair for
}

export interface MeteoraClaimParams {
  positionPubkey: string;
  poolAddress: string;
}

export interface MeteoraAddLiquidityParams {
  positionPubkey: string;
  poolAddress: string;
  amountX?: number;
  amountY?: number;
  strategy?: MeteoraStrategy;
}

export interface MeteoraWithdrawParams {
  positionPubkey: string;
  poolAddress: string;
  bps: number; // basis points to withdraw (10000 = 100%)
}

export interface MeteoraTxResult {
  txs: Transaction[];
  positionKeypair?: Keypair;
  binRange?: { lowerBinId: number; upperBinId: number };
}

// ---------------------------------------------------------------------------
// SDK lazy loading + pool cache
// ---------------------------------------------------------------------------

interface CachedPool {
  dlmm: unknown;
  expiresAt: number;
}

const poolCache = new Map<string, CachedPool>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

async function getDlmmPool(connection: Connection, poolAddress: PublicKey): Promise<unknown> {
  const key = poolAddress.toBase58();
  const cached = poolCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.dlmm;
  }

  const DLMM = (await import('@meteora-ag/dlmm')).default;
  const DLMMClass = DLMM as unknown as { create: (conn: Connection, key: PublicKey) => Promise<unknown> };
  const dlmm = await DLMMClass.create(connection, poolAddress);
  poolCache.set(key, { dlmm, expiresAt: Date.now() + CACHE_TTL_MS });
  return dlmm;
}

function getStrategyType(strategy: MeteoraStrategy): number {
  // StrategyType enum values from @meteora-ag/dlmm
  // Spot = 0, Curve = 1, BidAsk = 2
  switch (strategy) {
    case 'spot': return 0;
    case 'curve': return 1;
    case 'bid_ask': return 2;
    default: return 0;
  }
}

// ---------------------------------------------------------------------------
// Mint decimals helper
// ---------------------------------------------------------------------------

async function getMintDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  if (mint.toBase58() === 'So11111111111111111111111111111111111111112') {
    return 9; // SOL
  }
  try {
    const accountInfo = await connection.getParsedAccountInfo(mint);
    const data = accountInfo.value?.data;
    if (data && typeof data === 'object' && 'parsed' in data) {
      const parsed = (data as { parsed: { info: { decimals: number } } }).parsed;
      return parsed.info.decimals;
    }
  } catch {
    // fallback
  }
  return 9;
}

// ---------------------------------------------------------------------------
// Compute deposit parameters
// ---------------------------------------------------------------------------

export async function computeMeteoraDepositParams(
  poolAddress: string,
  sizeUsd: number,
  strategy: MeteoraStrategy = 'spot'
): Promise<MeteoraDeployParams> {
  let amountX = 0;
  let amountY = 0;
  let binsBelow = 30;
  let binsAbove = 30;
  let poolName: string | undefined;
  let binStep: number | undefined;
  let baseMint: string | undefined;

  try {
    const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(poolAddress)}&page=1&page_size=5`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json() as {
        data?: Array<{
          address?: string;
          name?: string;
          token_x?: { address?: string; price?: number };
          token_y?: { price?: number };
          pool_config?: { bin_step?: number };
        }>;
      };
      const pool = data.data?.find((entry) => entry.address === poolAddress) ?? data.data?.[0];

      if (pool) {
        poolName = pool.name;
        baseMint = pool.token_x?.address;
        binStep = pool.pool_config?.bin_step;

        const tokenYPrice = pool.token_y?.price ?? 0;
        const tokenXPrice = pool.token_x?.price ?? 0;
        if (tokenYPrice > 0) {
          amountY = Number((sizeUsd / tokenYPrice).toFixed(6));
        } else if (tokenXPrice > 0) {
          amountX = Number((sizeUsd / tokenXPrice).toFixed(6));
        }

        if (binStep != null && Number.isFinite(binStep)) {
          const totalBins = binStep <= 10 ? 24 : binStep <= 50 ? 36 : binStep <= 100 ? 48 : 60;
          const belowRatio = strategy === 'curve' ? 0.45 : strategy === 'bid_ask' ? 0.65 : 0.55;
          binsBelow = Math.max(10, Math.round(totalBins * belowRatio));
          binsAbove = Math.max(0, totalBins - binsBelow);
        }
      }
    }
  } catch (err) {
    logger.warn({ err, poolAddress }, 'Falling back to default Meteora deposit params');
  }

  return {
    poolAddress,
    amountX,
    amountY,
    strategy,
    binsBelow,
    binsAbove,
    initialValueUsd: sizeUsd,
    ...(poolName !== undefined && { poolName }),
    ...(binStep !== undefined && { binStep }),
    ...(baseMint !== undefined && { baseMint }),
  };
}

// ---------------------------------------------------------------------------
// Build deposit transaction
// ---------------------------------------------------------------------------

export async function buildMeteoraDepositTx(
  params: MeteoraDeployParams,
  connection: Connection,
  wallet: Keypair
): Promise<MeteoraTxResult | null> {
  try {
    const poolKey = new PublicKey(params.poolAddress);
    const dlmm = await getDlmmPool(connection, poolKey) as {
      getActiveBin: () => Promise<{ binId: number }>;
      getBinsAroundActiveBin: (n: number) => Promise<{ bins: Array<{ binId: number; liquidity: { toString: () => string } }> }>;
      poolState: () => Promise<{
        binStep: number;
        tokenX: { mint: PublicKey; decimals: number };
        tokenY: { mint: PublicKey; decimals: number };
      }>;
    };

    const activeBin = await dlmm.getActiveBin();
    const lowerBinId = activeBin.binId - params.binsBelow;
    const upperBinId = activeBin.binId + params.binsAbove;
    const totalBins = upperBinId - lowerBinId + 1;

    const poolState = await dlmm.poolState();
    const decimalsX = poolState.tokenX.decimals;
    const decimalsY = poolState.tokenY.decimals;

    const amountX = Math.floor(params.amountX * Math.pow(10, decimalsX));
    const amountY = Math.floor(params.amountY * Math.pow(10, decimalsY));

    let txs: Transaction[];

    if (totalBins <= 69) {
      // Single transaction for <= 69 bins
      const stratType = getStrategyType(params.strategy);
      const strat = {
        strategyType: stratType,
        minBinId: lowerBinId,
        maxBinId: upperBinId,
        strategy: {
          type: stratType,
          maxBinId: upperBinId,
          minBinId: lowerBinId,
          strategyType: stratType,
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tx = await (dlmm as unknown as { initializePositionAndAddLiquidityByStrategy: (pubkey: PublicKey, amountX: number, amountY: number, strat: unknown) => Promise<Transaction | Transaction[]> }).initializePositionAndAddLiquidityByStrategy(
        wallet.publicKey,
        amountX,
        amountY,
        strat
      );
      txs = Array.isArray(tx) ? tx : [tx];
    } else {
      // Multi-transaction for > 69 bins
      const stratType = getStrategyType(params.strategy);
      const createTx = await (
        dlmm as unknown as {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          createExtendedEmptyPosition: (pubkey: PublicKey, strat: unknown) => Promise<Transaction>;
        }
      ).createExtendedEmptyPosition(wallet.publicKey, {
        strategyType: stratType,
        minBinId: lowerBinId,
        maxBinId: upperBinId,
        strategy: {
          type: stratType,
          maxBinId: upperBinId,
          minBinId: lowerBinId,
          strategyType: stratType,
        },
      });
      txs = [createTx];

      const addTx = await (
        dlmm as unknown as {
          // eslint-disable-next-line @typescript-eslint/no-explicit any
          addLiquidityByStrategyChunkable: (params: {
            pubKey: PublicKey;
            totalXAmount: number;
            totalYAmount: number;
            strategy: unknown;
          }) => Promise<Transaction>;
        }
      ).addLiquidityByStrategyChunkable({
        pubKey: wallet.publicKey,
        totalXAmount: amountX,
        totalYAmount: amountY,
        strategy: {
          strategyType: stratType,
          minBinId: lowerBinId,
          maxBinId: upperBinId,
          strategy: {
            type: stratType,
            maxBinId: upperBinId,
            minBinId: lowerBinId,
            strategyType: stratType,
          },
        },
      });
      txs.push(addTx);
    }

    // Add compute budget for large transactions
    const modifiedTxs = txs.map((tx) => {
      tx.feePayer = wallet.publicKey;
      const modified = new Transaction();
      modified.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
      modified.add(tx);
      return modified;
    });

    logger.info({
      pool: params.poolAddress,
      bins: totalBins,
      strategy: params.strategy,
      lowerBinId,
      upperBinId,
      txCount: modifiedTxs.length,
    }, 'Built Meteora DLMM deposit transaction(s)');

    return {
      txs: modifiedTxs,
      binRange: { lowerBinId, upperBinId },
    };
  } catch (err) {
    logger.error({ err, pool: params.poolAddress }, 'Failed to build Meteora deposit tx');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Build close transaction
// ---------------------------------------------------------------------------

export async function buildMeteoraCloseTx(
  params: MeteoraCloseParams,
  connection: Connection,
  wallet: Keypair
): Promise<Transaction[] | null> {
  try {
    const poolKey = new PublicKey(params.poolAddress);
    const positionKey = new PublicKey(params.positionPubkey);
    const dlmm = await getDlmmPool(connection, poolKey) as {
      getPosition: (positionPubkey: PublicKey) => Promise<{
        positionData: {
          totalXAmount: { toString: () => string };
          totalYAmount: { toString: () => string };
          binId: number;
        };
      }>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      claimSwapFee: (positionPubkey: PublicKey) => Promise<any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      removeLiquidity: (opts: {
        shouldClaimAndClose: boolean;
        positionPubkey: PublicKey;
        fromBinId: number;
        toBinId: number;
        bps: { toString: () => string };
        publicKey: PublicKey;
      }) => Promise<Transaction>;
    };

    const txs: Transaction[] = [];

    // Claim swap fees first
    try {
      const claimTx = await dlmm.claimSwapFee(positionKey);
      if (claimTx) {
        const modClaim = new Transaction();
        modClaim.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
        modClaim.add(claimTx);
        modClaim.feePayer = wallet.publicKey;
        txs.push(modClaim);
      }
    } catch (claimErr) {
      logger.warn({ err: claimErr, position: params.positionPubkey }, 'Fee claim failed, continuing with close');
    }

    // Remove liquidity and close position
    const removeTx = await dlmm.removeLiquidity({
      shouldClaimAndClose: true,
      positionPubkey: positionKey,
      fromBinId: -887272,
      toBinId: 887272,
      bps: { toString: () => '10000' },
      publicKey: wallet.publicKey,
    });

    const modRemove = new Transaction();
    modRemove.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    modRemove.add(removeTx);
    modRemove.feePayer = wallet.publicKey;
    txs.push(modRemove);

    logger.info({
      position: params.positionPubkey,
      pool: params.poolAddress,
      txs: txs.length,
    }, 'Built Meteora DLMM close transaction(s)');

    return txs;
  } catch (err) {
    logger.error({ err, position: params.positionPubkey }, 'Failed to build Meteora close tx');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Build claim fee transaction
// ---------------------------------------------------------------------------

export async function buildMeteoraClaimFeeTx(
  params: MeteoraClaimParams,
  connection: Connection,
  wallet: Keypair
): Promise<Transaction[] | null> {
  try {
    const poolKey = new PublicKey(params.poolAddress);
    const positionKey = new PublicKey(params.positionPubkey);
    const dlmm = await getDlmmPool(connection, poolKey) as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getPosition: (positionPubkey: PublicKey) => Promise<any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      claimSwapFee: (positionPubkey: PublicKey) => Promise<any>;
    };

    // Verify position exists and has unclaimed fees
    const position = await dlmm.getPosition(positionKey);
    if (!position?.positionData) {
      logger.warn({ position: params.positionPubkey }, 'Position not found for fee claim');
      return null;
    }

    const txs: Transaction[] = [];
    const claimTx = await dlmm.claimSwapFee(positionKey);
    if (claimTx) {
      const mod = new Transaction();
      mod.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
      mod.add(claimTx);
      mod.feePayer = wallet.publicKey;
      txs.push(mod);
    }

    logger.info({
      position: params.positionPubkey,
      pool: params.poolAddress,
    }, 'Built Meteora DLMM claim fee transaction');

    return txs.length > 0 ? txs : null;
  } catch (err) {
    logger.error({ err, position: params.positionPubkey }, 'Failed to build Meteora claim fee tx');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Build add liquidity transaction (for fee compounding or manual add)
// ---------------------------------------------------------------------------

export async function buildMeteoraAddLiquidityTx(
  params: MeteoraAddLiquidityParams,
  connection: Connection,
  wallet: Keypair
): Promise<Transaction[] | null> {
  try {
    const poolKey = new PublicKey(params.poolAddress);
    const positionKey = new PublicKey(params.positionPubkey);
    const dlmm = await getDlmmPool(connection, poolKey) as {
      getPosition: (positionPubkey: PublicKey) => Promise<{
        positionData: {
          totalXAmount: { toString: () => string };
          totalYAmount: { toString: () => string };
          binId: number;
          lowerBinId: number;
          upperBinId: number;
        };
      }>;
      poolState: () => Promise<{
        tokenX: { mint: PublicKey; decimals: number };
        tokenY: { mint: PublicKey; decimals: number };
      }>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      addLiquidityByStrategy: (params: {
        positionPubkey: PublicKey;
        totalXAmount: number;
        totalYAmount: number;
        strategy: unknown;
      }) => Promise<Transaction>;
    };

    const position = await dlmm.getPosition(positionKey);
    if (!position?.positionData) {
      logger.warn({ position: params.positionPubkey }, 'Position not found for add liquidity');
      return null;
    }

    const poolState = await dlmm.poolState();
    const decimalsX = poolState.tokenX.decimals;
    const decimalsY = poolState.tokenY.decimals;

    const amountX = params.amountX ? Math.floor(params.amountX * Math.pow(10, decimalsX)) : 0;
    const amountY = params.amountY ? Math.floor(params.amountY * Math.pow(10, decimalsY)) : 0;

    const stratType = params.strategy ? getStrategyType(params.strategy) : 0;
    const { lowerBinId, upperBinId } = position.positionData;

    const addTx = await dlmm.addLiquidityByStrategy({
      positionPubkey: positionKey,
      totalXAmount: amountX,
      totalYAmount: amountY,
      strategy: {
        strategyType: stratType,
        minBinId: lowerBinId,
        maxBinId: upperBinId,
        strategy: {
          type: stratType,
          maxBinId: upperBinId,
          minBinId: lowerBinId,
          strategyType: stratType,
        },
      },
    });

    const mod = new Transaction();
    mod.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    mod.add(addTx);
    mod.feePayer = wallet.publicKey;

    logger.info({
      position: params.positionPubkey,
      pool: params.poolAddress,
      amountX,
      amountY,
    }, 'Built Meteora DLMM add liquidity transaction');

    return [mod];
  } catch (err) {
    logger.error({ err, position: params.positionPubkey }, 'Failed to build Meteora add liquidity tx');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Build withdraw liquidity transaction (partial withdrawal)
// ---------------------------------------------------------------------------

export async function buildMeteoraWithdrawLiquidityTx(
  params: MeteoraWithdrawParams,
  connection: Connection,
  wallet: Keypair
): Promise<Transaction[] | null> {
  try {
    const poolKey = new PublicKey(params.poolAddress);
    const positionKey = new PublicKey(params.positionPubkey);
    const dlmm = await getDlmmPool(connection, poolKey) as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      removeLiquidity: (opts: {
        shouldClaimAndClose: boolean;
        positionPubkey: PublicKey;
        fromBinId: number;
        toBinId: number;
        bps: { toString: () => string };
        publicKey: PublicKey;
      }) => Promise<Transaction>;
    };

    const removeTx = await dlmm.removeLiquidity({
      shouldClaimAndClose: false,
      positionPubkey: positionKey,
      fromBinId: -887272,
      toBinId: 887272,
      bps: { toString: () => params.bps.toString() },
      publicKey: wallet.publicKey,
    });

    const mod = new Transaction();
    mod.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    mod.add(removeTx);
    mod.feePayer = wallet.publicKey;

    logger.info({
      position: params.positionPubkey,
      pool: params.poolAddress,
      bps: params.bps,
    }, 'Built Meteora DLMM withdraw liquidity transaction');

    return [mod];
  } catch (err) {
    logger.error({ err, position: params.positionPubkey }, 'Failed to build Meteora withdraw liquidity tx');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Calculate target bin range (volatility-aware)
// ---------------------------------------------------------------------------

export function calculateTargetBinRange(
  currentActiveBin: number,
  strategy: MeteoraStrategy,
  binStep: number,
  volatility: number = 1
): { lowerBinId: number; upperBinId: number } {
  let totalBins: number;
  if (volatility < 1) {
    totalBins = 25 + Math.floor(Math.random() * 11); // 25-35
  } else if (volatility < 3) {
    totalBins = 35 + Math.floor(Math.random() * 16); // 35-50
  } else if (volatility < 5) {
    totalBins = 50 + Math.floor(Math.random() * 11); // 50-60
  } else {
    totalBins = 60 + Math.floor(Math.random() * 10); // 60-69 (max)
  }
  totalBins = Math.min(totalBins, 69);

  let directionalSplit: number;
  switch (strategy) {
    case 'bid_ask': directionalSplit = 0.75; break; // 75% below for downtrend
    case 'curve': directionalSplit = 0.35; break;  // 35% below for uptrend
    default: directionalSplit = 0.55; break;         // 55% below for neutral
  }

  const binsBelow = Math.floor(totalBins * directionalSplit);
  const binsAbove = totalBins - binsBelow;

  return {
    lowerBinId: currentActiveBin - binsBelow,
    upperBinId: currentActiveBin + binsAbove,
  };
}
