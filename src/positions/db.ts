import { readFileSync, readdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { createScopedPool, getPool, closePool, ensureExtensionInPublic } from '../storage/pg-pool.js';
import { logger } from '../utils/logger.js';
import type { DecisionAction, DecisionGrade } from '../rag/decision-types.js';
import type { BaseMintBookStatsMap, ProtocolBookStatsMap } from '../portfolio/history-policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../../migrations');

export type PositionState =
  | 'PENDING_OPEN'
  | 'ACTIVE'
  | 'PENDING_REBALANCE'
  | 'PENDING_CLOSE'
  | 'CLOSED';

export interface Opportunity {
  id: string;
  protocol: string;
  pool_id: string;
  pool_name: string;
  apy_defillama: number | null;
  apy_protocol: number | null;
  apy_used: number;
  data_uncertain: number;
  tvl_usd: number | null;
  score: number;
  raw_data: unknown | null;
  scanned_at: string;
}

export interface Position {
  id: string;
  opportunity_id: string;
  protocol: string;
  pool_id: string;
  pool_name: string;
  state: PositionState;
  book: 'core' | 'scout' | null;
  base_mint: string | null;
  tier?: number | null;
  deployment_mode?: 'passive' | 'active' | null;
  position_style?: string | null;
  size_usd: number;
  entry_apy: number;
  entry_price_sol: number | null;
  opened_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
  notes: string | null;
  created_at: string;
}

export interface PnlSnapshot {
  id: string;
  position_id: string;
  snapshot_at: string;
  method: 'cash_flow' | 'mark_to_market';
  yield_earned_usd: number | null;
  gas_paid_usd: number | null;
  cash_flow_pnl_usd: number | null;
  cost_basis_usd: number | null;
  current_value_usd: number | null;
  mtm_pnl_usd: number | null;
}

export interface ApySnapshot {
  id: string;
  position_id: string;
  snapshot_at: string;
  current_apy_pct: number;
  pool_tvl_usd: number;
}

export interface RealizedPnlRow {
  id: string;
  position_id: string;
  token_a_deposited: number | null;
  token_b_deposited: number | null;
  token_a_withdrawn: number | null;
  token_b_withdrawn: number | null;
  fees_claimed_usd: number | null;
  il_usd: number | null;
  gas_paid_usd: number | null;
  net_pnl_usd: number | null;
  time_weighted_capital_usd: number | null;
  realized_apy_pct: number | null;
  computed_at: string;
}

export type ExecutionAction = 'open' | 'close' | 'rebalance' | 'claim_fee' | 'add_liquidity' | 'withdraw';

export interface ExecutionLog {
  id: string;
  position_id: string;
  action: ExecutionAction;
  tx_base64: string | null;
  simulation_result: string | null;
  executed: number;
  tx_signature: string | null;
  exit_reason?: string | null;
  created_at: string;
}

export interface PortfolioValueHistoryRow {
  id: string;
  total_value_usd: number;
  created_at: string;
}

export interface TierAllocationSnapshot {
  id: string;
  snapshot_at: string;
  tier: number;
  target_pct: number;
  current_pct: number;
  deployed_usd: number;
}

export interface DecisionEpisodeRow {
  id: string;
  decision_at: string;
  action: DecisionAction;
  book: 'core' | 'scout' | null;
  signal_types: string;
  market_regime: string | null;
  sol_price_usd: number | null;
  portfolio_size_usd: number;
  active_position_count: number;
  target_pool_id: string | null;
  target_protocol: string | null;
  target_pool_name: string | null;
  position_size_usd: number | null;
  position_id: string | null;
  reasoning: string;
  source: 'live' | 'paper' | 'backtest';
  outcome_resolved_at: string | null;
  outcome_net_pnl_usd: number | null;
  outcome_realized_apy_pct: number | null;
  outcome_days_held: number | null;
  outcome_exit_reason: string | null;
  outcome_exit_regime: string | null;
  outcome_exit_sol_price: number | null;
  grade: DecisionGrade | null;
  lesson_learned: string | null;
  created_at: string;
}

export interface SkipEpisodeRow {
  id: string;
  skipped_at: string;
  pool_id: string;
  protocol: string;
  pool_name: string;
  apy_at_skip: number;
  score_at_skip: number;
  signal_types: string;
  market_regime: string | null;
  skip_reason: string;
  hindsight_apy_after_48h: number | null;
  hindsight_tvl_change_usd: number | null;
  grade: DecisionGrade | null;
  created_at: string;
}

export interface PaperPortfolio {
  id: string;
  starting_balance_usd: number;
  created_at: string;
}

export interface DlmmPosition {
  id: string;
  position_id: string;
  position_pubkey: string;
  pool_pubkey: string;
  lower_bin_id: number;
  upper_bin_id: number;
  active_bin_at_deploy: number;
  strategy: string;
  bins_below: number;
  bins_above: number;
  amount_x_deployed: number | null;
  amount_y_deployed: number | null;
  initial_value_usd: number | null;
  bin_step: number | null;
  volatility_at_deploy: number | null;
  fee_tvl_ratio_at_deploy: number | null;
  organic_score_at_deploy: number | null;
  base_mint: string | null;
  peak_pnl_pct: number | null;
  last_pnl_pct: number | null;
  trailing_armed_at: string | null;
  last_monitored_at: string | null;
  deployed_at: string;
}

export interface FeeClaim {
  id: string;
  position_id: string;
  claimed_usd: number;
  tx_signature: string | null;
  claimed_at: string;
}

export interface OorEvent {
  id: string;
  position_id: string;
  detected_at: string;
  resolved_at: string | null;
  active_bin: number | null;
  lower_bin: number | null;
  upper_bin: number | null;
}

export interface OorTokenExit {
  base_mint: string;
  exit_count: number;
  last_exit_at: string;
  cooldown_until: string | null;
}

export interface PoolCooldown {
  id: string;
  pool_id: string;
  reason: string;
  cooldown_until: string;
  source_position_id: string | null;
  created_at: string;
}

type SignalQueueRow = {
  id: string;
  type: string;
  priority: string;
  payload: string;
  dedupKey: string;
  createdAt: string;
};

