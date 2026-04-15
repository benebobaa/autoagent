import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentConfig } from '../../config/loader.js';
import type { Database } from '../../positions/db.js';
import { fetchMeteoraOpportunities } from '../../scanner/meteora.js';
import { fetchDefiLlamaPools } from '../../scanner/defillama.js';
import { scoreAll, type ScoredOpportunity } from '../../scoring/engine.js';
import { logger } from '../../utils/logger.js';
import { computeConcentratedIL, computeFeeEfficiency } from '../../positions/il-calculator.js';
import { ensureDlmmPositionRecord, fetchOpenDlmmPoolPositions } from '../../positions/dlmm-sync.js';

// Cast helper for LangChain tool() + zod compilation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sc = <T extends z.ZodRawShape>(s: z.ZodObject<T>): any => s;

function parseNum(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function createMeteoraTools(config: AgentConfig, db: Database) {
  const scanMeteoraPools = tool(
    async (params: { minTvlUsd?: number; minFeeApr?: number; tokenPairs?: string[]; maxBinStep?: number; requireInRangeLiquidityPct?: number }) => {
      logger.info(params, 'Agent scanning Meteora pools');
      
      const llamaPools = await fetchDefiLlamaPools(config.defillamaBaseUrl);
      const rawOpportunities = await fetchMeteoraOpportunities(llamaPools, config);
      
      // We can apply custom tool-level filters if requested by the agent
      const minFeeAprPct = params.minFeeApr ? params.minFeeApr * 100 : 0;
      
      let filtered = rawOpportunities;
      
      if (params.tokenPairs && params.tokenPairs.length > 0) {
        filtered = filtered.filter(opp => 
          params.tokenPairs!.some((pair: string) => opp.poolName.includes(pair))
        );
      }
      
      if (params.minTvlUsd) {
        filtered = filtered.filter(opp => opp.tvlUsd >= params.minTvlUsd!);
      }
      
      if (minFeeAprPct > 0) {
        filtered = filtered.filter(opp => (opp.apyProtocol ?? opp.apyUsed) >= minFeeAprPct);
      }
      
      if (params.maxBinStep) {
        // Assume raw_data JSON has binStep
        filtered = filtered.filter((opp: any) => {
           if (opp.raw_data && opp.raw_data.binStep !== undefined) {
               return opp.raw_data.binStep <= params.maxBinStep!;
           }
           return true; 
        });
      }

      if (params.requireInRangeLiquidityPct) {
        filtered = filtered.filter((opp: any) => {
          if (opp.raw_data && opp.raw_data.liquidityInActiveBins !== undefined) {
             const pct = opp.raw_data.liquidityInActiveBins / opp.tvlUsd;
             return pct >= params.requireInRangeLiquidityPct!;
          }
          return true; // We don't exclude if we lack data, but we might flag it
        });
      }

      const scored = scoreAll(filtered, config);
      
      // Sort and slice top results to stay within context windows
      const topOpps = scored
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
        
      if (topOpps.length === 0) {
        return "No Meteora DLMM pools matched the specified criteria.";
      }
      
      return JSON.stringify(
        topOpps.map(opp => ({
          poolId: opp.poolId,
          poolName: opp.poolName,
          baseApiUsed: opp.apyUsed,
          riskAdjustedScore: opp.score,
          recommendation: opp.recommendation,
          extendedData: (opp as any).raw_data || {}
        })),
        null,
        2
      );
    },
    {
      name: 'scan_meteora_pools',
      description: 'Fetch and rank currently active Meteora DLMM liquidity pools based on risk-adjusted scores.',
      schema: sc(
        z.object({
          minTvlUsd: z.number().optional().describe('Minimum TVL in USD (default config value used if omitted)'),
          minFeeApr: z.number().optional().describe('Minimum Fee APR expressed as decimal (e.g. 0.20 for 20%)'),
          tokenPairs: z.array(z.string()).optional().describe('List of token pairs to look for, e.g. ["SOL-USDC", "JitoSOL-SOL"]'),
          maxBinStep: z.number().optional().describe('Maximum allowed bin step for the DLMM pool'),
          requireInRangeLiquidityPct: z.number().optional().describe('Minimum percentage of TVL that must reside in active bins (0.0 to 1.0)'),
        })
      ),
    }
  );

  const getMeteoraPositionStatus = tool(
    async ({ walletAddress }) => {
      logger.info({ walletAddress }, 'Agent requesting Meteora position status');
      
      const targetWallet = (walletAddress as string | undefined) || config.agentWalletAddress;
      if (!targetWallet) {
        return "Error: No wallet address provided and agentWalletAddress not set in config/env.";
      }

      if (config.agentWalletAddress && targetWallet !== config.agentWalletAddress) {
        return JSON.stringify({
          wallet: targetWallet,
          advisory: 'Only the configured agent wallet is fully supported for tracked Meteora status queries.',
          positions: [],
        });
      }

      const trackedPositions = (await db.getPositionsByState('ACTIVE')).filter((position) => position.protocol === 'meteora_dlmm');
      const statuses = await Promise.all(trackedPositions.map(async (position) => {
        const dlmm = await ensureDlmmPositionRecord(db, position, targetWallet, config.meteora.preferred_strategy);
        if (!dlmm) {
          return {
            positionId: position.id,
            poolId: position.pool_id,
            poolName: position.pool_name,
            tracked: false,
            reason: 'No live DLMM position metadata found for this active position.',
          };
        }

        const entries = await fetchOpenDlmmPoolPositions(position.pool_id, targetWallet);
        const live = entries.find((entry) => (entry.positionAddress ?? entry.position) === dlmm.position_pubkey);
        if (!live) {
          return {
            positionId: position.id,
            poolId: position.pool_id,
            poolName: position.pool_name,
            tracked: true,
            positionPubkey: dlmm.position_pubkey,
            inRange: null,
            reason: 'Live PnL entry not returned by Meteora API for this position.',
          };
        }

        const unclaimedFeesUsd =
          parseNum(live.unrealizedPnl?.unclaimedFeeTokenX?.usd) +
          parseNum(live.unrealizedPnl?.unclaimedFeeTokenY?.usd);

        return {
          positionId: position.id,
          poolId: position.pool_id,
          poolName: position.pool_name,
          tracked: true,
          positionPubkey: dlmm.position_pubkey,
          inRange: !(live.isOutOfRange ?? false),
          lowerBinId: live.lowerBinId ?? dlmm.lower_bin_id,
          upperBinId: live.upperBinId ?? dlmm.upper_bin_id,
          activeBinId: live.poolActiveBinId ?? null,
          pnlUsd: Math.round(parseNum(live.pnlUsd) * 100) / 100,
          pnlPct: Math.round(parseNum(live.pnlPctChange) * 100) / 100,
          currentValueUsd: Math.round(parseNum(live.unrealizedPnl?.balances) * 100) / 100,
          unclaimedFeesUsd: Math.round(unclaimedFeesUsd * 100) / 100,
          allTimeFeesUsd: Math.round(parseNum(live.allTimeFees?.total?.usd) * 100) / 100,
          feePerTvl24h: Math.round(parseNum(live.feePerTvl24h) * 100) / 100,
          ageMinutes: live.createdAt ? Math.floor((Date.now() - live.createdAt * 1000) / 60000) : null,
        };
      }));

      return JSON.stringify({
        wallet: targetWallet,
        tracked_positions: statuses.filter((status) => status.tracked).length,
        unresolved_positions: statuses.filter((status) => !status.tracked || status.inRange === null).length,
        positions: statuses,
      });
    },
    {
      name: 'get_meteora_position_status',
      description: 'Retrieves current on-chain metrics (in-range status, unclaimed fees, IL estimate) for DLMM positions owned by a wallet.',
      schema: sc(
        z.object({
          walletAddress: z.string().optional().describe('Optional wallet address. Defaults to the agent\'s configured wallet if omitted.'),
        })
      ),
    }
  );

  const computeIlRisk = tool(
    async (params: {
      entryPriceSol: number;
      currentPriceSol: number;
      lowerBinPrice: number;
      upperBinPrice: number;
      binStepBps: number;
      volume24hUsd: number;
      tvlUsd: number;
      timeInRangeRatio?: number;
    }) => {
      const timeInRange = params.timeInRangeRatio ?? 0.8;

      const concIL = computeConcentratedIL({
        entryPrice: params.entryPriceSol,
        currentPrice: params.currentPriceSol,
        lowerBinPrice: params.lowerBinPrice,
        upperBinPrice: params.upperBinPrice,
        binStep: params.binStepBps,
      });

      const feeEff = computeFeeEfficiency({
        binStepBps: params.binStepBps,
        volume24hUsd: params.volume24hUsd,
        expectedIlPct: Math.abs(concIL.ilPct),
        timeInRangeRatio: timeInRange,
        tvlUsd: params.tvlUsd,
      });

      return JSON.stringify({
        isOutOfRange: concIL.isOutOfRange,
        ilPct: (concIL.ilPct * 100).toFixed(2),
        leverageFactor: concIL.leverageFactor.toFixed(2),
        feeEfficiency: feeEff.toFixed(2),
        recommendation: feeEff > 1 ? 'FAVORABLE' : feeEff > 0.5 ? 'MODERATE' : 'UNFAVORABLE',
      });
    },
    {
      name: 'compute_il_risk',
      description: 'Compute IL risk and fee efficiency for a Meteora DLMM position or hypothetical position.',
      schema: sc(
        z.object({
          entryPriceSol: z.number().describe('Entry price in SOL'),
          currentPriceSol: z.number().describe('Current SOL price'),
          lowerBinPrice: z.number().describe('Lower bin price boundary'),
          upperBinPrice: z.number().describe('Upper bin price boundary'),
          binStepBps: z.number().describe('Bin step in basis points (e.g. 50 for 0.5%)'),
          volume24hUsd: z.number().describe('24h trading volume in USD'),
          tvlUsd: z.number().describe('Total value locked in USD'),
          timeInRangeRatio: z.number().optional().describe('Estimated time in range ratio (0.0-1.0, default: 0.8)'),
        })
      ),
    }
  );

  return {
    scanMeteoraPools,
    getMeteoraPositionStatus,
    computeIlRisk,
  };
}
export type MeteoraTools = ReturnType<typeof createMeteoraTools>;
