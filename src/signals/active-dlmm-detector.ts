import { v4 as uuidv4 } from 'uuid';
import { BirdeyeClient, type PoolVolumeSnapshot } from '../data/birdeye-client.js';
import { DexscreenerClient, type DexScreenerPool } from '../data/dexscreener-client.js';
import { getActivePortfolio } from '../config/portfolio-config.js';
import { DEFAULT_TIER_CONFIGS, type RiskTierNumber } from '../config/risk-tiers.js';
import { SIGNAL_PRIORITY, type Signal } from './types.js';
import { logger } from '../utils/logger.js';

export class ActiveDlmmDetector {
  private readonly birdeye: BirdeyeClient;
  private readonly dexscreener: DexscreenerClient;
  private readonly poolCooldowns = new Map<string, number>();
  private readonly cooldownMs = 30 * 60 * 1000;

  constructor(
    birdeye = new BirdeyeClient(),
    dexscreener = new DexscreenerClient(),
  ) {
    this.birdeye = birdeye;
    this.dexscreener = dexscreener;
  }

  async scanForVolumeSpikes(knownPools: Array<{ poolId: string; tokenMint: string }>): Promise<Signal[]> {
    if (knownPools.length === 0) {
      return [];
    }

    const snapshots = await this.birdeye.batchPoolSnapshots(knownPools);
    const signals: Signal[] = [];

    for (const snapshot of snapshots) {
      if (this.inCooldown(snapshot.poolAddress)) {
        continue;
      }

      const matchedTier = this.selectSpikeTier(snapshot);
      if (matchedTier === null) {
        continue;
      }

      const confidence = this.computeSpikeConfidence(snapshot, DEFAULT_TIER_CONFIGS[matchedTier].volume_spike_multiplier);
      const timestamp = new Date().toISOString();
      const bucket = timestamp.slice(0, 16);
      signals.push({
        id: uuidv4(),
        type: 'VOLUME_SPIKE',
        priority: SIGNAL_PRIORITY['VOLUME_SPIKE'],
        timestamp,
        payload: {
          poolAddress: snapshot.poolAddress,
          tokenSymbol: snapshot.tokenSymbol,
          priceChange24hPct: snapshot.priceChange24hPct,
          priceChangeBaselinePct: snapshot.priceChangeBaselinePct,
          spikeRatio: snapshot.volumeSpikeRatio,
          liquidityUsd: snapshot.liquidityUsd,
          recommendedTier: matchedTier,
          confidenceScore: confidence,
          source: 'birdeye',
        },
        dedupKey: `VOLUME_SPIKE:${snapshot.poolAddress}:${bucket}`,
        processed: false,
        threadId: null,
      });
      this.setCooldown(snapshot.poolAddress);
    }

    return signals;
  }

  async discoverMemePools(): Promise<Signal[]> {
    const portfolio = getActivePortfolio();
    const activeMemeTiers = portfolio.active_tiers.filter((tier) =>
      portfolio.getTierConfig(tier).meteora_pool_types.includes('memecoin'),
    );
    if (activeMemeTiers.length === 0) {
      return [];
    }

    const targetTier = Math.max(...activeMemeTiers) as RiskTierNumber;
    const tierConfig = portfolio.getTierConfig(targetTier);
    const pools = await this.dexscreener.getTrendingSolanaPools({
      minVolume5m: tierConfig.min_volume_24h_usd / 288,
      minLiquidity: tierConfig.min_pool_tvl_usd,
      maxLiquidity: tierConfig.max_pool_tvl_usd,
      dexFilter: 'meteora',
      requireSolPair: true,
      maxAgeHours: 48,
      limit: 50,
    });

    const timestamp = new Date().toISOString();
    const bucket = timestamp.slice(0, 16);
    const signals: Signal[] = [];

    for (const pool of pools) {
      if (this.inCooldown(pool.poolAddress)) {
        continue;
      }

      const confidence = this.computePoolConfidence(pool);
      if (confidence < 0.3) {
        continue;
      }

      signals.push({
        id: uuidv4(),
        type: 'MEME_POOL_DISCOVERED',
        priority: SIGNAL_PRIORITY['MEME_POOL_DISCOVERED'],
        timestamp,
        payload: {
          poolAddress: pool.poolAddress,
          tokenSymbol: pool.baseTokenSymbol,
          tokenMint: pool.baseTokenMint,
          dexUrl: pool.url,
          volume5mUsd: pool.volume5mUsd,
          volume1hUsd: pool.volume1hUsd,
          volume24hUsd: pool.volume24hUsd,
          liquidityUsd: pool.liquidityUsd,
          priceChange5mPct: pool.priceChange5mPct,
          priceChange1hPct: pool.priceChange1hPct,
          poolAgeHours: pool.poolAgeHours,
          fdvUsd: pool.fdvUsd,
          recommendedTier: targetTier,
          confidenceScore: confidence,
          source: 'dexscreener',
        },
        dedupKey: `MEME_POOL_DISCOVERED:${pool.poolAddress}:${bucket}`,
        processed: false,
        threadId: null,
      });
      this.setCooldown(pool.poolAddress);
    }

    return signals;
  }

  private selectSpikeTier(snapshot: PoolVolumeSnapshot): RiskTierNumber | null {
    const tiers: RiskTierNumber[] = [9, 8, 7, 6];
    for (const tier of tiers) {
      const config = DEFAULT_TIER_CONFIGS[tier];
      if (!config.require_volume_spike) {
        continue;
      }
      if (snapshot.volumeSpikeRatio < config.volume_spike_multiplier) {
        continue;
      }
      if (snapshot.liquidityUsd < config.min_pool_tvl_usd || snapshot.liquidityUsd > config.max_pool_tvl_usd) {
        continue;
      }
      if (config.require_price_momentum && snapshot.priceChange24hPct <= 0) {
        continue;
      }
      return tier;
    }
    return null;
  }

  private computeSpikeConfidence(snapshot: PoolVolumeSnapshot, threshold: number): number {
    let score = 0;
    score += Math.min(Math.max((snapshot.volumeSpikeRatio - threshold) / Math.max(threshold * 2, 1), 0), 0.4);
    if (snapshot.priceChange24hPct > 5) {
      score += 0.3;
    } else if (snapshot.priceChange24hPct > 0) {
      score += 0.15;
    }
    if (snapshot.liquidityUsd > 50_000) {
      score += 0.1;
    }
    return Math.min(score, 1);
  }

  private computePoolConfidence(pool: DexScreenerPool): number {
    let score = 0;
    if (pool.volume5mUsd > 10_000) {
      score += 0.3;
    } else if (pool.volume5mUsd > 5_000) {
      score += 0.15;
    }
    if (pool.priceChange5mPct > 5) {
      score += 0.25;
    } else if (pool.priceChange5mPct > 0) {
      score += 0.1;
    }
    if (pool.poolAgeHours < 6) {
      score += 0.25;
    } else if (pool.poolAgeHours < 24) {
      score += 0.1;
    }
    if (pool.fdvUsd > 50_000 && pool.fdvUsd < 5_000_000) {
      score += 0.2;
    }
    return Math.min(score, 1);
  }

  private inCooldown(poolAddress: string): boolean {
    return Date.now() - (this.poolCooldowns.get(poolAddress) ?? 0) < this.cooldownMs;
  }

  private setCooldown(poolAddress: string): void {
    this.poolCooldowns.set(poolAddress, Date.now());
    logger.debug({ poolAddress }, 'Active DLMM detector cooldown set');
  }
}
