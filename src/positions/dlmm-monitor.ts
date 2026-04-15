/**
 * DLMM Position Monitor — Phase 4
 *
 * Applies hard close rules to all active DLMM positions:
 *  1. PnL <= stop_loss_pct               → CLOSE (stop loss)
 *  2. PnL >= take_profit_pct             → CLOSE (take profit) when trailing is disabled
 *  2b. PnL retraces from armed peak      → CLOSE (trailing take profit) when trailing is enabled
 *  3. active_bin > upper_bin + threshold → CLOSE (pumped past range)
 *  4. OOR >= out_of_range_wait_minutes   → CLOSE (stale out-of-range)
 *  5. fee_per_tvl_24h < min AND age>=60  → CLOSE (fee yield too low)
 *  6. unclaimed fees >= min_claim        → CLAIM_FEE
 *
 * Rules are evaluated in priority order — first match wins.
 */

import axios from 'axios';
import type { AgentConfig } from '../config/loader.js';
import type { Database, DlmmPosition } from './db.js';
import { logger } from '../utils/logger.js';
import type { SignalType } from '../signals/types.js';
import { ensureDlmmPositionRecord } from './dlmm-sync.js';
import { DEFAULT_TIER_CONFIGS } from '../config/risk-tiers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MonitorAction = 'close' | 'claim_fee' | 'hold';

export type MonitorCloseReason =
  | 'stop_loss'
  | 'take_profit'
  | 'trailing_take_profit'
  | 'time_stop'
  | 'out_of_range'
  | 'rug_detected'
  | 'oor_timeout'
  | 'pumped_past_range'
  | 'fee_yield_low';

export interface PositionPnlData {
  pnlUsd: number;
  pnlPct: number;
  currentValueUsd: number;
  unclaimedFeesUsd: number;
  allTimeFeesUsd: number;
  feePerTvl24h: number;
  inRange: boolean;
  activeBinId: number | null;
  lowerBinId: number | null;
  upperBinId: number | null;
  currentPrice: number | null;
  ageMinutes: number | null;
}

interface SyntheticActiveDlmmState {
  minBinPrice?: number;
  maxBinPrice?: number;
  currentPrice?: number;
  lastKnownPrice?: number;
}

