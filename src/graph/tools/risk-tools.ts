import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { Connection } from '@solana/web3.js';
import { createSolanaRpc } from '@solana/rpc';
import type { AgentConfig } from '../../config/loader.js';
import type { Database } from '../../positions/db.js';
import { scoreOpportunity, type RawOpportunity } from '../../scoring/engine.js';
import { computeCashFlowPnl, computeMtmPnl, computeBlendedApy } from '../../positions/pnl.js';
import { detectSignals } from '../../signals/detector.js';
import type { RAGStore } from '../../rag/store.js';
import { queryPastDecisions } from '../../rag/query.js';
import { fetchSolPriceHistory } from '../../utils/coingecko.js';
import { detectRegime, getRegimeWeights, getRegimeStrategyBias, DEFAULT_REGIME_CONFIG } from '../../signals/regime.js';
import type { MarketRegime } from '../../signals/regime.js';
import { classifyPool, getExposureByGroup, checkConcentrationRisk, type CorrelationGroup } from '../../scoring/correlation.js';
import { buildPoolExperienceBrief } from '../../rag/experience-injector.js';
import { DEFAULT_TIER_CONFIGS } from '../../config/risk-tiers.js';

type KitRpc = ReturnType<typeof createSolanaRpc>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sc = <T extends z.ZodRawShape>(s: z.ZodObject<T>): any => s;

