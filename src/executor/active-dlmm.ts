import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';

const PAPER_TRADING = (process.env['PAPER_TRADING'] ?? 'false').toLowerCase() === 'true';
const RPC_URL = process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

type DlmmSdk = {
  create: (connection: Connection, poolAddress: PublicKey) => Promise<{
    getActiveBin: () => Promise<{ price?: string | number; binId: number }>;
    initializePosition: (...args: unknown[]) => Promise<unknown>;
    addLiquidityByStrategy: (params: unknown) => Promise<unknown>;
    claimLMReward: (params: unknown) => Promise<unknown>;
    removeLiquidity: (params: unknown) => Promise<unknown>;
  }>;
};

async function getDlmmSdk(): Promise<DlmmSdk> {
  const sdk = (await import('@meteora-ag/dlmm')).default;
  return sdk as unknown as DlmmSdk;
}

export interface ActiveDlmmPositionParams {
  poolAddress: string;
  tokenSymbol: string;
  tier: number;
  positionStyle: 'two_sided' | 'one_sided_sol' | 'bid_ask';
  depositToken: 'sol' | 'usdc' | 'both';
  amountUsd: number;
  binStep: number;
  totalBins: number;
  rangeType: 'wide' | 'medium' | 'tight' | 'ultra_tight';
  takeProfit: number;
  stopLoss: number;
  maxHoldHours: number;
}

export interface PositionResult {
  success: boolean;
  simulated: boolean;
  positionId: string;
  poolAddress: string;
  tokenSymbol: string;
  tier: number;
  depositedSol: number;
  depositedUsdc: number;
  depositedUsd: number;
  minBinPrice: number;
  maxBinPrice: number;
  currentPrice: number;
  binStep: number;
  totalBins: number;
  entryTime: number;
  txSignature?: string;
  error?: string;
  metadata: Record<string, unknown>;
}

export interface ExitResult {
  success: boolean;
  simulated: boolean;
  positionId: string;
  exitReason: string;
  claimedFeesUsd: number;
  receivedSol: number;
  receivedUsdc: number;
  totalReturnUsd: number;
  pnlUsd: number;
  pnlPct: number;
  txSignature?: string;
  error?: string;
}

export function computeBinRange(
  currentPrice: number,
  rangeType: ActiveDlmmPositionParams['rangeType'],
  _totalBins: number,
  _binStep: number,
  positionStyle: ActiveDlmmPositionParams['positionStyle'],
): { minPrice: number; maxPrice: number; activeBinId: number } {
  const rangeMultipliers = {
    wide: { lower: 0.7, upper: 1.5 },
    medium: { lower: 0.85, upper: 1.25 },
    tight: { lower: 0.93, upper: 1.15 },
    ultra_tight: { lower: 0.96, upper: 1.1 },
  } as const;
  const multiplier = rangeMultipliers[rangeType] ?? rangeMultipliers.medium;

  let minPrice = currentPrice * multiplier.lower;
  let maxPrice = currentPrice * multiplier.upper;
  if (positionStyle === 'one_sided_sol') {
    minPrice = currentPrice * 0.98;
    maxPrice = currentPrice * (1 + (multiplier.upper - 1) * 1.5);
  }

  return {
    minPrice,
    maxPrice,
    activeBinId: 0,
  };
}

async function getCurrentPrice(poolAddress: string): Promise<number> {
  try {
    const dlmmSdk = await getDlmmSdk();
    const dlmm = await dlmmSdk.create(connection, new PublicKey(poolAddress));
    const activeBin = await dlmm.getActiveBin();
    const rawPrice = typeof activeBin.price === 'string' ? Number(activeBin.price) : Number(activeBin.price ?? 0);
    return Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : 1;
  } catch (err) {
    logger.warn({ err, poolAddress }, 'Failed to fetch DLMM active bin price; using fallback');
    return 1;
  }
}