function parsePositionNotes(notes: string | null): Record<string, unknown> {
  if (!notes) {
    return {};
  }
  try {
    const parsed = JSON.parse(notes) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseSyntheticActiveDlmm(notes: string | null): SyntheticActiveDlmmState | null {
  const parsed = parsePositionNotes(notes);
  const activeDlmm = parsed['activeDlmm'];
  if (!activeDlmm || typeof activeDlmm !== 'object' || Array.isArray(activeDlmm)) {
    return null;
  }
  return activeDlmm as SyntheticActiveDlmmState;
}

export interface MonitorDecision {
  positionId: string;
  positionPubkey: string;
  poolAddress: string;
  action: MonitorAction;
  closeReason: MonitorCloseReason | undefined;
  signalType: SignalType;
  pnl: PositionPnlData;
  peakPnlPct?: number;
  drawdownPct?: number;
  trailArmProfitPct?: number;
  notes: string;
}

interface TrailingEvaluation {
  peakPnlPct: number | null;
  trailingArmedAt: string | null;
  drawdownPct: number | null;
  decision: { action: MonitorAction; closeReason?: MonitorCloseReason; signalType: SignalType; notes: string } | null;
}

export function evaluateTrailingTakeProfit(
  dlmm: DlmmPosition,
  pnl: PositionPnlData,
  mgmt: NonNullable<AgentConfig['meteora']['management']>,
  nowIso: string,
): TrailingEvaluation {
  if (!mgmt.trailing_take_profit_enabled) {
    return {
      peakPnlPct: dlmm.peak_pnl_pct,
      trailingArmedAt: dlmm.trailing_armed_at,
      drawdownPct: null,
      decision: null,
    };
  }

  const armProfitPct = mgmt.trail_arm_profit_pct;
  let trailingArmedAt = dlmm.trailing_armed_at;
  let peakPnlPct = dlmm.peak_pnl_pct;

  if (pnl.pnlPct >= armProfitPct) {
    trailingArmedAt ??= nowIso;
    peakPnlPct = peakPnlPct === null ? pnl.pnlPct : Math.max(peakPnlPct, pnl.pnlPct);
  }

  if (trailingArmedAt === null || peakPnlPct === null) {
    return {
      peakPnlPct,
      trailingArmedAt,
      drawdownPct: null,
      decision: null,
    };
  }

  const drawdownPct = Math.max(0, peakPnlPct - pnl.pnlPct);
  if (drawdownPct >= mgmt.trail_drawdown_pct) {
    return {
      peakPnlPct,
      trailingArmedAt,
      drawdownPct,
      decision: {
        action: 'close',
        closeReason: 'trailing_take_profit',
        signalType: 'DLMM_TRAILING_TP',
        notes: `Trailing TP: peak ${peakPnlPct.toFixed(1)}%, current ${pnl.pnlPct.toFixed(1)}%, drawdown ${drawdownPct.toFixed(1)}% >= ${mgmt.trail_drawdown_pct}%`,
      },
    };
  }

  return {
    peakPnlPct,
    trailingArmedAt,
    drawdownPct,
    decision: null,
  };
}

// ---------------------------------------------------------------------------
// Meteora PnL API
// ---------------------------------------------------------------------------

/**
 * Raw position entry from Meteora's PnL API.
 * Structure: GET https://dlmm.datapi.meteora.ag/positions/{pool}/pnl?user={wallet}&status=open
 */
interface MeteoraRawPnlPosition {
  position: string;
  pnlUsd?: number;
  pnlPctChange?: number;
  isOutOfRange?: boolean;
  lowerBinId?: number;
  upperBinId?: number;
  poolActiveBinId?: number;
  createdAt?: number;
  feePerTvl24h?: string | number;
  unrealizedPnl?: {
    balances?: string | number;
    unclaimedFeeTokenX?: { usd?: string | number };
    unclaimedFeeTokenY?: { usd?: string | number };
  };
  allTimeFees?: {
    total?: { usd?: string | number };
  };
}

async function fetchPoolPnl(
  poolAddress: string,
  walletAddress: string
): Promise<Map<string, MeteoraRawPnlPosition>> {
  const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await axios.get<{ positions?: MeteoraRawPnlPosition[]; data?: MeteoraRawPnlPosition[] }>(
      url,
      { timeout: 10_000 }
    );
    const raw = res.data?.positions ?? res.data?.data ?? [];
    const byAddress = new Map<string, MeteoraRawPnlPosition>();
    for (const p of raw) {
      if (p.position) byAddress.set(p.position, p);
    }
    return byAddress;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ poolAddress: poolAddress.slice(0, 8), err: msg }, 'PnL API fetch error');
    return new Map();
  }
}

function parsePnlEntry(p: MeteoraRawPnlPosition): PositionPnlData {
  const unclaimedX = parseFloat(String(p.unrealizedPnl?.unclaimedFeeTokenX?.usd ?? 0));
  const unclaimedY = parseFloat(String(p.unrealizedPnl?.unclaimedFeeTokenY?.usd ?? 0));
  const unclaimedFeesUsd = (isNaN(unclaimedX) ? 0 : unclaimedX) + (isNaN(unclaimedY) ? 0 : unclaimedY);
  const currentValueUsd = parseFloat(String(p.unrealizedPnl?.balances ?? 0));
  const allTimeFeesUsd = parseFloat(String(p.allTimeFees?.total?.usd ?? 0));
  const feePerTvl24h = parseFloat(String(p.feePerTvl24h ?? 0));
  const ageMinutes = p.createdAt
    ? Math.floor((Date.now() - p.createdAt * 1000) / 60_000)
    : null;

  return {
    pnlUsd: Math.round((p.pnlUsd ?? 0) * 100) / 100,
    pnlPct: Math.round((p.pnlPctChange ?? 0) * 100) / 100,
    currentValueUsd: Math.round((isNaN(currentValueUsd) ? 0 : currentValueUsd) * 100) / 100,
    unclaimedFeesUsd: Math.round(unclaimedFeesUsd * 100) / 100,
    allTimeFeesUsd: Math.round((isNaN(allTimeFeesUsd) ? 0 : allTimeFeesUsd) * 100) / 100,
    feePerTvl24h: Math.round((isNaN(feePerTvl24h) ? 0 : feePerTvl24h) * 100) / 100,
    inRange: !(p.isOutOfRange ?? false),
    activeBinId: p.poolActiveBinId ?? null,
    lowerBinId: p.lowerBinId ?? null,
    upperBinId: p.upperBinId ?? null,
    currentPrice: null,
    ageMinutes,
  };
}

