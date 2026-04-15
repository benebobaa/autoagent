import type { Connection } from '@solana/web3.js';
import { createSolanaRpc } from '@solana/rpc';
import { v4 as uuidv4 } from 'uuid';
import type { AgentConfig } from '../config/loader.js';
import type { Database } from '../positions/db.js';
import { runScan } from '../scanner/index.js';
import { scoreAll, type ScoredOpportunity, type PortfolioContext } from '../scoring/engine.js';
import { getExposureByGroup } from '../scoring/correlation.js';
import { logger } from '../utils/logger.js';
import {
  type MarketSnapshot,
  type PoolSnapshot,
  buildSnapshotHash,
} from './snapshot.js';

type KitRpc = ReturnType<typeof createSolanaRpc>;

// ---------------------------------------------------------------------------
// Tier 1 — Data Poller
// ---------------------------------------------------------------------------
// Runs every `config.polling.data_poll_interval_sec` seconds.
// Calls the existing scanner + scorer, packages results into a MarketSnapshot,
// stores it in the DB, and returns it for the signal detector to consume.
//
// Deliberately has NO signal emission logic — that belongs in the detector.
// ---------------------------------------------------------------------------

export class DataPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private _lastTickTime: number = 0;
  private _tickCount: number = 0;
  private _lastScoredOpportunities: ScoredOpportunity[] = [];

  constructor(
    private readonly config: AgentConfig,
    private readonly db: Database,
    private readonly connection: Connection,
    private readonly kitRpc: KitRpc
  ) {}

  get lastTickTime(): number {
    return this._lastTickTime;
  }

  get tickCount(): number {
    return this._tickCount;
  }

  get lastScoredOpportunities(): ScoredOpportunity[] {
    return this._lastScoredOpportunities;
  }

  /** Run a single poll cycle and return the snapshot. */
  async poll(): Promise<MarketSnapshot> {
    const cooledBaseMints = await this.db.getCooledBaseMints().catch(() => new Set<string>());
    const rawOpps = await runScan(this.config, this.connection, this.kitRpc, cooledBaseMints);

    // Build portfolio context for diversification-aware scoring
    const activePositions = await this.db.getPositionsByState('ACTIVE');
    const portfolioCtx: PortfolioContext | undefined = activePositions.length > 0 && this.config.paperTrading
      ? {
          exposureByGroup: getExposureByGroup(activePositions) as Map<string, number>,
          totalCapitalUsd: this.config.paperStartingBalanceUsd,
        }
      : undefined;

    const scored = scoreAll(rawOpps, this.config, undefined, portfolioCtx);
    this._lastScoredOpportunities = scored;

    const snapshotAt = new Date().toISOString();
    const pools: PoolSnapshot[] = scored.map((opp) => ({
      poolId: opp.poolId,
      protocol: opp.protocol,
      poolName: opp.poolName,
      apyPct: opp.apyUsed,
      tvlUsd: opp.tvlUsd,
      il7d: null, // DefiLlama il7d can be added later when scanner exposes it
      score: opp.score,
      snapshotAt,
    }));

    const solPriceUsd = await fetchSolPrice();

    const snapshot: MarketSnapshot = {
      id: uuidv4(),
      snapshotAt,
      pools,
      solPriceUsd,
      hash: buildSnapshotHash(pools, solPriceUsd),
    };

    await this.db.insertMarketSnapshot(snapshot.id, snapshot);
    logger.info(
      { snapshotId: snapshot.id, pools: pools.length, solPrice: solPriceUsd },
      'Market snapshot stored'
    );

    return snapshot;
  }

  /** Start the polling loop. Fires immediately, then on interval. */
  start(onSnapshot?: (snapshot: MarketSnapshot) => void): void {
    if (this.running) return;
    this.running = true;

    const tick = async () => {
      try {
        const snapshot = await this.poll();
        this._lastTickTime = Date.now();
        this._tickCount++;
        onSnapshot?.(snapshot);
      } catch (err) {
        logger.error({ err }, 'Poller tick failed — will retry on next interval');
      }
    };

    // Fire immediately, then on interval
    void tick();
    const intervalMs = this.config.polling.data_poll_interval_sec * 1000;
    this.timer = setInterval(() => void tick(), intervalMs);
    logger.info({ intervalSec: this.config.polling.data_poll_interval_sec }, 'Data poller started');
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    logger.info('Data poller stopped');
  }
}

// ---------------------------------------------------------------------------
// SOL price helper
// ---------------------------------------------------------------------------
// Fetches the current SOL/USD price from CoinGecko (free, no API key needed).
// Falls back to 0 on error so a price feed failure never crashes the poller.

async function fetchSolPrice(): Promise<number> {
  try {
    const { default: axios } = await import('axios');
    const res = await axios.get<{ solana: { usd: number } }>(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { timeout: 5000 }
    );
    return res.data.solana.usd;
  } catch {
    logger.warn('Failed to fetch SOL price — using 0 as fallback');
    return 0;
  }
}