export function createRiskTools(
  config: AgentConfig,
  db: Database,
  _connection: Connection,
  _kitRpc: KitRpc,
  ragStore: RAGStore
) {
  const scoreTierOpportunityTool = tool(
    async (input: {
      tier: number;
      apyPct: number;
      volume24hUsd: number;
      tvlUsd: number;
      priceChange1hPct: number;
      ilRiskScore: number;
    }) => {
      const tierConfig = DEFAULT_TIER_CONFIGS[input.tier as keyof typeof DEFAULT_TIER_CONFIGS];
      if (!tierConfig) {
        return JSON.stringify({ success: false, error: `Unknown risk tier: ${input.tier}` });
      }

      const apyNorm = Math.min(input.apyPct / Math.max(tierConfig.target_apy_pct * 2, 1), 1);
      const volumeNorm = Math.min(input.volume24hUsd / 1_000_000, 1);
      const tvlNorm = tierConfig.max_pool_tvl_usd > 0 ? Math.min(input.tvlUsd / tierConfig.max_pool_tvl_usd, 1) : 0.5;
      const momentumNorm = Math.max(Math.min(input.priceChange1hPct / 30, 1), 0);
      const ilNorm = 1 - input.ilRiskScore;
      const opportunityScore = Math.round((
        tierConfig.score_weight_apy * apyNorm +
        tierConfig.score_weight_volume * volumeNorm +
        tierConfig.score_weight_tvl * tvlNorm +
        tierConfig.score_weight_momentum * momentumNorm +
        tierConfig.score_weight_il_risk * ilNorm
      ) * 10000) / 100;

      return JSON.stringify({
        success: true,
        tier: input.tier,
        tierLabel: tierConfig.label,
        opportunityScore,
        maxPositionSizeUsd: tierConfig.max_position_size_usd,
        positionStyle: tierConfig.meteora_position_style,
        requireHumanApproval: tierConfig.require_human_approval,
      });
    },
    {
      name: 'score_tier_opportunity',
      description: 'Score an opportunity 0-100 using tier-specific weights and return the relevant tier constraints.',
      schema: sc(z.object({
        tier: z.number().int(),
        apyPct: z.number(),
        volume24hUsd: z.number(),
        tvlUsd: z.number(),
        priceChange1hPct: z.number(),
        ilRiskScore: z.number().min(0).max(1),
      })),
    }
  );

  const scoreOpportunityTool = tool(
    async (input: {
      poolId: string; protocol: string; poolName: string;
      apyDefillama: number | null; apyProtocol: number | null;
      apyUsed: number; tvlUsd: number; dataUncertain: boolean;
      book?: 'core' | 'scout';
    }) => {
      const raw: RawOpportunity = {
        poolId: input.poolId,
        protocol: input.protocol as RawOpportunity['protocol'],
        poolName: input.poolName,
        apyDefillama: input.apyDefillama,
        apyProtocol: input.apyProtocol,
        apyUsed: input.apyUsed,
        tvlUsd: input.tvlUsd,
        dataUncertain: input.dataUncertain,
      };
      
      const score = scoreOpportunity(raw, config);
      const experience = await buildPoolExperienceBrief(db, ragStore, input.protocol, input.poolId, input.book ?? null);
      
      return JSON.stringify({
        ...score,
        pastExperience: experience || 'No significant past experience for this protocol/pool.',
      });
    },
    {
      name: 'score_opportunity',
      description: 'Score a single yield opportunity. Returns score 0-100 and SUGGEST/WATCH/SKIP recommendation.',
      schema: sc(z.object({
        poolId: z.string(),
        protocol: z.string(),
        poolName: z.string(),
        apyDefillama: z.number().nullable(),
        apyProtocol: z.number().nullable(),
        apyUsed: z.number(),
        tvlUsd: z.number(),
        dataUncertain: z.boolean(),
        book: z.enum(['core', 'scout']).optional(),
      })),
    }
  );

  const computePortfolioPnl = tool(
    async () => {
      const active = await db.getPositionsByState('ACTIVE');
      const cfPnls = active.map((p) => computeCashFlowPnl(p));
      const mtmPnls = await Promise.all(active.map(async (p) => computeMtmPnl(p, await db.getLatestPnlSnapshot(p.id, 'mark_to_market'))));
      const realizedPnls = await Promise.all(active.map((p) => db.getRealizedPnl(p.id)));

      return JSON.stringify({
        activePositions: active.length,
        deployedUsd: active.reduce((s, p) => s + p.size_usd, 0),
        blendedApyPct: computeBlendedApy(active),
        totalCashFlowPnlUsd: cfPnls.reduce((s, p) => s + p.cashFlowPnlUsd, 0),
        totalMtmPnlUsd: mtmPnls.reduce((s, p) => s + p.mtmPnlUsd, 0),
        totalRealizedPnlUsd: realizedPnls.reduce((s, p) => s + (p?.net_pnl_usd ?? 0), 0),
        positions: active.map((p, i) => ({
          id: p.id, protocol: p.protocol, poolName: p.pool_name,
          book: p.book,
          sizeUsd: p.size_usd, entryApy: p.entry_apy,
          cashFlowPnl: cfPnls[i]?.cashFlowPnlUsd ?? 0,
          mtmPnl: mtmPnls[i]?.mtmPnlUsd ?? 0,
          daysHeld: cfPnls[i]?.daysHeld ?? 0,
          realizedPnl: realizedPnls[i]?.net_pnl_usd ?? null,
          realizedApy: realizedPnls[i]?.realized_apy_pct ?? null,
        })),
      });
    },
    {
      name: 'compute_portfolio_pnl',
      description: 'Compute PnL for all active positions — cash flow, MtM, blended APY, deployed capital, and realized PnL from APY snapshots.',
      schema: sc(z.object({})),
    }
  );

  const checkSignals = tool(
    async () => {
      const currentRaw = await db.getLatestSnapshot();
      if (!currentRaw) return JSON.stringify({ signals: [], message: 'No snapshot yet' });
      const current = currentRaw as import('../../signals/snapshot.js').MarketSnapshot;
      const previous = await db.getPreviousSnapshot() as import('../../signals/snapshot.js').MarketSnapshot | null;
      const signals = detectSignals(current, previous, await db.getPositionsByState('ACTIVE'), config);
      return JSON.stringify({
        total: signals.length,
        critical: signals.filter((s) => s.priority === 'CRITICAL').length,
        high: signals.filter((s) => s.priority === 'HIGH').length,
        low: signals.filter((s) => s.priority === 'LOW').length,
        signals: signals.map((s) => ({ type: s.type, priority: s.priority, payload: s.payload })),
      });
    },
    {
      name: 'check_signals',
      description: 'Run signal detection on the latest market snapshot. Returns active signals by priority.',
      schema: sc(z.object({})),
    }
  );

  const getMarketRegime = tool(
    async ({ lookbackHours }: { lookbackHours?: number }) => {
      try {
        const hours = lookbackHours ?? 168;
        const days = Math.ceil(hours / 24);
        const priceHistory = await fetchSolPriceHistory(Math.min(days, 7));

        const regimeConfig = config.regime ?? DEFAULT_REGIME_CONFIG;
        const result = detectRegime(priceHistory.points, {
          bullThresholdPct: regimeConfig.bull_threshold_pct,
          bearThresholdPct: regimeConfig.bear_threshold_pct,
          highVolAtrRatio: regimeConfig.high_vol_atr_ratio,
          lowVolAtrRatio: regimeConfig.low_vol_atr_ratio,
          capitulationDropPct: regimeConfig.capitulation_drop_pct,
          euphoriaRisePct: regimeConfig.euphoria_rise_pct,
        });

        const weights = getRegimeWeights(result.regime);
        const bias = getRegimeStrategyBias(result.regime);

        return JSON.stringify({
          regime: result.regime,
          confidence: result.confidence,
          priceChangePct: result.priceChangePct.toFixed(2),
          atrRatio: result.atrRatio.toFixed(4),
          volumeTrend: result.volumeTrend,
          strategyBias: bias,
          weights: {
            apyWeight: weights.apyWeight,
            liquidityWeight: weights.liquidityWeight,
            trustWeight: weights.trustWeight,
            riskPenaltyWeight: weights.riskPenaltyWeight,
          },
        });
      } catch (err) {
        return JSON.stringify({
          regime: 'unknown',
          error: String(err),
        });
      }
    },
    {
      name: 'get_market_regime',
      description: 'Detect the current market regime (6-state: BULL_TREND, BEAR_TREND, HIGH_VOL_RANGE, LOW_VOL_RANGE, CAPITULATION, EUPHORIA) based on SOL price history from CoinGecko.',
      schema: sc(z.object({
        lookbackHours: z.number().optional().describe('Hours to look back (default: 168 = 7 days)'),
      })),
    }
  );

  const recallPastDecisions = tool(
    async ({ signalTypes, k }: { signalTypes: string[]; k?: number }) => {
      try {
        const results = await queryPastDecisions(ragStore, signalTypes, k ?? 3);
        if (results.length === 0) return JSON.stringify({ message: 'No past decisions found', results: [] });
        return JSON.stringify({
          count: results.length,
          results: results.map((r) => ({ text: r.text, metadata: r.metadata, relevance: 1 - r.distance })),
        });
      } catch {
        return JSON.stringify({ message: 'RAG unavailable', results: [] });
      }
    },
    {
      name: 'recall_past_decisions',
      description: 'Search past agent decisions for similar signal types to inform current reasoning.',
      schema: sc(z.object({
        signalTypes: z.array(z.string()).describe('Signal types to search for'),
        k: z.number().optional().describe('Number of results (default: 3)'),
      })),
    }
  );

  const checkConcentration = tool(
    async ({ poolId, protocol, poolName, sizeUsd, totalCapitalUsd }: {
      poolId: string;
      protocol: string;
      poolName: string;
      sizeUsd: number;
      totalCapitalUsd: number;
    }) => {
      const active = await db.getPositionsByState('ACTIVE');
      const currentExposure = getExposureByGroup(active);
      const group = classifyPool(protocol, poolName);

      const maxGroupPct = (config as AgentConfig).position.max_group_concentration_pct;

      const result = checkConcentrationRisk({
        currentExposure,
        newPosition: { group, sizeUsd },
        maxGroupConcentrationPct: maxGroupPct,
        totalCapitalUsd,
      });

      return JSON.stringify({
        allowed: result.allowed,
        reason: result.reason,
        group,
        poolId,
        sizeUsd,
        totalCapitalUsd,
        currentExposure: Object.fromEntries(currentExposure),
      });
    },
    {
      name: 'check_concentration',
      description: 'Check if opening a new position would violate correlation-based concentration limits.',
      schema: sc(z.object({
        poolId: z.string(),
        protocol: z.string(),
        poolName: z.string(),
        sizeUsd: z.number(),
        totalCapitalUsd: z.number(),
      })),
    }
  );

  return {
    scoreOpportunityTool,
    scoreTierOpportunityTool,
    computePortfolioPnl,
    checkSignals,
    getMarketRegime,
    recallPastDecisions,
    checkConcentration,
  };
}

export type RiskTools = ReturnType<typeof createRiskTools>;