function buildSyntheticPaperPnl(position: Awaited<ReturnType<Database['getPosition']>>, syntheticState: SyntheticActiveDlmmState, latestSnapshot: Awaited<ReturnType<Database['getLatestPnlSnapshot']>>): PositionPnlData {
  const currentValueUsd = latestSnapshot?.current_value_usd ?? position?.size_usd ?? 0;
  const costBasisUsd = position?.size_usd ?? 1;
  const pnlUsd = currentValueUsd - costBasisUsd;
  const pnlPct = costBasisUsd > 0 ? (pnlUsd / costBasisUsd) * 100 : 0;
  const currentPrice = syntheticState.lastKnownPrice ?? syntheticState.currentPrice ?? position?.entry_price_sol ?? null;
  const minBinPrice = syntheticState.minBinPrice ?? null;
  const maxBinPrice = syntheticState.maxBinPrice ?? null;
  const inRange = currentPrice === null || minBinPrice === null || maxBinPrice === null
    ? true
    : currentPrice >= minBinPrice && currentPrice <= maxBinPrice;

  return {
    pnlUsd,
    pnlPct,
    currentValueUsd,
    unclaimedFeesUsd: 0,
    allTimeFeesUsd: 0,
    feePerTvl24h: 0,
    inRange,
    activeBinId: 0,
    lowerBinId: null,
    upperBinId: null,
    currentPrice,
    ageMinutes: position?.opened_at ? Math.floor((Date.now() - new Date(position.opened_at).getTime()) / 60_000) : null,
  };
}

// ---------------------------------------------------------------------------
// Hard close rule evaluation
// ---------------------------------------------------------------------------

export function evaluateHardCloseRules(
  pnl: PositionPnlData,
  mgmt: NonNullable<AgentConfig['meteora']['management']>,
  minutesOor: number,
  maxHoldMinutes?: number,
): { action: MonitorAction; closeReason?: MonitorCloseReason; signalType: SignalType; notes: string } | null {
  const {
    stop_loss_pct,
    take_profit_pct,
    trailing_take_profit_enabled,
    out_of_range_bins_to_close,
    out_of_range_wait_minutes,
    min_fee_per_tvl_24h,
    min_claim_amount_usd,
  } = mgmt;

  // Rule 1: Stop loss
  if (pnl.pnlPct <= stop_loss_pct) {
    return {
      action: 'close',
      closeReason: 'stop_loss',
      signalType: 'DLMM_STOP_LOSS',
      notes: `PnL ${pnl.pnlPct.toFixed(1)}% <= stop loss ${stop_loss_pct}%`,
    };
  }

  // Rule 2: Take profit
  if (!trailing_take_profit_enabled && pnl.pnlPct >= take_profit_pct) {
    return {
      action: 'close',
      closeReason: 'take_profit',
      signalType: 'DLMM_TAKE_PROFIT',
      notes: `PnL ${pnl.pnlPct.toFixed(1)}% >= take profit ${take_profit_pct}%`,
    };
  }

  // Rule 3: Pumped past range (active_bin > upper_bin + threshold)
  if (
    pnl.activeBinId !== null &&
    pnl.upperBinId !== null &&
    pnl.activeBinId > pnl.upperBinId + out_of_range_bins_to_close
  ) {
    return {
      action: 'close',
      closeReason: 'pumped_past_range',
      signalType: 'DLMM_OOR_CLOSE',
      notes: `Active bin ${pnl.activeBinId} > upper ${pnl.upperBinId} + ${out_of_range_bins_to_close} (pumped)`,
    };
  }

  // Rule 4: OOR timeout (out of range AND waiting too long)
  if (!pnl.inRange && minutesOor >= out_of_range_wait_minutes) {
    return {
      action: 'close',
      closeReason: 'oor_timeout',
      signalType: 'DLMM_OOR_CLOSE',
      notes: `OOR for ${minutesOor} min >= threshold ${out_of_range_wait_minutes} min`,
    };
  }

  if (typeof maxHoldMinutes === 'number' && pnl.ageMinutes !== null && pnl.ageMinutes >= maxHoldMinutes) {
    return {
      action: 'close',
      closeReason: 'time_stop',
      signalType: 'DLMM_OOR_CLOSE',
      notes: `Position age ${pnl.ageMinutes} min >= tier max hold ${maxHoldMinutes} min`,
    };
  }

  // Rule 5: Fee yield too low (and position is old enough to have proven itself)
  if (
    pnl.feePerTvl24h < min_fee_per_tvl_24h &&
    pnl.ageMinutes !== null &&
    pnl.ageMinutes >= 60
  ) {
    return {
      action: 'close',
      closeReason: 'fee_yield_low',
      signalType: 'DLMM_FEE_YIELD_LOW',
      notes: `fee_per_tvl_24h ${pnl.feePerTvl24h.toFixed(2)}% < min ${min_fee_per_tvl_24h}%, age ${pnl.ageMinutes} min`,
    };
  }

  // Non-close: fee claim check
  if (pnl.unclaimedFeesUsd >= min_claim_amount_usd) {
    return {
      action: 'claim_fee',
      signalType: 'DLMM_FEE_CLAIM_READY',
      notes: `Unclaimed fees $${pnl.unclaimedFeesUsd.toFixed(2)} >= min $${min_claim_amount_usd}`,
    };
  }

  return null; // hold
}

