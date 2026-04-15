import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { JupiterSwapService, getJupiterSwapService, type SwapQuote, type SwapResult, type WalletBalance } from './jupiter.js';

// ---------------------------------------------------------------------------
// Wallet keypair management
// ---------------------------------------------------------------------------

let _walletKeypair: Keypair | null = null;

export function getWalletKeypair(): Keypair | null {
  return _walletKeypair;
}

export function isWalletConfigured(): boolean {
  return !!process.env['WALLET_PRIVATE_KEY'];
}

export async function loadWalletKeypair(): Promise<Keypair | null> {
  if (_walletKeypair) return _walletKeypair;

  const privateKeyBase58 = process.env['WALLET_PRIVATE_KEY'];
  if (!privateKeyBase58) {
    logger.warn('WALLET_PRIVATE_KEY env var not set — wallet operations will fail');
    return null;
  }

  try {
    const { default: bs58 } = await import('bs58');
    const decoded = bs58.decode(privateKeyBase58);
    _walletKeypair = Keypair.fromSecretKey(decoded);
    logger.info({ address: _walletKeypair.publicKey.toBase58() }, 'Wallet keypair loaded');
    return _walletKeypair;
  } catch (err) {
    logger.error({ err }, 'Failed to decode WALLET_PRIVATE_KEY');
    return null;
  }
}

export function resetWalletKeypair(): void {
  _walletKeypair = null;
}

// ---------------------------------------------------------------------------
// Transaction signing and submission
// ---------------------------------------------------------------------------

export async function signAndSendTransactions(
  connection: Connection,
  txs: Transaction[],
  commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed'
): Promise<string[]> {
  const wallet = await loadWalletKeypair();
  if (!wallet) throw new Error('Wallet not available');

  const signatures: string[] = [];

  for (const tx of txs) {
    try {
      const signature = await sendAndConfirmTransaction(connection, tx, [wallet], {
        commitment,
        skipPreflight: false,
      });
      signatures.push(signature);
      logger.info({ signature, commitment }, 'Transaction confirmed');
    } catch (err) {
      logger.error({ err }, 'Transaction failed');
      throw err;
    }
  }

  return signatures;
}

export async function simulateTransactions(
  connection: Connection,
  txs: Transaction[]
): Promise<{ success: boolean; logs: string[] }[]> {
  const results: { success: boolean; logs: string[] }[] = [];

  for (const tx of txs) {
    try {
      const sim = await connection.simulateTransaction(tx, undefined, true);
      results.push({
        success: sim.value.err === null,
        logs: sim.value.logs ?? [],
      });
    } catch (err) {
      results.push({ success: false, logs: [String(err)] });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Jupiter swap integration (delegates to jupiter.ts)
// ---------------------------------------------------------------------------

export async function swapToken(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number = 50
): Promise<{ success: boolean; txSignature?: string; error?: string }> {
  const wallet = await loadWalletKeypair();
  if (!wallet) return { success: false, error: 'Wallet not available' };

  const connection = new Connection(
    process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com',
    { commitment: 'confirmed' }
  );

  const service = new JupiterSwapService(connection, wallet);
  return service.executeSwap(inputMint, outputMint, amount, slippageBps);
}