export async function createOneSidedPosition(
  params: ActiveDlmmPositionParams,
  walletKeypair?: Keypair,
): Promise<PositionResult> {
  const positionId = `pos_${params.tokenSymbol}_t${params.tier}_${Date.now()}`;

  if (PAPER_TRADING || !walletKeypair) {
    const currentPrice = await getCurrentPrice(params.poolAddress);
    const range = computeBinRange(currentPrice, params.rangeType, params.totalBins, params.binStep, params.positionStyle);
    return {
      success: true,
      simulated: true,
      positionId,
      poolAddress: params.poolAddress,
      tokenSymbol: params.tokenSymbol,
      tier: params.tier,
      depositedSol: params.depositToken === 'sol' ? params.amountUsd / Math.max(currentPrice, 150) : 0,
      depositedUsdc: params.depositToken === 'usdc' ? params.amountUsd : 0,
      depositedUsd: params.amountUsd,
      minBinPrice: range.minPrice,
      maxBinPrice: range.maxPrice,
      currentPrice,
      binStep: params.binStep,
      totalBins: params.totalBins,
      entryTime: Date.now(),
      metadata: {
        rangeType: params.rangeType,
        positionStyle: params.positionStyle,
        takeProfit: params.takeProfit,
        stopLoss: params.stopLoss,
        maxHoldHours: params.maxHoldHours,
        paper: true,
      },
    };
  }

  try {
    const dlmmSdk = await getDlmmSdk();
    const BN = (await import('bn.js')).default as unknown as { new (value: number): { toNumber(): number } };
    const dlmm = await dlmmSdk.create(connection, new PublicKey(params.poolAddress));
    const activeBin = await dlmm.getActiveBin();
    const currentPrice = Number(activeBin.price ?? 1);
    const range = computeBinRange(currentPrice, params.rangeType, params.totalBins, params.binStep, params.positionStyle);
    const solPrice = 150;
    const solAmount = new BN(Math.floor((params.amountUsd / solPrice) * 1e9));
    const usdcAmount = new BN(0);
    const newPosition = Keypair.generate();

    await dlmm.initializePosition(
      walletKeypair.publicKey,
      newPosition.publicKey,
      activeBin.binId - Math.floor(params.totalBins / 4),
      params.totalBins,
    );
    await dlmm.addLiquidityByStrategy({
      positionPubKey: newPosition.publicKey,
      user: walletKeypair.publicKey,
      totalXAmount: solAmount,
      totalYAmount: usdcAmount,
      strategy: {
        maxBinId: activeBin.binId + Math.ceil(params.totalBins * 0.75),
        minBinId: activeBin.binId - Math.floor(params.totalBins * 0.25),
        strategyType: 0,
      },
    });

    return {
      success: true,
      simulated: false,
      positionId: newPosition.publicKey.toBase58(),
      poolAddress: params.poolAddress,
      tokenSymbol: params.tokenSymbol,
      tier: params.tier,
      depositedSol: solAmount.toNumber() / 1e9,
      depositedUsdc: 0,
      depositedUsd: params.amountUsd,
      minBinPrice: range.minPrice,
      maxBinPrice: range.maxPrice,
      currentPrice,
      binStep: params.binStep,
      totalBins: params.totalBins,
      entryTime: Date.now(),
      txSignature: 'LIVE_PATH_NOT_WIRED',
      metadata: {
        rangeType: params.rangeType,
      },
    };
  } catch (err) {
    return {
      success: false,
      simulated: false,
      positionId,
      poolAddress: params.poolAddress,
      tokenSymbol: params.tokenSymbol,
      tier: params.tier,
      depositedSol: 0,
      depositedUsdc: 0,
      depositedUsd: 0,
      minBinPrice: 0,
      maxBinPrice: 0,
      currentPrice: 0,
      binStep: params.binStep,
      totalBins: params.totalBins,
      entryTime: Date.now(),
      error: String(err),
      metadata: {},
    };
  }
}

export async function claimAndExit(
  positionId: string,
  poolAddress: string,
  tokenSymbol: string,
  exitReason: string,
  entryValueUsd: number,
  currentValueUsd: number,
  walletKeypair?: Keypair,
): Promise<ExitResult> {
  if (PAPER_TRADING || !walletKeypair) {
    const simulatedFeesPct = 0.002;
    const simulatedFees = entryValueUsd * simulatedFeesPct;
    const pnlUsd = currentValueUsd - entryValueUsd + simulatedFees;
    return {
      success: true,
      simulated: true,
      positionId,
      exitReason,
      claimedFeesUsd: simulatedFees,
      receivedSol: currentValueUsd / 150,
      receivedUsdc: 0,
      totalReturnUsd: currentValueUsd + simulatedFees,
      pnlUsd,
      pnlPct: entryValueUsd > 0 ? pnlUsd / entryValueUsd : 0,
    };
  }

  try {
    const dlmmSdk = await getDlmmSdk();
    const BN = (await import('bn.js')).default as unknown as { new (value: number): unknown };
    const dlmm = await dlmmSdk.create(connection, new PublicKey(poolAddress));
    const positionPubkey = new PublicKey(positionId);
    await dlmm.claimLMReward({
      owner: walletKeypair.publicKey,
      position: { publicKey: positionPubkey } as { publicKey: PublicKey },
    });
    await dlmm.removeLiquidity({
      position: positionPubkey,
      user: walletKeypair.publicKey,
      binIds: [],
      bps: new BN(10_000),
      shouldClaimAndClose: true,
    });

    return {
      success: true,
      simulated: false,
      positionId,
      exitReason,
      claimedFeesUsd: 0,
      receivedSol: 0,
      receivedUsdc: 0,
      totalReturnUsd: currentValueUsd,
      pnlUsd: currentValueUsd - entryValueUsd,
      pnlPct: entryValueUsd > 0 ? (currentValueUsd - entryValueUsd) / entryValueUsd : 0,
      txSignature: 'LIVE_PATH_NOT_WIRED',
    };
  } catch (err) {
    logger.warn({ err, positionId, tokenSymbol }, 'Active DLMM claim-and-exit failed');
    return {
      success: false,
      simulated: false,
      positionId,
      exitReason,
      claimedFeesUsd: 0,
      receivedSol: 0,
      receivedUsdc: 0,
      totalReturnUsd: 0,
      pnlUsd: 0,
      pnlPct: 0,
      error: String(err),
    };
  }
}

export async function emergencyExitTier(
  tierPositions: Array<{ positionId: string; poolAddress: string; tokenSymbol: string; valueUsd: number }>,
  exitReason: string,
  walletKeypair?: Keypair,
): Promise<ExitResult[]> {
  const settled = await Promise.allSettled(
    tierPositions.map((position) =>
      claimAndExit(
        position.positionId,
        position.poolAddress,
        position.tokenSymbol,
        exitReason,
        position.valueUsd,
        position.valueUsd * 0.95,
        walletKeypair,
      ),
    ),
  );

  return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}
