import type { DlmmPosition, Database, Opportunity, Position } from './db.js';
import type { ScoredOpportunity } from '../scoring/engine.js';
import { logger } from '../utils/logger.js';

interface MeteoraPoolPnlEntry {
  positionAddress?: string;
  position?: string;
  lowerBinId?: number;
  upperBinId?: number;
  poolActiveBinId?: number;
  createdAt?: number;
  pnlUsd?: number;
  pnlPctChange?: number;
  isOutOfRange?: boolean;
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

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toSafeInteger(value: number | null, fallback = 0): number {
  if (value === null || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.trunc(value);
}

function normalizeStrategy(strategy: string | null | undefined): string {
  switch ((strategy ?? '').toLowerCase()) {
    case 'spot':
      return 'Spot';
    case 'curve':
      return 'Curve';
    case 'bidask':
    case 'bid_ask':
    case 'bid-ask':
      return 'BidAsk';
    default:
      return 'Spot';
  }
}

export async function fetchOpenDlmmPoolPositions(
  poolAddress: string,
  walletAddress: string,
): Promise<MeteoraPoolPnlEntry[]> {
  const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn({ poolAddress, status: res.status }, 'Failed to fetch open Meteora positions for pool');
      return [];
    }

    const data = await res.json() as { positions?: MeteoraPoolPnlEntry[]; data?: MeteoraPoolPnlEntry[] };
    return data.positions ?? data.data ?? [];
  } catch (err) {
    logger.warn({ err, poolAddress }, 'Failed to fetch open Meteora positions for pool');
    return [];
  }
}

function pickBestWalletPosition(position: Position, entries: MeteoraPoolPnlEntry[]): MeteoraPoolPnlEntry | null {
  if (entries.length === 0) {
    return null;
  }

  if (entries.length === 1) {
    return entries[0] ?? null;
  }

  const openedAtMs = position.opened_at ? new Date(position.opened_at).getTime() : null;
  if (openedAtMs === null) {
    return [...entries].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ?? null;
  }

  return [...entries].sort((a, b) => {
    const aDiff = Math.abs(((a.createdAt ?? 0) * 1000) - openedAtMs);
    const bDiff = Math.abs(((b.createdAt ?? 0) * 1000) - openedAtMs);
    return aDiff - bDiff;
  })[0] ?? null;
}

export function buildExecutionOpportunity(
  position: Position,
  opportunity: Opportunity | null | undefined,
): ScoredOpportunity {
  const rawData = asRecord(opportunity?.raw_data ?? null);

  return {
    poolId: position.pool_id,
    protocol: position.protocol as ScoredOpportunity['protocol'],
    poolName: position.pool_name,
    apyDefillama: opportunity?.apy_defillama ?? null,
    apyProtocol: opportunity?.apy_protocol ?? null,
    apyUsed: opportunity?.apy_used ?? position.entry_apy,
    tvlUsd: opportunity?.tvl_usd ?? position.size_usd,
    dataUncertain: opportunity ? opportunity.data_uncertain === 1 : true,
    score: opportunity?.score ?? 50,
    apyScore: 0,
    liquidityScore: 0,
    trustScore: 0,
    riskPenalty: 0,
    regimePenalty: 0,
    recommendation: 'SUGGEST',
    raw_data: rawData,
  };
}

export async function ensureDlmmPositionRecord(
  db: Database,
  position: Position,
  walletAddress: string,
  preferredStrategy?: string,
): Promise<DlmmPosition | null> {
  const existing = await db.getDlmmPosition(position.id);
  if (existing) {
    return existing;
  }

  const entries = await fetchOpenDlmmPoolPositions(position.pool_id, walletAddress);
  const best = pickBestWalletPosition(position, entries);
  if (!best) {
    return null;
  }

  const positionPubkey = best.positionAddress ?? best.position;
  if (!positionPubkey) {
    return null;
  }

  const knownByPubkey = await db.getDlmmPositionByPubkey(positionPubkey);
  if (knownByPubkey) {
    return knownByPubkey;
  }

  const opportunity = await db.getOpportunity(position.opportunity_id);
  const rawData = asRecord(opportunity?.raw_data ?? null);
  const activeBin = toNumber(best.poolActiveBinId) ?? toNumber(rawData['activeBinId']) ?? 0;
  const lowerBin = toNumber(best.lowerBinId) ?? toNumber(rawData['lowerBinId']) ?? activeBin;
  const upperBin = toNumber(best.upperBinId) ?? toNumber(rawData['upperBinId']) ?? activeBin;
  const activeBinId = toSafeInteger(activeBin);
  const lowerBinId = toSafeInteger(lowerBin, activeBinId);
  const upperBinId = toSafeInteger(upperBin, activeBinId);
  const binsBelow = Math.max(0, activeBinId - lowerBinId);
  const binsAbove = Math.max(0, upperBinId - activeBinId);

  try {
    return await db.insertDlmmPosition({
      position_id: position.id,
      position_pubkey: positionPubkey,
      pool_pubkey: position.pool_id,
      lower_bin_id: lowerBinId,
      upper_bin_id: upperBinId,
      active_bin_at_deploy: activeBinId,
      strategy: normalizeStrategy((rawData['strategy'] as string | undefined) ?? preferredStrategy),
      bins_below: binsBelow,
      bins_above: binsAbove,
      amount_x_deployed: toNumber(rawData['amountX']),
      amount_y_deployed: toNumber(rawData['amountY']),
      initial_value_usd: position.size_usd,
      bin_step: toNumber(rawData['binStep']) != null ? toSafeInteger(toNumber(rawData['binStep'])) : null,
      volatility_at_deploy: toNumber(rawData['volatility']),
      fee_tvl_ratio_at_deploy: toNumber(rawData['feeTvlRatio']) ?? toNumber(rawData['feeTvlRatio24h']),
      organic_score_at_deploy: toNumber(rawData['organicScore']),
      base_mint: position.base_mint,
      deployed_at: position.opened_at ?? position.created_at,
    });
  } catch (err) {
    logger.warn({ err, positionId: position.id, positionPubkey }, 'Failed to backfill DLMM position row, retrying read');
    return (await db.getDlmmPosition(position.id)) ?? (await db.getDlmmPositionByPubkey(positionPubkey)) ?? null;
  }
}
