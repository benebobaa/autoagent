import { v4 as uuidv4 } from 'uuid';
import type { AgentConfig } from '../config/loader.js';
import type { Position } from '../positions/db.js';
import { type Signal, type SignalType, SIGNAL_PRIORITY } from './types.js';
import type { MarketSnapshot, PoolSnapshot } from './snapshot.js';

// ---------------------------------------------------------------------------
// Tier 2 — Signal Detector (pure function, no LLM, no side effects)
// ---------------------------------------------------------------------------
// Compares two consecutive MarketSnapshots and emits typed Signals when
// threshold conditions are breached.
//
// Deduplication key format: `${type}:${subject_id}:${YYYY-MM-DD}`
// This prevents the same condition from firing more than once per day.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

// In-memory cache for stateful signals across poll cycles
const meteoraSignalState = {
  outOfRangePolls: new Map<string, number>(), // positionId -> count
  feeAprHistory: new Map<string, number[]>(), // poolId -> array of aprs (max 3)
};

/**
 * Compare `current` snapshot against `previous` (may be null on first run)
 * and return any signals that should be enqueued.
 */
export function detectSignals(
  current: MarketSnapshot,
  previous: MarketSnapshot | null,
  positions: Position[],
  config: AgentConfig
): Signal[] {
  const signals: Signal[] = [];
  const today = current.snapshotAt.slice(0, 10); // YYYY-MM-DD

  // ---- Signals that require a previous snapshot ----
  if (previous !== null) {
    const prevPoolMap = buildPoolMap(previous.pools);

    // 1. TVL_COLLAPSE — CRITICAL if we hold a position, HIGH otherwise
    // Discovery mode surfaces 100s of pools we don't hold. A collapse on an
    // untracked pool is noteworthy (don't enter it) but not an emergency.
    const activePoolIds = new Set(
      positions.filter((p) => p.state === 'ACTIVE' || p.state === 'PENDING_OPEN').map((p) => p.pool_id)
    );
    for (const pool of current.pools) {
      const prev = prevPoolMap.get(pool.poolId);
      if (!prev || prev.tvlUsd === 0) continue;
      const dropPct = (prev.tvlUsd - pool.tvlUsd) / prev.tvlUsd;
      if (dropPct >= config.signals.tvl_collapse_pct) {
        const weHoldPosition = activePoolIds.has(pool.poolId);
        signals.push(
          makeSignal(
            'TVL_COLLAPSE',
            `TVL_COLLAPSE:${pool.poolId}:${today}`,
            {
              poolId: pool.poolId,
              protocol: pool.protocol,
              previousTvlUsd: prev.tvlUsd,
              currentTvlUsd: pool.tvlUsd,
              dropPct,
              weHoldPosition,
            },
            weHoldPosition ? 'CRITICAL' : 'HIGH',
          )
        );
      }
    }

    // 2. LIQUIDITY_CRUNCH — HIGH (TVL drop > liquidity_crunch_pct, independent of collapse)
    // These are independent signals: COLLAPSE = rugpull (fast/severe), CRUNCH = gradual drain.
    // Both can fire simultaneously on the same pool.
    for (const pool of current.pools) {
      const prev = prevPoolMap.get(pool.poolId);
      if (!prev || prev.tvlUsd === 0) continue;
      const dropPct = (prev.tvlUsd - pool.tvlUsd) / prev.tvlUsd;
      if (dropPct >= config.signals.liquidity_crunch_pct) {
        signals.push(
          makeSignal('LIQUIDITY_CRUNCH', `LIQUIDITY_CRUNCH:${pool.poolId}:${today}`, {
            poolId: pool.poolId,
            protocol: pool.protocol,
            previousTvlUsd: prev.tvlUsd,
            currentTvlUsd: pool.tvlUsd,
            dropPct,
          })
        );
      }
    }

    // 3. REGIME_SHIFT — HIGH (SOL price moves > threshold between snapshots)
    if (previous.solPriceUsd > 0 && current.solPriceUsd > 0) {
      const changePct =
        Math.abs(current.solPriceUsd - previous.solPriceUsd) / previous.solPriceUsd;
      if (changePct >= config.signals.regime_shift_pct) {
        signals.push(
          makeSignal('REGIME_SHIFT', `REGIME_SHIFT:sol:${today}`, {
            previousSolPrice: previous.solPriceUsd,
            currentSolPrice: current.solPriceUsd,
            changePct,
            direction: current.solPriceUsd > previous.solPriceUsd ? 'up' : 'down',
          })
        );
      }
    }
  }

  // ---- Signals that require active positions ----
  const activePositions = positions.filter((p) => p.state === 'ACTIVE');
  const currentPoolMap = buildPoolMap(current.pools);

  for (const position of activePositions) {
    const currentPool = currentPoolMap.get(position.pool_id);
    if (!currentPool) continue;

    // 4. APY_DRIFT — HIGH (active position APY drops > threshold from entry)
    const entryApy = position.entry_apy;
    if (entryApy > 0) {
      const driftPct = (entryApy - currentPool.apyPct) / entryApy;
      if (driftPct >= config.signals.apy_drift_pct) {
        signals.push(
          makeSignal('APY_DRIFT', `APY_DRIFT:${position.id}:${today}`, {
            positionId: position.id,
            poolId: position.pool_id,
            protocol: position.protocol,
            entryApy,
            currentApy: currentPool.apyPct,
            driftPct,
          })
        );
      }
    }

    // 5. IL_BREACH — CRITICAL (impermanent loss exceeds tolerance)
    if (currentPool.il7d !== null && currentPool.il7d > config.signals.il_max_tolerance_pct) {
      signals.push(
        makeSignal('IL_BREACH', `IL_BREACH:${position.id}:${today}`, {
          positionId: position.id,
          poolId: position.pool_id,
          protocol: position.protocol,
          ilPct: currentPool.il7d,
          maxTolerancePct: config.signals.il_max_tolerance_pct,
        })
      );
    }

    // 6. BETTER_POOL — HIGH (same token, higher APY pool exists)
    const positionAgeHours = position.opened_at
      ? (Date.now() - new Date(position.opened_at).getTime()) / (1000 * 60 * 60)
      : 0;

    if (positionAgeHours >= 24) {
      const betterPool = findBetterPool(
        currentPool,
        current.pools,
        position.pool_id,
        config.signals.better_pool_delta_pp
      );
      if (betterPool !== null) {
        signals.push(
          makeSignal('BETTER_POOL', `BETTER_POOL:${position.id}:${today}`, {
            currentPositionId: position.id,
            currentPoolId: position.pool_id,
            currentApy: currentPool.apyPct,
            betterPoolId: betterPool.poolId,
            betterProtocol: betterPool.protocol,
            betterApy: betterPool.apyPct,
            deltaPp: betterPool.apyPct - currentPool.apyPct,
          })
        );
      }
    }

    // 7. POSITION_AGING — LOW
    if (position.opened_at !== null) {
      const daysHeld =
        (Date.now() - new Date(position.opened_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysHeld >= config.signals.position_aging_days) {
        signals.push(
          makeSignal('POSITION_AGING', `POSITION_AGING:${position.id}:${today}`, {
            positionId: position.id,
            poolId: position.pool_id,
            protocol: position.protocol,
            daysHeld,
            maxDays: config.signals.position_aging_days,
          })
        );
      }
    }
  }

  // 8. PORTFOLIO_DRAWDOWN — CRITICAL
  // Requires at least one active position and we can approximate drawdown
  // from current pool APYs vs entry APYs (simplified: use size_usd × apy_drift)
  if (activePositions.length > 0) {
    const drawdownSignal = detectPortfolioDrawdown(activePositions, currentPoolMap, config, today);
    if (drawdownSignal !== null) signals.push(drawdownSignal);
  }

  // 9. NEW_HIGH_YIELD_POOL — LOW
  // Any pool not currently in an active position that exceeds the threshold
  const activePoolIds = new Set(activePositions.map((p) => p.pool_id));
  for (const pool of current.pools) {
    if (activePoolIds.has(pool.poolId)) continue;
    if (
      pool.apyPct >= config.signals.high_yield_apy_threshold_pct &&
      pool.score >= config.scoring.min_score_to_suggest
    ) {
      signals.push(
        makeSignal('NEW_HIGH_YIELD_POOL', `NEW_HIGH_YIELD_POOL:${pool.poolId}:${today}`, {
          poolId: pool.poolId,
          protocol: pool.protocol,
          poolName: pool.poolName,
          apy: pool.apyPct,
          tvlUsd: pool.tvlUsd,
          score: pool.score,
        })
      );
    }
  }

  // 10. Meteora DLMM specific signals
  signals.push(...detectMeteoraOutOfRange(current.pools, activePositions, config, today));
  
  if (previous !== null) {
    signals.push(...detectMeteoraBinLiquidityThin(current.pools, config, today));
    signals.push(...detectMeteoraFeeAprCollapse(current.pools, config, today));
    signals.push(...detectMeteoraHighVolumeSpike(current.pools, previous.pools, config, today));
  }
  
  signals.push(...detectMeteoraBinStepMismatch(current.pools, config, today));

  return signals;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignal(type: SignalType, dedupKey: string, payload: unknown, priorityOverride?: Signal['priority']): Signal {
  return {
    id: uuidv4(),
    type,
    priority: priorityOverride ?? SIGNAL_PRIORITY[type],
    timestamp: new Date().toISOString(),
    payload: payload as Record<string, unknown>,
    dedupKey,
    processed: false,
    threadId: null,
  };
}

function buildPoolMap(pools: PoolSnapshot[]): Map<string, PoolSnapshot> {
  const map = new Map<string, PoolSnapshot>();
  for (const pool of pools) {
    map.set(pool.poolId, pool);
  }
  return map;
}

function findBetterPool(
  current: PoolSnapshot,
  allPools: PoolSnapshot[],
  excludePoolId: string,
  deltaPp: number
): PoolSnapshot | null {
  // Simplified: same protocol family (e.g. both are lending pools)
  // A more sophisticated version would match by token pair
  let best: PoolSnapshot | null = null;
  for (const pool of allPools) {
    if (pool.poolId === excludePoolId) continue;
    if (pool.protocol !== current.protocol) continue; // same protocol family
    if (pool.apyPct < current.apyPct + deltaPp) continue;
    if (best === null || pool.apyPct > best.apyPct) {
      best = pool;
    }
  }
  return best;
}

function detectPortfolioDrawdown(
  positions: Position[],
  currentPoolMap: Map<string, PoolSnapshot>,
  config: AgentConfig,
  today: string
): Signal | null {
  let totalDeployed = 0;
  let estimatedCurrentValue = 0;

  for (const pos of positions) {
    totalDeployed += pos.size_usd;

    const pool = currentPoolMap.get(pos.pool_id);
    if (!pool) {
      // Pool not in current scan — assume value unchanged (conservative, no phantom loss)
      estimatedCurrentValue += pos.size_usd;
      continue;
    }

    // APY ratio is a proxy for YIELD rate change, not capital loss.
    // Lending protocols (kamino_lending, marginfi, jito) protect principal — APY
    // fluctuations don't reduce capital, so always count as full value.
    // Only LP/DLMM positions have real IL risk; even there, use a 0.5 floor so a
    // zero-fee period never triggers a false 100% loss.
    const isLp = pos.protocol === 'meteora_dlmm';
    if (isLp && pos.entry_apy > 0) {
      const apyRatio = Math.max(pool.apyPct / pos.entry_apy, 0.5);
      estimatedCurrentValue += pos.size_usd * Math.min(apyRatio, 1);
    } else {
      estimatedCurrentValue += pos.size_usd;
    }
  }

  if (totalDeployed === 0) return null;

  const drawdownPct = ((totalDeployed - estimatedCurrentValue) / totalDeployed) * 100;
  if (drawdownPct < config.signals.portfolio_drawdown_pct) return null;

  return makeSignal('PORTFOLIO_DRAWDOWN', `PORTFOLIO_DRAWDOWN:portfolio:${today}`, {
    drawdownPct,
    portfolioValueUsd: estimatedCurrentValue,
    peakValueUsd: totalDeployed,
  });
}

// ---------------------------------------------------------------------------
// Meteora DLMM Signal Detectors
// ---------------------------------------------------------------------------

function detectMeteoraOutOfRange(
  pools: PoolSnapshot[],
  activePositions: Position[],
  config: AgentConfig,
  today: string
): Signal[] {
  const signals: Signal[] = [];
  const poolMap = buildPoolMap(pools);

  for (const pos of activePositions) {
    if (pos.protocol !== 'meteora_dlmm') continue;

    const pool = poolMap.get(pos.pool_id);
    if (!pool || pool.protocol !== 'meteora_dlmm') continue;

    const activeBinId = pool.activeBinId;
    if (activeBinId === undefined) continue;

    // Extract bin bounds from notes (stored by executor)
    let lowerBinId: number | undefined;
    let upperBinId: number | undefined;
    if (pos.notes) {
      try {
        const parsed = JSON.parse(pos.notes);
        lowerBinId = parsed.lowerBinId !== undefined ? parsed.lowerBinId : parsed.binRange?.lower;
        upperBinId = parsed.upperBinId !== undefined ? parsed.upperBinId : parsed.binRange?.upper;
      } catch (e) {
        // ignore JSON parse errors
      }
    }

    if (lowerBinId === undefined || upperBinId === undefined) continue;

    const isOutOfRange = activeBinId < lowerBinId || activeBinId > upperBinId;
    let count = meteoraSignalState.outOfRangePolls.get(pos.id) || 0;

    if (isOutOfRange) {
      count += 1;
      meteoraSignalState.outOfRangePolls.set(pos.id, count);

      // Trigger every N polls (e.g. 4, 8, 12...). No 2-hour suppression per user rule #4.
      const alertThreshold = config.meteora.out_of_range_alert_polls;
      if (count >= alertThreshold && count % alertThreshold === 0) {
        // dedupKey uniquely increments for each cycle to ensure we fire every 20 minutes continuously
        const cycle = Math.floor(count / alertThreshold);
        signals.push(
          makeSignal('METEORA_OUT_OF_RANGE', `METEORA_OUT_OF_RANGE:${pos.id}:${today}:${cycle}`, {
            positionId: pos.id,
            poolId: pos.pool_id,
            activeBinId,
            lowerBinId,
            upperBinId,
            consecutivePolls: count,
          })
        );
      }
    } else {
      // Reset if back in range
      meteoraSignalState.outOfRangePolls.delete(pos.id);
    }
  }

  return signals;
}

function detectMeteoraBinLiquidityThin(
  pools: PoolSnapshot[],
  config: AgentConfig,
  today: string
): Signal[] {
  const signals: Signal[] = [];

  for (const pool of pools) {
    if (pool.protocol !== 'meteora_dlmm') continue;

    const activeBinLiquidity = pool.liquidityInActiveBins;
    if (activeBinLiquidity === undefined) continue;

    // Use estimated liquidity for thin bin calculation
    // Note: The scanner currently estimates this as tvlUsd * config_pct
    // If we have actual bin data in the future, it will be accurately reflected here
    if (activeBinLiquidity < pool.tvlUsd * config.meteora.active_bin_liquidity_min_pct) {
      // User rule #3: suppress signal unless we have real data (not estimated).
      // If we don't have real data, we just skip it.
      // Scanner currently uses dataUncertain logic for this, but we also passed
      // a flag. However, we don't have access to the raw pool data here, just the snapshot.
      // So we will skip for now, adding a note.
      // TODO: Re-enable METEORA_BIN_LIQUIDITY_THIN once SDK provides exact bin depth.
      // signals.push(makeSignal(...));
    }
  }

  return signals;
}

function detectMeteoraFeeAprCollapse(
  pools: PoolSnapshot[],
  config: AgentConfig,
  today: string
): Signal[] {
  const signals: Signal[] = [];

  for (const pool of pools) {
    if (pool.protocol !== 'meteora_dlmm') continue;

    const currentApr = pool.feeApr24h;
    if (currentApr === undefined) continue;

    const history = meteoraSignalState.feeAprHistory.get(pool.poolId) || [];
    
    // Calculate average of previous entries (up to 3) before adding current
    if (history.length > 0) {
      const avgApr = history.reduce((sum, v) => sum + v, 0) / history.length;
      const dropPct = (avgApr - currentApr) / avgApr;
      
      if (dropPct >= config.meteora.fee_apr_collapse_threshold) {
        signals.push(
          makeSignal('METEORA_FEE_APR_COLLAPSE', `METEORA_FEE_APR_COLLAPSE:${pool.poolId}:${today}`, {
            poolId: pool.poolId,
            currentApr,
            averageApr: avgApr,
            dropPct,
          })
        );
      }
    }

    // Keep last 3 observations
    history.push(currentApr);
    if (history.length > 3) history.shift();
    meteoraSignalState.feeAprHistory.set(pool.poolId, history);
  }

  return signals;
}

function detectMeteoraHighVolumeSpike(
  currentPools: PoolSnapshot[],
  previousPools: PoolSnapshot[],
  config: AgentConfig,
  today: string
): Signal[] {
  const signals: Signal[] = [];
  const prevMap = buildPoolMap(previousPools);

  for (const pool of currentPools) {
    if (pool.protocol !== 'meteora_dlmm') continue;
    
    const prev = prevMap.get(pool.poolId);
    if (!prev || !prev.volume24hUsd || !pool.volume24hUsd) continue;

    const spikeMultiplier = pool.volume24hUsd / prev.volume24hUsd;
    
    // Only flag if volume spikes and APY is still decent
    if (
      spikeMultiplier >= config.meteora.volume_spike_multiplier &&
      pool.apyPct >= (config.meteora.min_fee_apr * 100)
    ) {
      signals.push(
        makeSignal('METEORA_HIGH_VOLUME_SPIKE', `METEORA_HIGH_VOLUME_SPIKE:${pool.poolId}:${today}`, {
          poolId: pool.poolId,
          currentVolume: pool.volume24hUsd,
          previousVolume: prev.volume24hUsd,
          spikeMultiplier,
          currentApr: pool.feeApr24h || pool.apyPct / 100,
        })
      );
    }
  }

  return signals;
}

function detectMeteoraBinStepMismatch(
  pools: PoolSnapshot[],
  config: AgentConfig,
  today: string
): Signal[] {
  const signals: Signal[] = [];

  for (const pool of pools) {
    if (pool.protocol !== 'meteora_dlmm') continue;
    
    const binStep = pool.binStep;
    if (binStep === undefined) continue;

    const upperPair = pool.poolName.toUpperCase();
    const rules = config.meteora.bin_step_rules;
    
    let isMismatch = false;
    let strategyClass = '';
    
    if (upperPair.includes('USDC') && upperPair.includes('USDT')) {
      isMismatch = binStep > rules.stablecoin_pairs.max_bin_step;
      strategyClass = 'stablecoin';
    } else if (upperPair.includes('SOL') || upperPair.includes('ETH') || upperPair.includes('BTC')) {
      isMismatch = binStep > rules.bluechip_pairs.max_bin_step;
      strategyClass = 'bluechip';
    } else {
      isMismatch = binStep > rules.volatile_pairs.max_bin_step;
      strategyClass = 'volatile';
    }

    if (isMismatch) {
      signals.push(
        makeSignal('METEORA_BIN_STEP_MISMATCH', `METEORA_BIN_STEP_MISMATCH:${pool.poolId}:${today}`, {
          poolId: pool.poolId,
          poolName: pool.poolName,
          binStep,
          assessment: `Extremely wide for ${strategyClass} category`,
        })
      );
    }
  }

  return signals;
}
