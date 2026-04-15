import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import axios, { AxiosError } from 'axios';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const JUPITER_CONFIG = {
  BASE_URL: 'https://api.jup.ag',
  FREE_TIER_RPS: 5, // 50 requests per 10s window for free tier
  MIN_RETRY_DELAY_MS: 1000,
  MAX_RETRY_DELAY_MS: 15000,
  MAX_RETRIES: 3,
  QUOTE_TIMEOUT_MS: 10_000,
  EXECUTE_TIMEOUT_MS: 30_000,
};

interface JupiterError {
  code: string | number;
  message: string;
  retryable: boolean;
}

export interface SwapQuote {
  inAmount: string;
  outAmount: string;
  priceImpactPct: number;
  feeBps?: number;
  feeMint?: string;
  requestId: string;
}

export interface SwapResult {
  success: boolean;
  txSignature?: string;
  error?: string;
  quote?: SwapQuote;
}

export interface WalletBalance {
  mint: string;
  symbol: string;
  amount: number;
  amountUsd: number;
}

class RateLimiter {
  private lastRequestTime = 0;
  private minIntervalMs: number;

  constructor(requestsPerSecond: number) {
    this.minIntervalMs = Math.floor(1000 / requestsPerSecond);
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minIntervalMs) {
      const waitTime = this.minIntervalMs - elapsed;
      logger.debug({ waitMs: waitTime }, 'Rate limiter: waiting before request');
      await this.sleep(waitTime);
    }
    this.lastRequestTime = Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function isRetryableError(error: JupiterError): boolean {
  if (error.retryable) return true;
  const retryableCodes = [-1, -1000, -1001, -1004, -2000, -2001, -2003, -2004, 429];
  return retryableCodes.includes(Number(error.code));
}

async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries = JUPITER_CONFIG.MAX_RETRIES
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;

      if (attempt === maxRetries) {
        logger.error({ attempt, error: err }, `${operationName} failed after ${maxRetries} retries`);
        break;
      }

      const axiosError = err as AxiosError;
      const status = axiosError.response?.status;
      const errorData = axiosError.response?.data as { code?: string | number; message?: string } | undefined;

      const jupiterError: JupiterError = {
        code: errorData?.code ?? status ?? 'UNKNOWN',
        message: errorData?.message ?? axiosError.message ?? 'Unknown error',
        retryable: status === 429 || isRetryableError(errorData as JupiterError),
      };

      if (!jupiterError.retryable) {
        logger.error({ attempt, error: jupiterError }, `${operationName} failed with non-retryable error`);
        break;
      }

      const baseDelay = 10_000; // Jupiter docs: wait 10s sliding window refresh
      const exponentialDelay = Math.min(baseDelay * Math.pow(2, attempt), JUPITER_CONFIG.MAX_RETRY_DELAY_MS);
      const jitter = Math.random() * 1000;
      const delay = exponentialDelay + jitter;

      logger.warn(
        { attempt, delayMs: Math.round(delay), error: jupiterError },
        `${operationName} failed, retrying...`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

export class JupiterSwapService {
  private connection: Connection;
  private wallet: Keypair | null = null;
  private apiKey: string;
  private rateLimiter: RateLimiter;

  constructor(connection: Connection, wallet: Keypair | null = null) {
    this.connection = connection;
    this.wallet = wallet;
    this.apiKey = process.env['JUPITER_API_KEY'] ?? '';
    this.rateLimiter = new RateLimiter(JUPITER_CONFIG.FREE_TIER_RPS);
  }

  setWallet(wallet: Keypair): void {
    this.wallet = wallet;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }
    return headers;
  }

  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 50
  ): Promise<SwapQuote | null> {
    if (!this.wallet) {
      logger.error('Wallet not available for quote');
      return null;
    }

    const operation = async (): Promise<SwapQuote> => {
      await this.rateLimiter.acquire();

      const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amount.toString(),
        slippageBps: slippageBps.toString(),
        taker: this.wallet!.publicKey.toBase58(),
      });

      const response = await axios.get(
        `${JUPITER_CONFIG.BASE_URL}/swap/v2/order?${params}`,
        {
          headers: this.getHeaders(),
          timeout: JUPITER_CONFIG.QUOTE_TIMEOUT_MS,
        }
      );

      if (response.data.error) {
        throw { code: response.data.code ?? 'ORDER_ERROR', message: response.data.error, retryable: false };
      }

