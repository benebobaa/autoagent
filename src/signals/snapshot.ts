import { z } from 'zod';
import { createHash } from 'crypto';
import type { MarketRegime } from './regime.js';

// ---------------------------------------------------------------------------
// MarketSnapshot — output of one Tier-1 polling cycle
// ---------------------------------------------------------------------------
// Stored to PostgreSQL (market_snapshots table). The signal detector compares
// consecutive snapshots to determine whether any thresholds are breached.
// ---------------------------------------------------------------------------

export const PoolSnapshotSchema = z.object({
  poolId: z.string(),
  protocol: z.string(),
  poolName: z.string(),
  apyPct: z.number(),         // current APY in %
  tvlUsd: z.number(),
  il7d: z.number().nullable(), // 7-day impermanent loss from DefiLlama (null if not LP)
  score: z.number(),
  snapshotAt: z.string().datetime(),

  // Meteora specific optional fields
  binStep: z.number().optional(),
  activeBinId: z.number().optional(),
  feeApr24h: z.number().optional(),
  liquidityInActiveBins: z.number().optional(),
  inRange: z.boolean().optional(),
  volume24hUsd: z.number().optional(),
});

export type PoolSnapshot = z.infer<typeof PoolSnapshotSchema>;

export const MarketSnapshotSchema = z.object({
  id: z.string().uuid(),
  snapshotAt: z.string().datetime(),
  pools: z.array(PoolSnapshotSchema),
  solPriceUsd: z.number(),
  hash: z.string(), // SHA-256 of sorted pool data for change detection
  regime: z.enum(['BULL_TREND', 'BEAR_TREND', 'HIGH_VOL_RANGE', 'LOW_VOL_RANGE', 'CAPITULATION', 'EUPHORIA']).optional(),
});

export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildSnapshotHash(pools: PoolSnapshot[], solPrice: number): string {
  const sorted = [...pools].sort((a, b) => a.poolId.localeCompare(b.poolId));
  const payload = JSON.stringify({ pools: sorted, solPrice });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}