type OpportunityRow = Omit<Opportunity, 'data_uncertain'> & { data_uncertain: boolean };

type ExecutionLogRow = Omit<ExecutionLog, 'executed'> & { executed: boolean };

type PendingApprovalRow = {
  id: string;
  threadId: string;
  checkpointId: string | null;
  interruptValue: unknown;
  telegramMessageId: number | null;
  status: string;
  created_at?: string;
  resolved_at?: string | null;
};

function normalizeRow<T extends QueryResultRow>(row: T): T {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key] = value instanceof Date ? value.toISOString() : value;
  }
  return normalized as T;
}

function normalizeRows<T extends QueryResultRow>(rows: T[]): T[] {
  return rows.map((row) => normalizeRow(row));
}

function toPgJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export class Database {
  private readonly ready: Promise<void>;
  private readonly resetOnInit: boolean;
  private readonly pool: Pool;
  private readonly ownedPool: boolean;
  private readonly schemaName: string | null;

  constructor(databaseUrl?: string) {
    this.resetOnInit = databaseUrl !== undefined && !databaseUrl.startsWith('postgres');
    if (this.resetOnInit && databaseUrl !== undefined) {
      const scoped = createScopedPool(databaseUrl);
      this.pool = scoped.pool;
      this.ownedPool = true;
      this.schemaName = scoped.schemaName;
    } else {
      this.pool = getPool();
      this.ownedPool = false;
      this.schemaName = null;
    }
    this.ready = this.migrate();
    logger.debug('PostgreSQL database initialized');
  }

  private async migrate(): Promise<void> {
    await ensureExtensionInPublic('vector');

    if (this.schemaName !== null) {
      await this.pool.query(`DROP SCHEMA IF EXISTS ${this.schemaName} CASCADE`);
      await this.pool.query(`CREATE SCHEMA ${this.schemaName}`);
    }

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf-8');
      await this.pool.query(sql);
    }

    if (this.resetOnInit && this.schemaName === null) {
      await this.pool.query(
        `TRUNCATE TABLE
           rag_documents,
           skip_episodes,
           decision_episodes,
           oor_events,
           pool_cooldowns,
           fee_claims,
           dlmm_positions,
           paper_portfolio,
           pending_approvals,
           market_snapshots,
           signal_queue,
           realized_pnl,
           apy_snapshots,
           execution_log,
           pnl_snapshots,
           positions,
           opportunities
         RESTART IDENTITY CASCADE`
      );
    }
  }

  private async query<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    await this.ready;
    const result = await this.pool.query<T>(sql, params);
    return normalizeRows(result.rows);
  }

  private async one<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.ownedPool) {
      await this.pool.end();
      return;
    }

    await closePool();
  }

  async insertOpportunity(data: Omit<Opportunity, 'id' | 'scanned_at'>): Promise<Opportunity> {
    const id = uuidv4();
    const scanned_at = new Date().toISOString();
    const rawData = toPgJson(data.raw_data ?? null);
    await this.query(
      `INSERT INTO opportunities
         (id, protocol, pool_id, pool_name, apy_defillama, apy_protocol, apy_used,
          data_uncertain, tvl_usd, score, raw_data, scanned_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        data.protocol,
        data.pool_id,
        data.pool_name,
        data.apy_defillama,
        data.apy_protocol,
        data.apy_used,
        data.data_uncertain === 1,
        data.tvl_usd,
        data.score,
        rawData,
        scanned_at,
      ]
    );
    return { ...data, id, scanned_at, raw_data: rawData };
  }

  async getOpportunity(id: string): Promise<Opportunity | undefined> {
    const row = await this.one<OpportunityRow>(`SELECT * FROM opportunities WHERE id = $1`, [id]);
    return row ? { ...row, data_uncertain: row.data_uncertain ? 1 : 0 } : undefined;
  }

  async getLatestOpportunities(limit = 50): Promise<Opportunity[]> {
    const rows = await this.query<OpportunityRow>(
      `SELECT * FROM opportunities ORDER BY scanned_at DESC LIMIT $1`,
      [limit]
    );
    return rows.map((row) => ({ ...row, data_uncertain: row.data_uncertain ? 1 : 0 }));
  }

  async insertPosition(data: Omit<Position, 'id' | 'created_at'>): Promise<Position> {
    const id = uuidv4();
    const created_at = new Date().toISOString();
    await this.query(
      `INSERT INTO positions
         (id, opportunity_id, protocol, pool_id, pool_name, state, book, base_mint, tier, deployment_mode,
          position_style, size_usd, entry_apy, entry_price_sol, opened_at, closed_at, close_reason, notes, created_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        id,
        data.opportunity_id,
        data.protocol,
        data.pool_id,
        data.pool_name,
        data.state,
        data.book,
        data.base_mint,
        data.tier ?? null,
        data.deployment_mode ?? null,
        data.position_style ?? null,
        data.size_usd,
        data.entry_apy,
        data.entry_price_sol,
        data.opened_at,
        data.closed_at,
        data.close_reason,
        data.notes,
        created_at,
      ]
    );
    return { ...data, id, created_at };
  }

  async getPosition(id: string): Promise<Position | undefined> {
    return this.one<Position>(`SELECT * FROM positions WHERE id = $1`, [id]);
  }

  async getPositionsByState(state: PositionState): Promise<Position[]> {
    return this.query<Position>(`SELECT * FROM positions WHERE state = $1 ORDER BY created_at DESC`, [state]);
  }

  async getAllPositions(): Promise<Position[]> {
    return this.query<Position>(`SELECT * FROM positions ORDER BY created_at DESC`);
  }

  async countActivePositions(): Promise<number> {
    const row = await this.one<{ cnt: string }>(`SELECT COUNT(*)::text as cnt FROM positions WHERE state = 'ACTIVE'`);
    return row ? Number(row.cnt) : 0;
  }

  async updatePositionState(
    id: string,
    state: PositionState,
    opts: {
      tx_signature?: string;
      opened_at?: string;
      closed_at?: string;
      close_reason?: string;
    } = {}
  ): Promise<void> {
    await this.query(
      `UPDATE positions SET
         state = $2,
         opened_at = COALESCE($3, opened_at),
         closed_at = COALESCE($4, closed_at),
         close_reason = COALESCE($5, close_reason)
       WHERE id = $1`,
      [id, state, opts.opened_at ?? null, opts.closed_at ?? null, opts.close_reason ?? null]
    );
  }

  async updatePositionExecutionMetadata(
    id: string,
    opts: {
      entry_price_sol?: number | null;
      notes?: string | null;
    }
  ): Promise<void> {
    await this.query(
      `UPDATE positions SET
         entry_price_sol = COALESCE($2, entry_price_sol),
         notes = COALESCE($3, notes)
       WHERE id = $1`,
      [id, opts.entry_price_sol ?? null, opts.notes ?? null]
    );
  }

  async insertPnlSnapshot(data: Omit<PnlSnapshot, 'id' | 'snapshot_at'>): Promise<PnlSnapshot> {
    const id = uuidv4();
    const snapshot_at = new Date().toISOString();
    await this.query(
      `INSERT INTO pnl_snapshots
         (id, position_id, snapshot_at, method, yield_earned_usd, gas_paid_usd,
          cash_flow_pnl_usd, cost_basis_usd, current_value_usd, mtm_pnl_usd)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        data.position_id,
        snapshot_at,
        data.method,
        data.yield_earned_usd,
        data.gas_paid_usd,
        data.cash_flow_pnl_usd,
        data.cost_basis_usd,
        data.current_value_usd,
        data.mtm_pnl_usd,
      ]
    );
    return { ...data, id, snapshot_at };
  }

  async getLatestPnlSnapshot(positionId: string, method: 'cash_flow' | 'mark_to_market'): Promise<PnlSnapshot | undefined> {
    return this.one<PnlSnapshot>(
      `SELECT * FROM pnl_snapshots WHERE position_id = $1 AND method = $2 ORDER BY snapshot_at DESC LIMIT 1`,
      [positionId, method]
    );
  }

  async insertApySnapshot(data: Omit<ApySnapshot, 'id' | 'snapshot_at'>): Promise<ApySnapshot> {
    const id = uuidv4();
    const snapshot_at = new Date().toISOString();
    await this.query(
      `INSERT INTO apy_snapshots (id, position_id, snapshot_at, current_apy_pct, pool_tvl_usd)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, data.position_id, snapshot_at, data.current_apy_pct, data.pool_tvl_usd]
    );
    return { ...data, id, snapshot_at };
  }

  async getApySnapshots(positionId: string): Promise<ApySnapshot[]> {
    return this.query<ApySnapshot>(
      `SELECT * FROM apy_snapshots WHERE position_id = $1 ORDER BY snapshot_at ASC`,
      [positionId]
    );
  }

  async upsertRealizedPnl(positionId: string, data: {
    tokenADeposited: number;
    tokenBDeposited: number;
    tokenAWithdrawn: number;
    tokenBWithdrawn: number;
    feesClaimedUsd: number;
    ilUsd: number;
    gasPaidUsd: number;
    netPnlUsd: number;
    timeWeightedCapitalUsd: number;
    realizedApyPct: number;
  }): Promise<void> {
    const id = uuidv4();
    const computed_at = new Date().toISOString();
    await this.query(
      `INSERT INTO realized_pnl
         (id, position_id, token_a_deposited, token_b_deposited, token_a_withdrawn, token_b_withdrawn,
          fees_claimed_usd, il_usd, gas_paid_usd, net_pnl_usd, time_weighted_capital_usd, realized_apy_pct, computed_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (position_id) DO UPDATE SET
         token_a_deposited = EXCLUDED.token_a_deposited,
         token_b_deposited = EXCLUDED.token_b_deposited,
         token_a_withdrawn = EXCLUDED.token_a_withdrawn,
         token_b_withdrawn = EXCLUDED.token_b_withdrawn,
         fees_claimed_usd = EXCLUDED.fees_claimed_usd,
         il_usd = EXCLUDED.il_usd,
         gas_paid_usd = EXCLUDED.gas_paid_usd,
         net_pnl_usd = EXCLUDED.net_pnl_usd,
         time_weighted_capital_usd = EXCLUDED.time_weighted_capital_usd,
         realized_apy_pct = EXCLUDED.realized_apy_pct,
         computed_at = EXCLUDED.computed_at`,
      [
        id,
        positionId,
        data.tokenADeposited,
        data.tokenBDeposited,
        data.tokenAWithdrawn,
        data.tokenBWithdrawn,
        data.feesClaimedUsd,
        data.ilUsd,
        data.gasPaidUsd,
        data.netPnlUsd,
        data.timeWeightedCapitalUsd,
        data.realizedApyPct,
        computed_at,
      ]
    );
  }

  async getRealizedPnl(positionId: string): Promise<RealizedPnlRow | undefined> {
    return this.one<RealizedPnlRow>(`SELECT * FROM realized_pnl WHERE position_id = $1`, [positionId]);
  }

  async insertExecutionLog(data: Omit<ExecutionLog, 'id' | 'created_at'>): Promise<ExecutionLog> {
    const id = uuidv4();
    const created_at = new Date().toISOString();
    await this.query(
      `INSERT INTO execution_log
         (id, position_id, action, tx_base64, simulation_result, executed, tx_signature, exit_reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        data.position_id,
        data.action,
        data.tx_base64,
        data.simulation_result,
        data.executed === 1,
        data.tx_signature,
        data.exit_reason ?? null,
        created_at,
      ]
    );
    return { ...data, id, created_at };
  }

  async getExecutionLog(id: string): Promise<ExecutionLog | undefined> {
    const row = await this.one<ExecutionLogRow>(`SELECT * FROM execution_log WHERE id = $1`, [id]);
    return row ? { ...row, executed: row.executed ? 1 : 0 } : undefined;
  }

  async getExecutionLogsByPosition(positionId: string): Promise<ExecutionLog[]> {
    const rows = await this.query<ExecutionLogRow>(
      `SELECT * FROM execution_log WHERE position_id = $1 ORDER BY created_at DESC`,
      [positionId]
    );
    return rows.map((row) => ({ ...row, executed: row.executed ? 1 : 0 }));
  }

  async insertPortfolioValueHistory(totalValueUsd: number): Promise<PortfolioValueHistoryRow> {
    const row: PortfolioValueHistoryRow = {
      id: uuidv4(),
      total_value_usd: totalValueUsd,
      created_at: new Date().toISOString(),
    };
    await this.query(
      `INSERT INTO portfolio_value_history (id, total_value_usd, created_at) VALUES ($1, $2, $3)`,
      [row.id, row.total_value_usd, row.created_at]
    );
    return row;
  }

  async getPortfolioValueHistory(hours = 48): Promise<PortfolioValueHistoryRow[]> {
    return this.query<PortfolioValueHistoryRow>(
      `SELECT id, total_value_usd, created_at
       FROM portfolio_value_history
       WHERE created_at >= NOW() - ($1 || ' hours')::interval
       ORDER BY created_at ASC`,
      [hours]
    );
  }

  async insertTierAllocationSnapshot(data: Omit<TierAllocationSnapshot, 'id' | 'snapshot_at'>): Promise<TierAllocationSnapshot> {
    const row: TierAllocationSnapshot = {
      id: uuidv4(),
      snapshot_at: new Date().toISOString(),
      tier: data.tier,
      target_pct: data.target_pct,
      current_pct: data.current_pct,
      deployed_usd: data.deployed_usd,
    };
    await this.query(
      `INSERT INTO tier_allocation_snapshots (id, snapshot_at, tier, target_pct, current_pct, deployed_usd)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.id, row.snapshot_at, row.tier, row.target_pct, row.current_pct, row.deployed_usd]
    );
    return row;
  }

  async getLatestTierAllocationSnapshots(): Promise<TierAllocationSnapshot[]> {
    return this.query<TierAllocationSnapshot>(
      `SELECT DISTINCT ON (tier) id, snapshot_at, tier, target_pct, current_pct, deployed_usd
       FROM tier_allocation_snapshots
       ORDER BY tier, snapshot_at DESC`
    );
  }

  async markExecutionLogExecuted(id: string, txSignature: string): Promise<void> {
    await this.query(`UPDATE execution_log SET executed = TRUE, tx_signature = $1 WHERE id = $2`, [txSignature, id]);
  }

  async insertSignal(signal: { id: string; type: string; priority: string; payload: unknown; dedupKey: string }): Promise<boolean> {
    const rows = await this.query<{ inserted: boolean }>(
      `INSERT INTO signal_queue (id, type, priority, payload, dedup_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (dedup_key) DO NOTHING
       RETURNING TRUE as inserted`,
      [signal.id, signal.type, signal.priority, signal.payload, signal.dedupKey, new Date().toISOString()]
    );
    return rows.length > 0;
  }

  async getUnprocessedSignals(priority: string): Promise<SignalQueueRow[]> {
    return this.query<SignalQueueRow>(
      `SELECT id, type, priority, payload::text as payload, dedup_key as "dedupKey", created_at as "createdAt"
       FROM signal_queue
       WHERE priority = $1 AND processed_at IS NULL
       ORDER BY created_at ASC`,
      [priority]
    );
  }

  async getAllUnprocessedSignals(): Promise<SignalQueueRow[]> {
    return this.query<SignalQueueRow>(
      `SELECT id, type, priority, payload::text as payload, dedup_key as "dedupKey", created_at as "createdAt"
       FROM signal_queue
       WHERE processed_at IS NULL
       ORDER BY CASE priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 ELSE 2 END, created_at ASC`
    );
  }

  async markSignalsProcessed(ids: string[], threadId: string): Promise<void> {
    if (ids.length === 0) return;
    await this.query(
      `UPDATE signal_queue SET processed_at = $1, thread_id = $2 WHERE id = ANY($3::text[])`,
      [new Date().toISOString(), threadId, ids]
    );
  }

  async insertMarketSnapshot(id: string, data: unknown): Promise<void> {
    await this.query(
      `INSERT INTO market_snapshots (id, snapshot_at, data)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET snapshot_at = EXCLUDED.snapshot_at, data = EXCLUDED.data`,
      [id, new Date().toISOString(), data]
    );
  }

  async getLatestSnapshot(): Promise<unknown | undefined> {
    const row = await this.one<{ data: unknown }>(`SELECT data FROM market_snapshots ORDER BY snapshot_at DESC LIMIT 1`);
    return row?.data;
  }

  async getPreviousSnapshot(): Promise<unknown | undefined> {
    const row = await this.one<{ data: unknown }>(`SELECT data FROM market_snapshots ORDER BY snapshot_at DESC LIMIT 1 OFFSET 1`);
    return row?.data;
  }

  async insertPendingApproval(approval: { id: string; threadId: string; checkpointId: string | null; interruptValue: unknown }): Promise<void> {
    await this.query(
      `INSERT INTO pending_approvals (id, thread_id, checkpoint_id, interrupt_value, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [approval.id, approval.threadId, approval.checkpointId, approval.interruptValue, new Date().toISOString()]
    );
  }

  async getPendingApproval(id: string): Promise<PendingApprovalRow | undefined> {
    return this.one<PendingApprovalRow>(
      `SELECT id, thread_id as "threadId", checkpoint_id as "checkpointId", interrupt_value as "interruptValue",
              telegram_message_id as "telegramMessageId", status
       FROM pending_approvals WHERE id = $1`,
      [id]
    );
  }

  async updateApprovalStatus(id: string, status: 'approved' | 'rejected', telegramMessageId?: number): Promise<void> {
    await this.query(
      `UPDATE pending_approvals
       SET status = $2,
           telegram_message_id = COALESCE($3, telegram_message_id),
           resolved_at = $4
       WHERE id = $1`,
      [id, status, telegramMessageId ?? null, new Date().toISOString()]
    );
  }

  async getPendingApprovalByMessageId(telegramMessageId: number): Promise<PendingApprovalRow | undefined> {
    return this.one<PendingApprovalRow>(
      `SELECT id, thread_id as "threadId", checkpoint_id as "checkpointId", interrupt_value as "interruptValue",
              telegram_message_id as "telegramMessageId", status, created_at, resolved_at
       FROM pending_approvals
       WHERE telegram_message_id = $1 AND status = 'pending'`,
      [telegramMessageId]
    );
  }

  async setApprovalTelegramMessageId(id: string, telegramMessageId: number): Promise<void> {
    await this.query(`UPDATE pending_approvals SET telegram_message_id = $2 WHERE id = $1`, [id, telegramMessageId]);
  }

  async initPaperPortfolio(startingBalanceUsd: number): Promise<PaperPortfolio> {
    const existing = await this.getPaperPortfolio();
    if (existing) return existing;

    const created_at = new Date().toISOString();
    await this.query(
      `INSERT INTO paper_portfolio (id, starting_balance_usd, created_at)
       VALUES ('singleton', $1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [startingBalanceUsd, created_at]
    );
    return { id: 'singleton', starting_balance_usd: startingBalanceUsd, created_at };
  }

  async getPaperPortfolio(): Promise<PaperPortfolio | undefined> {
    return this.one<PaperPortfolio>(`SELECT * FROM paper_portfolio WHERE id = 'singleton'`);
  }

  async insertDlmmPosition(
    data: Omit<DlmmPosition, 'id' | 'peak_pnl_pct' | 'last_pnl_pct' | 'trailing_armed_at' | 'last_monitored_at'> &
      Partial<Pick<DlmmPosition, 'peak_pnl_pct' | 'last_pnl_pct' | 'trailing_armed_at' | 'last_monitored_at'>>
  ): Promise<DlmmPosition> {
    const id = uuidv4();
    const row = {
      peak_pnl_pct: null,
      last_pnl_pct: null,
      trailing_armed_at: null,
      last_monitored_at: null,
      ...data,
    };
    await this.query(
      `INSERT INTO dlmm_positions
         (id, position_id, position_pubkey, pool_pubkey, lower_bin_id, upper_bin_id,
          active_bin_at_deploy, strategy, bins_below, bins_above, amount_x_deployed,
          amount_y_deployed, initial_value_usd, bin_step, volatility_at_deploy,
          fee_tvl_ratio_at_deploy, organic_score_at_deploy, base_mint, peak_pnl_pct,
          last_pnl_pct, trailing_armed_at, last_monitored_at, deployed_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      [
        id,
        row.position_id,
        row.position_pubkey,
        row.pool_pubkey,
        row.lower_bin_id,
        row.upper_bin_id,
        row.active_bin_at_deploy,
        row.strategy,
        row.bins_below,
        row.bins_above,
        row.amount_x_deployed,
        row.amount_y_deployed,
        row.initial_value_usd,
        row.bin_step,
        row.volatility_at_deploy,
        row.fee_tvl_ratio_at_deploy,
        row.organic_score_at_deploy,
        row.base_mint,
        row.peak_pnl_pct,
        row.last_pnl_pct,
        row.trailing_armed_at,
        row.last_monitored_at,
        row.deployed_at,
      ]
    );
    return { ...row, id } as DlmmPosition;
  }

  async getDlmmPosition(positionId: string): Promise<DlmmPosition | undefined> {
    return this.one<DlmmPosition>(`SELECT * FROM dlmm_positions WHERE position_id = $1`, [positionId]);
  }

  async getDlmmPositionByPubkey(positionPubkey: string): Promise<DlmmPosition | undefined> {
    return this.one<DlmmPosition>(`SELECT * FROM dlmm_positions WHERE position_pubkey = $1`, [positionPubkey]);
  }

  async getActiveDlmmPositions(): Promise<DlmmPosition[]> {
    return this.query<DlmmPosition>(
      `SELECT dp.* FROM dlmm_positions dp
       JOIN positions p ON dp.position_id = p.id
       WHERE p.state = 'ACTIVE'
       ORDER BY dp.deployed_at DESC`
    );
  }

  async updateDlmmPositionBinRange(positionId: string, lowerBinId: number, upperBinId: number): Promise<void> {
    await this.query(`UPDATE dlmm_positions SET lower_bin_id = $1, upper_bin_id = $2 WHERE position_id = $3`, [lowerBinId, upperBinId, positionId]);
  }

  async updateDlmmTrailingState(
    positionId: string,
    state: Pick<DlmmPosition, 'peak_pnl_pct' | 'last_pnl_pct' | 'trailing_armed_at' | 'last_monitored_at'>
  ): Promise<void> {
    await this.query(
      `UPDATE dlmm_positions
       SET peak_pnl_pct = $1, last_pnl_pct = $2, trailing_armed_at = $3, last_monitored_at = $4
       WHERE position_id = $5`,
      [state.peak_pnl_pct, state.last_pnl_pct, state.trailing_armed_at, state.last_monitored_at, positionId]
    );
  }

  async insertFeeClaim(data: Omit<FeeClaim, 'id'>): Promise<FeeClaim> {
    const id = uuidv4();
    await this.query(
      `INSERT INTO fee_claims (id, position_id, claimed_usd, tx_signature, claimed_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, data.position_id, data.claimed_usd, data.tx_signature, data.claimed_at]
    );
    return { ...data, id };
  }

  async getFeeClaimsByPosition(positionId: string): Promise<FeeClaim[]> {
    return this.query<FeeClaim>(`SELECT * FROM fee_claims WHERE position_id = $1 ORDER BY claimed_at DESC`, [positionId]);
  }

  async getTotalClaimedFees(positionId: string): Promise<number> {
    const row = await this.one<{ total: number | string }>(
      `SELECT COALESCE(SUM(claimed_usd), 0) as total FROM fee_claims WHERE position_id = $1`,
      [positionId]
    );
    return row ? Number(row.total) : 0;
  }

  async upsertPoolCooldown(data: Omit<PoolCooldown, 'id' | 'created_at'>): Promise<PoolCooldown> {
    const id = uuidv4();
    const created_at = new Date().toISOString();
    await this.query(
      `INSERT INTO pool_cooldowns (id, pool_id, reason, cooldown_until, source_position_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, data.pool_id, data.reason, data.cooldown_until, data.source_position_id, created_at]
    );
    return { ...data, id, created_at };
  }

  async getActivePoolCooldown(poolId: string, now = new Date().toISOString()): Promise<PoolCooldown | undefined> {
    return this.one<PoolCooldown>(
      `SELECT * FROM pool_cooldowns WHERE pool_id = $1 AND cooldown_until > $2 ORDER BY cooldown_until DESC LIMIT 1`,
      [poolId, now]
    );
  }

  async getActivePoolCooldowns(now = new Date().toISOString()): Promise<PoolCooldown[]> {
    return this.query<PoolCooldown>(
      `SELECT * FROM pool_cooldowns WHERE cooldown_until > $1 ORDER BY cooldown_until DESC`,
      [now]
    );
  }

  async insertOorEvent(data: Omit<OorEvent, 'id'>): Promise<OorEvent> {
    const id = uuidv4();
    await this.query(
      `INSERT INTO oor_events (id, position_id, detected_at, resolved_at, active_bin, lower_bin, upper_bin)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, data.position_id, data.detected_at, data.resolved_at, data.active_bin, data.lower_bin, data.upper_bin]
    );
    return { ...data, id };
  }

  async resolveOorEvent(positionId: string): Promise<void> {
    await this.query(`UPDATE oor_events SET resolved_at = $1 WHERE position_id = $2 AND resolved_at IS NULL`, [new Date().toISOString(), positionId]);
  }

  async getActiveOorEvents(): Promise<OorEvent[]> {
    return this.query<OorEvent>(`SELECT * FROM oor_events WHERE resolved_at IS NULL`);
  }

  async getOorEventsByPosition(positionId: string): Promise<OorEvent[]> {
    return this.query<OorEvent>(`SELECT * FROM oor_events WHERE position_id = $1 ORDER BY detected_at DESC`, [positionId]);
  }

  async getOorMinutes(positionId: string): Promise<number | null> {
    const event = await this.one<{ detected_at: string }>(
      `SELECT detected_at FROM oor_events WHERE position_id = $1 AND resolved_at IS NULL ORDER BY detected_at DESC LIMIT 1`,
      [positionId]
    );
    if (!event) return null;
    return (Date.now() - new Date(event.detected_at).getTime()) / 60_000;
  }

  /**
   * Record an OOR exit for a base token mint.
   * After `triggerCount` exits (default 3), sets `cooldown_until` to block the token
   * from being picked by the discovery scanner for `cooldownHours` hours.
   */
  async recordOorTokenExit(
    baseMint: string,
    triggerCount = 3,
    cooldownHours = 12,
  ): Promise<OorTokenExit> {
    const now = new Date().toISOString();
    const row = await this.one<OorTokenExit>(
      `INSERT INTO oor_token_exits (base_mint, exit_count, last_exit_at, cooldown_until)
       VALUES ($1, 1, $2, NULL)
       ON CONFLICT (base_mint) DO UPDATE
         SET exit_count    = oor_token_exits.exit_count + 1,
             last_exit_at  = $2
       RETURNING *`,
      [baseMint, now],
    );
    if (!row) throw new Error('recordOorTokenExit: no row returned');
    if (row.exit_count >= triggerCount) {
      const cooldownUntil = new Date(Date.now() + cooldownHours * 60 * 60 * 1000).toISOString();
      await this.query(
        `UPDATE oor_token_exits SET cooldown_until = $1 WHERE base_mint = $2`,
        [cooldownUntil, baseMint],
      );
      return { ...row, cooldown_until: cooldownUntil };
    }
    return row;
  }

  /** Returns the set of base token mints currently under OOR cooldown. */
  async getCooledBaseMints(now = new Date().toISOString()): Promise<Set<string>> {
    const rows = await this.query<{ base_mint: string }>(
      `SELECT base_mint FROM oor_token_exits WHERE cooldown_until > $1`,
      [now],
    );
    return new Set(rows.map((r) => r.base_mint));
  }

  async insertDecisionEpisode(data: Omit<DecisionEpisodeRow, 'id' | 'created_at'>): Promise<DecisionEpisodeRow> {
    const id = uuidv4();
    const created_at = new Date().toISOString();
    await this.query(
      `INSERT INTO decision_episodes
         (id, decision_at, action, book, signal_types, market_regime, sol_price_usd,
          portfolio_size_usd, active_position_count, target_pool_id, target_protocol,
          target_pool_name, position_size_usd, position_id, reasoning, source,
          outcome_resolved_at, outcome_net_pnl_usd, outcome_realized_apy_pct,
          outcome_days_held, outcome_exit_reason, outcome_exit_regime,
          outcome_exit_sol_price, grade, lesson_learned, created_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
      [
        id,
        data.decision_at,
        data.action,
        data.book,
        data.signal_types,
        data.market_regime,
        data.sol_price_usd,
        data.portfolio_size_usd,
        data.active_position_count,
        data.target_pool_id,
        data.target_protocol,
        data.target_pool_name,
        data.position_size_usd,
        data.position_id,
        data.reasoning,
        data.source,
        data.outcome_resolved_at,
        data.outcome_net_pnl_usd,
        data.outcome_realized_apy_pct,
        data.outcome_days_held,
        data.outcome_exit_reason,
        data.outcome_exit_regime,
        data.outcome_exit_sol_price,
        data.grade,
        data.lesson_learned,
        created_at,
      ]
    );
    return { ...data, id, created_at };
  }

  async getDecisionEpisode(id: string): Promise<DecisionEpisodeRow | undefined> {
    return this.one<DecisionEpisodeRow>(`SELECT * FROM decision_episodes WHERE id = $1`, [id]);
  }

  async getEpisodesByPositionId(positionId: string): Promise<DecisionEpisodeRow[]> {
    return this.query<DecisionEpisodeRow>(`SELECT * FROM decision_episodes WHERE position_id = $1 ORDER BY decision_at DESC`, [positionId]);
  }

  async getUngradedEpisodes(): Promise<DecisionEpisodeRow[]> {
    return this.query<DecisionEpisodeRow>(`SELECT * FROM decision_episodes WHERE grade IS NULL AND position_id IS NOT NULL ORDER BY decision_at ASC`);
  }

  async getEpisodesByGrade(grade: DecisionGrade, limit = 10): Promise<DecisionEpisodeRow[]> {
    return this.query<DecisionEpisodeRow>(`SELECT * FROM decision_episodes WHERE grade = $1 ORDER BY decision_at DESC LIMIT $2`, [grade, limit]);
  }

  async getEpisodesByProtocol(protocol: string, limit = 20): Promise<DecisionEpisodeRow[]> {
    return this.query<DecisionEpisodeRow>(
      `SELECT * FROM decision_episodes WHERE target_protocol = $1 AND grade IS NOT NULL ORDER BY decision_at DESC LIMIT $2`,
      [protocol, limit]
    );
  }

  async getEpisodesByBook(book: 'core' | 'scout', limit = 20): Promise<DecisionEpisodeRow[]> {
    return this.query<DecisionEpisodeRow>(
      `SELECT * FROM decision_episodes WHERE book = $1 AND grade IS NOT NULL ORDER BY decision_at DESC LIMIT $2`,
      [book, limit]
    );
  }

  async getEpisodesByProtocolAndBook(protocol: string, book: 'core' | 'scout', limit = 20): Promise<DecisionEpisodeRow[]> {
    return this.query<DecisionEpisodeRow>(
      `SELECT * FROM decision_episodes
       WHERE target_protocol = $1 AND book = $2 AND grade IS NOT NULL
       ORDER BY decision_at DESC LIMIT $3`,
      [protocol, book, limit]
    );
  }

  async getProtocolBookStats(protocols: string[]): Promise<ProtocolBookStatsMap> {
    const stats: ProtocolBookStatsMap = new Map();
    const uniqueProtocols = [...new Set(protocols)];
    if (uniqueProtocols.length === 0) {
      return stats;
    }

    const placeholders = uniqueProtocols.map((_, index) => `$${index + 1}`).join(', ');
    const rows = await this.query<{
      protocol: string;
      book: 'core' | 'scout';
      cnt: string;
      avg_pnl: number;
      win_rate: number;
    }>(
      `SELECT target_protocol as protocol,
              book,
              COUNT(*)::text as cnt,
              AVG(outcome_net_pnl_usd) as avg_pnl,
              SUM(CASE WHEN outcome_net_pnl_usd > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as win_rate
       FROM decision_episodes
       WHERE grade IS NOT NULL AND book IS NOT NULL AND target_protocol IN (${placeholders})
       GROUP BY target_protocol, book`,
      uniqueProtocols
    );

    for (const row of rows) {
      const existing = stats.get(row.protocol) ?? {};
      existing[row.book] = {
        protocol: row.protocol,
        book: row.book,
        count: Number(row.cnt),
        avgPnl: Number(row.avg_pnl),
        winRate: Number(row.win_rate),
      };
      stats.set(row.protocol, existing);
    }

    return stats;
  }

  async getBaseMintBookStats(baseMints: string[]): Promise<BaseMintBookStatsMap> {
    const stats: BaseMintBookStatsMap = new Map();
    const uniqueBaseMints = [...new Set(baseMints.filter((baseMint) => baseMint.length > 0))];
    if (uniqueBaseMints.length === 0) {
      return stats;
    }

    const placeholders = uniqueBaseMints.map((_, index) => `$${index + 1}`).join(', ');
    const rows = await this.query<{
      base_mint: string;
      book: 'core' | 'scout';
      cnt: string;
      avg_pnl: number;
      win_rate: number;
    }>(
      `SELECT p.base_mint as base_mint,
              de.book as book,
              COUNT(*)::text as cnt,
              AVG(de.outcome_net_pnl_usd) as avg_pnl,
              SUM(CASE WHEN de.outcome_net_pnl_usd > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as win_rate
       FROM decision_episodes de
       JOIN positions p ON p.id = de.position_id
       WHERE de.grade IS NOT NULL AND de.book IS NOT NULL AND p.base_mint IN (${placeholders})
       GROUP BY p.base_mint, de.book`,
      uniqueBaseMints
    );

    for (const row of rows) {
      const existing = stats.get(row.base_mint) ?? {};
      existing[row.book] = {
        baseMint: row.base_mint,
        book: row.book,
        count: Number(row.cnt),
        avgPnl: Number(row.avg_pnl),
        winRate: Number(row.win_rate),
      };
      stats.set(row.base_mint, existing);
    }

    return stats;
  }

  async getEpisodesByRegime(regime: string, limit = 20): Promise<DecisionEpisodeRow[]> {
    return this.query<DecisionEpisodeRow>(
      `SELECT * FROM decision_episodes WHERE market_regime = $1 AND grade IS NOT NULL ORDER BY decision_at DESC LIMIT $2`,
      [regime, limit]
    );
  }

  async updateEpisodeOutcome(
    episodeId: string,
    outcome: {
      resolvedAt: string;
      netPnlUsd: number;
      realizedApyPct: number;
      daysHeld: number;
      exitReason: string;
      exitRegime: string | null;
      exitSolPrice: number | null;
    },
    grade: DecisionGrade | null,
    lessonLearned: string | null
  ): Promise<void> {
    await this.query(
      `UPDATE decision_episodes SET
         outcome_resolved_at = $2,
         outcome_net_pnl_usd = $3,
         outcome_realized_apy_pct = $4,
         outcome_days_held = $5,
         outcome_exit_reason = $6,
         outcome_exit_regime = $7,
         outcome_exit_sol_price = $8,
         grade = $9,
         lesson_learned = $10
       WHERE id = $1`,
      [
        episodeId,
        outcome.resolvedAt,
        outcome.netPnlUsd,
        outcome.realizedApyPct,
        outcome.daysHeld,
        outcome.exitReason,
        outcome.exitRegime,
        outcome.exitSolPrice,
        grade,
        lessonLearned,
      ]
    );
  }

  async getPendingSkips(olderThan: string): Promise<SkipEpisodeRow[]> {
    return this.query<SkipEpisodeRow>(`SELECT * FROM skip_episodes WHERE grade IS NULL AND skipped_at < $1`, [olderThan]);
  }

  async updateSkipGrade(id: number | string, grade: string): Promise<void> {
    await this.query(`UPDATE skip_episodes SET grade = $2 WHERE id = $1`, [String(id), grade]);
  }

  async getEpisodeStats(): Promise<{
    total: number;
    graded: number;
    byGrade: Record<string, number>;
    byProtocol: Record<string, { count: number; avgPnl: number; winRate: number }>;
    byRegime: Record<string, { count: number; avgPnl: number }>;
    byBook: Record<string, { count: number; avgPnl: number; winRate: number }>;
  }> {
    const totalRow = await this.one<{ cnt: string }>(`SELECT COUNT(*)::text as cnt FROM decision_episodes`);
    const gradedRow = await this.one<{ cnt: string }>(`SELECT COUNT(*)::text as cnt FROM decision_episodes WHERE grade IS NOT NULL`);
    const gradeRows = await this.query<{ grade: string; cnt: string }>(
      `SELECT grade, COUNT(*)::text as cnt FROM decision_episodes WHERE grade IS NOT NULL GROUP BY grade`
    );
    const protocolRows = await this.query<{ protocol: string; cnt: string; avg_pnl: number; win_rate: number }>(
      `SELECT target_protocol as protocol, COUNT(*)::text as cnt,
              AVG(outcome_net_pnl_usd) as avg_pnl,
              SUM(CASE WHEN outcome_net_pnl_usd > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as win_rate
       FROM decision_episodes
       WHERE grade IS NOT NULL AND target_protocol IS NOT NULL
       GROUP BY target_protocol`
    );
    const regimeRows = await this.query<{ regime: string; cnt: string; avg_pnl: number }>(
      `SELECT market_regime as regime, COUNT(*)::text as cnt, AVG(outcome_net_pnl_usd) as avg_pnl
       FROM decision_episodes
       WHERE grade IS NOT NULL AND market_regime IS NOT NULL
       GROUP BY market_regime`
    );
    const bookRows = await this.query<{ book: string; cnt: string; avg_pnl: number; win_rate: number }>(
      `SELECT COALESCE(book, 'unassigned') as book, COUNT(*)::text as cnt,
              AVG(outcome_net_pnl_usd) as avg_pnl,
              SUM(CASE WHEN outcome_net_pnl_usd > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as win_rate
       FROM decision_episodes
       WHERE grade IS NOT NULL
       GROUP BY COALESCE(book, 'unassigned')`
    );

    const byGrade: Record<string, number> = {};
    for (const row of gradeRows) byGrade[row.grade] = Number(row.cnt);

    const byProtocol: Record<string, { count: number; avgPnl: number; winRate: number }> = {};
    for (const row of protocolRows) {
      byProtocol[row.protocol] = { count: Number(row.cnt), avgPnl: Number(row.avg_pnl), winRate: Number(row.win_rate) };
    }

    const byRegime: Record<string, { count: number; avgPnl: number }> = {};
    for (const row of regimeRows) {
      byRegime[row.regime] = { count: Number(row.cnt), avgPnl: Number(row.avg_pnl) };
    }

    const byBook: Record<string, { count: number; avgPnl: number; winRate: number }> = {};
    for (const row of bookRows) {
      byBook[row.book] = { count: Number(row.cnt), avgPnl: Number(row.avg_pnl), winRate: Number(row.win_rate) };
    }

    return {
      total: Number(totalRow?.cnt ?? 0),
      graded: Number(gradedRow?.cnt ?? 0),
      byGrade,
      byProtocol,
      byRegime,
      byBook,
    };
  }

  async insertSkipEpisode(data: Omit<SkipEpisodeRow, 'id' | 'created_at'>): Promise<SkipEpisodeRow> {
    const id = uuidv4();
    const created_at = new Date().toISOString();
    await this.query(
      `INSERT INTO skip_episodes
         (id, skipped_at, pool_id, protocol, pool_name, apy_at_skip, score_at_skip,
          signal_types, market_regime, skip_reason, hindsight_apy_after_48h,
          hindsight_tvl_change_usd, grade, created_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        id,
        data.skipped_at,
        data.pool_id,
        data.protocol,
        data.pool_name,
        data.apy_at_skip,
        data.score_at_skip,
        data.signal_types,
        data.market_regime,
        data.skip_reason,
        data.hindsight_apy_after_48h,
        data.hindsight_tvl_change_usd,
        data.grade,
        created_at,
      ]
    );
    return { ...data, id, created_at };
  }

  async getUnevaluatedSkips(): Promise<SkipEpisodeRow[]> {
    return this.query<SkipEpisodeRow>(
      `SELECT * FROM skip_episodes
       WHERE grade IS NULL AND skipped_at < NOW() - INTERVAL '48 hours'
       ORDER BY skipped_at ASC`
    );
  }

  async updateSkipHindsight(id: string, hindsightApy: number | null, hindsightTvlChange: number | null, grade: DecisionGrade | null): Promise<void> {
    await this.query(
      `UPDATE skip_episodes
       SET hindsight_apy_after_48h = $2, hindsight_tvl_change_usd = $3, grade = $4
       WHERE id = $1`,
      [id, hindsightApy, hindsightTvlChange, grade]
    );
  }

  async getRecentLessons(limit = 10): Promise<Array<{ lesson_learned: string; grade: string; decision_at: string; target_protocol: string | null; book: 'core' | 'scout' | null }>> {
    return this.query(
      `SELECT lesson_learned, grade, decision_at, target_protocol, book
       FROM decision_episodes
       WHERE lesson_learned IS NOT NULL AND lesson_learned != ''
       ORDER BY decision_at DESC LIMIT $1`,
      [limit]
    );
  }

  async getRecentLessonsByBook(book: 'core' | 'scout', limit = 10): Promise<Array<{ lesson_learned: string; grade: string; decision_at: string; target_protocol: string | null; book: 'core' | 'scout' | null }>> {
    return this.query(
      `SELECT lesson_learned, grade, decision_at, target_protocol, book
       FROM decision_episodes
       WHERE lesson_learned IS NOT NULL AND lesson_learned != '' AND book = $1
       ORDER BY decision_at DESC LIMIT $2`,
      [book, limit]
    );
  }
}