      return {
        inAmount: response.data.inAmount ?? amount.toString(),
        outAmount: response.data.outAmount ?? response.data.outAmountResult ?? '0',
        priceImpactPct: response.data.priceImpactPct ?? 0,
        feeBps: response.data.feeBps,
        feeMint: response.data.feeMint,
        requestId: response.data.requestId,
      };
    };

    try {
      return await withRetry(operation, 'Jupiter getQuote');
    } catch (err) {
      logger.error({ err, inputMint, outputMint }, 'Failed to get Jupiter swap quote');
      return null;
    }
  }

  async executeSwap(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 50
  ): Promise<SwapResult> {
    if (!this.wallet) {
      return { success: false, error: 'Wallet not available' };
    }

    const operation = async (): Promise<SwapResult> => {
      const quote = await this.getQuote(inputMint, outputMint, amount, slippageBps);
      if (!quote) {
        return { success: false, error: 'Failed to get swap quote' };
      }

      await this.rateLimiter.acquire();

      const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amount.toString(),
        slippageBps: slippageBps.toString(),
        taker: this.wallet!.publicKey.toBase58(),
      });

      const orderResponse = await axios.get(
        `${JUPITER_CONFIG.BASE_URL}/swap/v2/order?${params}`,
        {
          headers: this.getHeaders(),
          timeout: JUPITER_CONFIG.QUOTE_TIMEOUT_MS,
        }
      );

      if (orderResponse.data.error || !orderResponse.data.transaction) {
        const code = orderResponse.data.code ?? 'ORDER_ERROR';
        const retryable = [-1, -1000, -1004, -2000, -2003, -2004].includes(Number(code));
        throw { code, message: orderResponse.data.error ?? 'No transaction returned', retryable };
      }

      const txBuf = Buffer.from(orderResponse.data.transaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([this.wallet!]);
      const signedTx = Buffer.from(tx.serialize()).toString('base64');

      await this.rateLimiter.acquire();

      const executeResponse = await axios.post(
        `${JUPITER_CONFIG.BASE_URL}/swap/v2/execute`,
        {
          signedTransaction: signedTx,
          requestId: orderResponse.data.requestId,
        },
        {
          headers: this.getHeaders(),
          timeout: JUPITER_CONFIG.EXECUTE_TIMEOUT_MS,
        }
      );

      const result = executeResponse.data;

      if (result.status === 'Success') {
        logger.info({
          signature: result.signature,
          inputMint,
          outputMint,
          outAmount: result.outputAmountResult,
        }, 'Jupiter swap executed');

        return {
          success: true,
          txSignature: result.signature,
          quote: {
            ...quote,
            outAmount: result.outputAmountResult ?? quote.outAmount,
          },
        };
      }

      const code = result.code ?? 'EXECUTE_ERROR';
      const retryable = [-1, -1000, -1001, -1004, -2000, -2001, -2003, -2004].includes(Number(code));
      throw { code, message: result.error ?? `Execute failed with code ${code}`, retryable };
    };

    try {
      return await withRetry(operation, 'Jupiter executeSwap');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err, inputMint, outputMint }, 'Jupiter swap failed');
      return { success: false, error: errorMsg };
    }
  }

  async getWalletBalances(): Promise<WalletBalance[]> {
    if (!this.wallet) {
      logger.warn('Wallet not available for balance check');
      return [];
    }

    const balances: WalletBalance[] = [];

    try {
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(this.wallet.publicKey, {
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      });

      const solAccount = await this.connection.getAccountInfo(this.wallet.publicKey);
      const solBalance = solAccount ? solAccount.lamports / 1e9 : 0;

      balances.push({
        mint: SOL_MINT,
        symbol: 'SOL',
        amount: solBalance,
        amountUsd: 0,
      });

      for (const account of tokenAccounts.value) {
        const info = account.account.data.parsed.info;
        const mint = info.mint;
        const amount = info.tokenAmount.uiAmount ?? 0;

        if (amount > 0) {
          balances.push({
            mint,
            symbol: mint.slice(0, 6),
            amount,
            amountUsd: 0,
          });
        }
      }

      return balances;
    } catch (err) {
      logger.error({ err }, 'Failed to fetch wallet balances');
      return [];
    }
  }
}

let _jupiterService: JupiterSwapService | null = null;

export function getJupiterSwapService(connection?: Connection): JupiterSwapService {
  if (!_jupiterService && connection) {
    _jupiterService = new JupiterSwapService(connection);
  }
  return _jupiterService!;
}

export function resetJupiterSwapService(): void {
  _jupiterService = null;
}
