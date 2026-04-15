import { Connection, Transaction, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import type { ParsedAccountData } from '@solana/web3.js';
import { depositSol, withdrawSol, getStakePoolAccount, STAKE_POOL_PROGRAM_ID } from '@solana/spl-stake-pool';
import { fetchSolPriceUsd } from '../utils/price.js';
import { logger } from '../utils/logger.js';
import type { AgentConfig } from '../config/loader.js';

export { STAKE_POOL_PROGRAM_ID };

export const JITO_STAKE_POOL = new PublicKey('Jito4APyf642JPZPx3hGc6WWyokR9p7fFCHANQRpFMh');

export interface JitoDepositParams {
  lamports: number;
  solPriceUsd: number;
}

export interface JitoBuildResult extends JitoDepositParams {
  tx: Transaction;
  instructionCount: number;
}

export interface JitoWithdrawParams {
  jitoSolAmount: number; // JitoSOL token amount in SOL decimal units
  solPriceUsd: number;
}

export interface JitoWithdrawResult extends JitoWithdrawParams {
  tx: Transaction;
  instructionCount: number;
}

/**
 * Estimates JitoSOL withdrawal amount from position data. No RPC calls.
 * Safe to call in DRY_RUN mode. Uses entry price if available, else current SOL price.
 */
export async function computeJitoWithdrawParams(
  sizeUsd: number,
  entryPriceSol: number | null,
): Promise<JitoWithdrawParams> {
  const solPriceUsd = await fetchSolPriceUsd();
  const priceSol = entryPriceSol ?? solPriceUsd;
  const jitoSolAmount = sizeUsd / priceSol;
  return { jitoSolAmount, solPriceUsd };
}

/**
 * Builds a real Jito withdrawSol transaction using the wallet's actual on-chain JitoSOL balance.
 * Requires live RPC. Withdraws all JitoSOL tokens held by the wallet.
 */
export async function buildJitoWithdrawTx(
  connection: Connection,
  config: AgentConfig,
): Promise<JitoWithdrawResult> {
  const walletAddress = config.agentWalletAddress
    ? new PublicKey(config.agentWalletAddress)
    : PublicKey.default;

  // Fetch pool mint from stake pool to find the JitoSOL token account
  const stakePoolAccount = await getStakePoolAccount(connection, JITO_STAKE_POOL);
  const poolMint = stakePoolAccount.account.data.poolMint;

  // Query JitoSOL token balance via parsed token accounts (web3.js built-in, no spl-token needed)
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletAddress, { mint: poolMint });

  if (tokenAccounts.value.length === 0) {
    throw new Error('No JitoSOL token account found for wallet — was the deposit confirmed on-chain?');
  }

  const tokenAccountInfo = tokenAccounts.value[0];
  if (!tokenAccountInfo) {
    throw new Error('No JitoSOL token account found for wallet');
  }

  const data = tokenAccountInfo.account.data;
  if (!('parsed' in data)) {
    throw new Error('Unexpected raw account data for JitoSOL token account');
  }

  const jitoSolAmount: number = (data as ParsedAccountData).parsed?.info?.tokenAmount?.uiAmount ?? 0;

  if (jitoSolAmount <= 0) {
    throw new Error('JitoSOL token account has zero balance — nothing to withdraw');
  }

  const solPriceUsd = await fetchSolPriceUsd();

  logger.info({ jitoSolAmount, wallet: walletAddress.toBase58() }, 'Building Jito withdrawSol tx');

  const { instructions, signers } = await withdrawSol(
    connection,
    JITO_STAKE_POOL,
    walletAddress,
    walletAddress, // SOL returns to same wallet
    jitoSolAmount,
  );

  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const tx = new Transaction();
  tx.feePayer = walletAddress;
  tx.recentBlockhash = blockhash;
  tx.add(...instructions);

  if (signers.length > 0) {
    tx.partialSign(...signers);
  }

  return { tx, jitoSolAmount, solPriceUsd, instructionCount: instructions.length };
}

/**
 * Computes lamports from USD size. Only fetches SOL price — no RPC calls.
 * Safe to call in DRY_RUN mode.
 */
export async function computeJitoDepositParams(sizeUsd: number): Promise<JitoDepositParams> {
  const solPriceUsd = await fetchSolPriceUsd();
  const lamports = Math.floor((sizeUsd / solPriceUsd) * LAMPORTS_PER_SOL);
  return { lamports, solPriceUsd };
}

/**
 * Builds a real Jito depositSol transaction. Requires a live RPC connection and
 * the agent wallet to hold at least `lamports` of SOL.
 */
export async function buildJitoDepositTx(
  connection: Connection,
  config: AgentConfig,
  sizeUsd: number,
): Promise<JitoBuildResult> {
  const walletAddress = config.agentWalletAddress
    ? new PublicKey(config.agentWalletAddress)
    : PublicKey.default;

  const { lamports, solPriceUsd } = await computeJitoDepositParams(sizeUsd);

  logger.info({ sizeUsd, solPriceUsd, lamports }, 'Building Jito depositSol tx');

  const { instructions, signers } = await depositSol(
    connection,
    JITO_STAKE_POOL,
    walletAddress,
    lamports,
  );

  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const tx = new Transaction();
  tx.feePayer = walletAddress;
  tx.recentBlockhash = blockhash;
  tx.add(...instructions);

  // Sign with the ephemeral transfer keypair created inside depositSol
  if (signers.length > 0) {
    tx.partialSign(...signers);
  }

  return { tx, lamports, solPriceUsd, instructionCount: instructions.length };
}