// ---------------------------------------------------------------------------
// Public monitor function
// ---------------------------------------------------------------------------

/**
 * Monitors all active DLMM positions and returns decisions for each.
 * Caller is responsible for executing the decisions (close, claim, hold).
 */
export async function monitorDlmmPositions(
  db: Database,
  config: AgentConfig,
  walletAddress: string
): Promise<MonitorDecision[]> {
  const mgmt = config.meteora.management;

  const activeMeteoraPositions = (await db.getPositionsByState('ACTIVE')).filter(
    (position) => position.protocol === 'meteora_dlmm',
  );

  await Promise.all(
    activeMeteoraPositions.map((position) =>
      ensureDlmmPositionRecord(db, position, walletAddress, config.meteora.preferred_strategy),
    ),
  );

  // Get all active DLMM positions
  const dlmmPositions = await db.getActiveDlmmPositions();
  if (dlmmPositions.length === 0) {
    logger.debug('DLMM monitor: no active positions');
    return [];
  }

  logger.info({ count: dlmmPositions.length }, 'DLMM monitor: checking positions');

  // Fetch PnL for all unique pools in parallel
  const uniquePools = [...new Set(dlmmPositions.map((p) => p.pool_pubkey))];
  const pnlMaps = await Promise.all(
    uniquePools.map((pool) => fetchPoolPnl(pool, walletAddress))
  );
  const pnlByPool = new Map<string, Map<string, MeteoraRawPnlPosition>>();
  uniquePools.forEach((pool, i) => {
    const m = pnlMaps[i];
    if (m) pnlByPool.set(pool, m);
  });

  const decisions: MonitorDecision[] = [];
  const now = new Date().toISOString();

  for (const dlmm of dlmmPositions) {
    const trackedPosition = await db.getPosition(dlmm.position_id);
    const tierConfig = trackedPosition?.tier ? DEFAULT_TIER_CONFIGS[trackedPosition.tier as keyof typeof DEFAULT_TIER_CONFIGS] : null;
    const tierAwareMgmt = tierConfig
      ? {
          ...mgmt,
          stop_loss_pct: tierConfig.stop_loss_pct * 100,
          take_profit_pct: tierConfig.take_profit_pct * 100,
          min_fee_per_tvl_24h: tierConfig.min_fee_apr_pct,
          management_interval_minutes: tierConfig.check_interval_minutes,
        }
      : mgmt;
    const poolMap = pnlByPool.get(dlmm.pool_pubkey);
    const rawPnl = poolMap?.get(dlmm.position_pubkey);

    let pnl: PositionPnlData;
    if (rawPnl) {
      pnl = parsePnlEntry(rawPnl);
    } else if (config.paperTrading && trackedPosition?.deployment_mode === 'active') {
      const syntheticState = parseSyntheticActiveDlmm(trackedPosition.notes);
      const latestSnapshot = await db.getLatestPnlSnapshot(dlmm.position_id, 'mark_to_market');
      if (!syntheticState || !trackedPosition) {
        logger.debug(
          { positionPubkey: dlmm.position_pubkey.slice(0, 8), pool: dlmm.pool_pubkey.slice(0, 8) },
          'Synthetic active DLMM metadata missing — skipping'
        );
        continue;
      }
      pnl = buildSyntheticPaperPnl(trackedPosition, syntheticState, latestSnapshot);
    } else {
      logger.debug(
        { positionPubkey: dlmm.position_pubkey.slice(0, 8), pool: dlmm.pool_pubkey.slice(0, 8) },
        'PnL data not found for position — skipping'
      );
      continue;
    }

    // Track OOR state in DB
    const wasOor = (await db.getActiveOorEvents()).some((e) => e.position_id === dlmm.position_id);
    if (!pnl.inRange && !wasOor) {
      // Newly out of range — record event
      await db.insertOorEvent({
        position_id: dlmm.position_id,
        detected_at: now,
        resolved_at: null,
        active_bin: pnl.activeBinId,
        lower_bin: pnl.lowerBinId,
        upper_bin: pnl.upperBinId,
      });
      logger.info(
        { positionId: dlmm.position_id, activeBin: pnl.activeBinId },
        'DLMM position went out of range'
      );
    } else if (pnl.inRange && wasOor) {
      // Back in range — resolve event
      await db.resolveOorEvent(dlmm.position_id);
      logger.info({ positionId: dlmm.position_id }, 'DLMM position back in range');
    }

    // Compute OOR duration for rule evaluation
    const minutesOor = await db.getOorMinutes(dlmm.position_id) ?? 0;
    const maxHoldMinutes = tierConfig ? tierConfig.max_hold_hours * 60 : undefined;

    // Evaluate hard close rules
    const hardRule = evaluateHardCloseRules(pnl, tierAwareMgmt, minutesOor, maxHoldMinutes);
    const trailing = evaluateTrailingTakeProfit(dlmm, pnl, tierAwareMgmt, now);
    const rugDecision =
      pnl.currentPrice !== null &&
      trackedPosition?.entry_price_sol !== null &&
      trackedPosition?.entry_price_sol !== undefined &&
      pnl.currentPrice < trackedPosition.entry_price_sol * 0.5 &&
      pnl.ageMinutes !== null &&
      pnl.ageMinutes < 60
        ? {
            action: 'close' as const,
            closeReason: 'rug_detected' as const,
            signalType: 'DLMM_STOP_LOSS' as const,
            notes: `Current price ${pnl.currentPrice.toFixed(4)} < 50% of entry ${trackedPosition.entry_price_sol.toFixed(4)} within ${pnl.ageMinutes} min`,
          }
        : null;
    await db.updateDlmmTrailingState(dlmm.position_id, {
      peak_pnl_pct: trailing.peakPnlPct,
      last_pnl_pct: pnl.pnlPct,
      trailing_armed_at: trailing.trailingArmedAt,
      last_monitored_at: now,
    });
    const result = rugDecision ?? hardRule ?? trailing.decision;

    const action: MonitorAction = result?.action ?? 'hold';
    const decision: MonitorDecision = {
      positionId: dlmm.position_id,
      positionPubkey: dlmm.position_pubkey,
      poolAddress: dlmm.pool_pubkey,
      action,
      closeReason: result?.closeReason,
      signalType: result?.signalType ?? 'HEARTBEAT',
      pnl,
      ...(trailing.peakPnlPct !== null && { peakPnlPct: trailing.peakPnlPct }),
      ...(trailing.drawdownPct !== null && { drawdownPct: trailing.drawdownPct }),
      ...(tierAwareMgmt.trailing_take_profit_enabled && { trailArmProfitPct: tierAwareMgmt.trail_arm_profit_pct }),
      notes: result?.notes ?? `In range: ${pnl.inRange}, PnL: ${pnl.pnlPct.toFixed(1)}%`,
    };

    decisions.push(decision);

    logger.info(
      {
        positionId: dlmm.position_id,
        action,
        pnlPct: pnl.pnlPct,
        inRange: pnl.inRange,
        minutesOor,
        unclaimedFees: pnl.unclaimedFeesUsd,
        notes: decision.notes,
      },
      'DLMM monitor decision'
    );
  }

  const closingCount = decisions.filter((d) => d.action === 'close').length;
  const claimingCount = decisions.filter((d) => d.action === 'claim_fee').length;
  logger.info(
    { total: decisions.length, closing: closingCount, claiming: claimingCount },
    'DLMM monitor cycle complete'
  );

  return decisions;
}

// ---------------------------------------------------------------------------
// Dynamic management interval (based on volatility)
// ---------------------------------------------------------------------------

/**
 * Computes the management interval in minutes based on current market volatility.
 * Higher volatility → shorter interval (more frequent checks).
 */
export function dynamicManagementInterval(
  maxVolatility: number,
  baseIntervalMinutes: number
): number {
  if (maxVolatility >= 5) return Math.min(baseIntervalMinutes, 3);
  if (maxVolatility >= 2) return Math.min(baseIntervalMinutes, 5);
  return baseIntervalMinutes;
}
