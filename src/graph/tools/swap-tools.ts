import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { interrupt } from '@langchain/langgraph';
import type { Connection } from '@solana/web3.js';
import type { AgentConfig } from '../../config/loader.js';
import { JupiterSwapService } from '../../executor/jupiter.js';
import { loadWalletKeypair } from '../../executor/wallet.js';
import { fetchSolPriceUsd } from '../../utils/price.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sc = <T extends z.ZodRawShape>(s: z.ZodObject<T>): any => s;

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export function createSwapTools(config: AgentConfig, connection: Connection) {
  const swapConfig = config.swap ?? { enabled: true, hitl_threshold_usd: 100, default_slippage_bps: 50 };

  if (!swapConfig.enabled) {
    return {
      getSwapQuote: null,
      executeSwap: null,
      getWalletBalances: null,
    };
  }

  const getSwapQuoteTool = tool(
    async ({ inputMint, outputMint, amount }: { inputMint: string; outputMint: string; amount: number }) => {
      const wallet = await loadWalletKeypair();
      if (!wallet) {
        return JSON.stringify({ success: false, error: 'Wallet not available. Set WALLET_PRIVATE_KEY env var.' });
      }

      const service = new JupiterSwapService(connection, wallet);
      const quote = await service.getQuote(inputMint, outputMint, amount, swapConfig.default_slippage_bps);

      if (!quote) {
        return JSON.stringify({ success: false, error: 'Failed to get quote from Jupiter' });
      }

      return JSON.stringify({
        success: true,
        inAmount: quote.inAmount,
        outAmount: quote.outAmount,
        priceImpactPct: quote.priceImpactPct,
        feeBps: quote.feeBps,
        requestId: quote.requestId,
      });
    },
    {
      name: 'get_swap_quote',
      description: 'Get a Jupiter swap quote. Returns estimated output amount and price impact. Use this to preview a swap before executing.',
      schema: sc(z.object({
        inputMint: z.string().describe('Input token mint address (e.g., SOL = So11111111111111111111111111111111111111112)'),
        outputMint: z.string().describe('Output token mint address (e.g., USDC = EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)'),
        amount: z.number().describe('Amount in base units (lamports for SOL, small unit for other tokens)'),
      })),
    }
  );

  const executeSwapTool = tool(
    async ({ inputMint, outputMint, amount, slippageBps }: {
      inputMint: string; outputMint: string; amount: number; slippageBps?: number;
    }) => {
      const wallet = await loadWalletKeypair();
      if (!wallet) {
        return JSON.stringify({ success: false, error: 'Wallet not available. Set WALLET_PRIVATE_KEY env var.' });
      }

      const service = new JupiterSwapService(connection, wallet);

      const quote = await service.getQuote(inputMint, outputMint, amount, slippageBps ?? swapConfig.default_slippage_bps);
      if (!quote) {
        return JSON.stringify({ success: false, error: 'Failed to get quote from Jupiter' });
      }

      const solPrice = await fetchSolPriceUsd();
      const amountUsd = (Number(quote.inAmount) / 1e9) * solPrice;

      if (amountUsd > swapConfig.hitl_threshold_usd) {
        const decision = interrupt({
          action: 'execute_swap',
          inputMint,
          outputMint,
          amount,
          amountUsd,
          estimatedOutAmount: quote.outAmount,
          priceImpactPct: quote.priceImpactPct,
          message: `Swap ~$${amountUsd.toFixed(2)}? (${amount} base units → ${quote.outAmount})`,
        });
        if (decision !== 'approved') {
          return JSON.stringify({ success: false, reason: 'rejected_by_human' });
        }
      }

      const result = await service.executeSwap(inputMint, outputMint, amount, slippageBps ?? swapConfig.default_slippage_bps);
      return JSON.stringify(result);
    },
    {
      name: 'execute_swap',
      description: 'Execute a Jupiter swap. Will require human approval if amount exceeds configured threshold.',
      schema: sc(z.object({
        inputMint: z.string().describe('Input token mint address'),
        outputMint: z.string().describe('Output token mint address'),
        amount: z.number().describe('Amount in base units'),
        slippageBps: z.number().optional().describe('Slippage in basis points (default from config)'),
      })),
    }
  );

  const getWalletBalancesTool = tool(
    async () => {
      const wallet = await loadWalletKeypair();
      if (!wallet) {
        return JSON.stringify({ success: false, error: 'Wallet not available. Set WALLET_PRIVATE_KEY env var.' });
      }

      const service = new JupiterSwapService(connection, wallet);
      const balances = await service.getWalletBalances();

      const solPrice = await fetchSolPriceUsd();
      for (const balance of balances) {
        if (balance.mint === SOL_MINT) {
          balance.amountUsd = balance.amount * solPrice;
        }
      }

      return JSON.stringify({
        success: true,
        balances,
      });
    },
    {
      name: 'get_wallet_balances',
      description: 'Get all token balances in the wallet. Returns mint, symbol, amount, and USD value.',
      schema: sc(z.object({})),
    }
  );

  return {
    getSwapQuote: getSwapQuoteTool,
    executeSwap: executeSwapTool,
    getWalletBalances: getWalletBalancesTool,
  };
}
