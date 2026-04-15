import { LAMPORTS_PER_SOL, type Connection } from '@solana/web3.js';
import type { AgentConfig } from '../config/loader.js';
import { loadWalletKeypair } from '../executor/wallet.js';
import { fetchSolPriceUsd } from '../utils/price.js';
import { logger } from '../utils/logger.js';

export interface LiveCapitalContext {
  walletConfigured: boolean;
  solBalance: number;
  solPriceUsd: number | null;
  reserveSol: number;
  deployableSol: number;
  availableCashUsd: number;
  portfolioUsd: number;
}

export async function getLiveCapitalContext(
  config: AgentConfig,
  connection: Connection,
  providedSolPriceUsd: number | null = null,
): Promise<LiveCapitalContext> {
  const reserveSol = config.allocator.live_gas_reserve_sol;
  const wallet = await loadWalletKeypair();

  if (!wallet) {
    return {
      walletConfigured: false,
      solBalance: 0,
      solPriceUsd: providedSolPriceUsd,
      reserveSol,
      deployableSol: 0,
      availableCashUsd: 0,
      portfolioUsd: 0,
    };
  }

  try {
    const lamports = await connection.getBalance(wallet.publicKey, 'confirmed');
    const solBalance = lamports / LAMPORTS_PER_SOL;
    const solPriceUsd = providedSolPriceUsd ?? await fetchSolPriceUsd();
    const deployableSol = Math.max(0, solBalance - reserveSol);
    const availableCashUsd = solPriceUsd > 0 ? deployableSol * solPriceUsd : 0;
    const portfolioUsd = solPriceUsd > 0 ? solBalance * solPriceUsd : 0;

    return {
      walletConfigured: true,
      solBalance,
      solPriceUsd,
      reserveSol,
      deployableSol,
      availableCashUsd,
      portfolioUsd,
    };
  } catch (err) {
    logger.warn({ err }, 'Failed to compute live capital context');
    return {
      walletConfigured: true,
      solBalance: 0,
      solPriceUsd: providedSolPriceUsd,
      reserveSol,
      deployableSol: 0,
      availableCashUsd: 0,
      portfolioUsd: 0,
    };
  }
}
