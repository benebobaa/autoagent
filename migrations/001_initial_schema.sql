CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  protocol TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  pool_name TEXT NOT NULL,
  apy_defillama DOUBLE PRECISION,
  apy_protocol DOUBLE PRECISION,
  apy_used DOUBLE PRECISION NOT NULL,
  data_uncertain BOOLEAN NOT NULL DEFAULT FALSE,
  tvl_usd DOUBLE PRECISION,
  score DOUBLE PRECISION NOT NULL,
  raw_data JSONB,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  protocol TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  pool_name TEXT NOT NULL,
  state TEXT NOT NULL,
  book TEXT,
  base_mint TEXT,
  size_usd DOUBLE PRECISION NOT NULL,
  entry_apy DOUBLE PRECISION NOT NULL,
  entry_price_sol DOUBLE PRECISION,
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  close_reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pnl_snapshots (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES positions(id),
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  method TEXT NOT NULL,
  yield_earned_usd DOUBLE PRECISION,
  gas_paid_usd DOUBLE PRECISION,
  cash_flow_pnl_usd DOUBLE PRECISION,
  cost_basis_usd DOUBLE PRECISION,
  current_value_usd DOUBLE PRECISION,
  mtm_pnl_usd DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS execution_log (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES positions(id),
  action TEXT NOT NULL,
  tx_base64 TEXT,
  simulation_result TEXT,
  executed BOOLEAN NOT NULL DEFAULT FALSE,
  tx_signature TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS apy_snapshots (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES positions(id),
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_apy_pct DOUBLE PRECISION NOT NULL,
  pool_tvl_usd DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS realized_pnl (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL UNIQUE REFERENCES positions(id),
  token_a_deposited DOUBLE PRECISION,
  token_b_deposited DOUBLE PRECISION,
  token_a_withdrawn DOUBLE PRECISION,
  token_b_withdrawn DOUBLE PRECISION,
  fees_claimed_usd DOUBLE PRECISION,
  il_usd DOUBLE PRECISION,
  gas_paid_usd DOUBLE PRECISION,
  net_pnl_usd DOUBLE PRECISION,
  time_weighted_capital_usd DOUBLE PRECISION,
  realized_apy_pct DOUBLE PRECISION,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS signal_queue (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  priority TEXT NOT NULL,
  payload JSONB NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  thread_id TEXT
);

CREATE TABLE IF NOT EXISTS market_snapshots (
  id TEXT PRIMARY KEY,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_approvals (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  checkpoint_id TEXT,
  interrupt_value JSONB NOT NULL,
  telegram_message_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS paper_portfolio (
  id TEXT PRIMARY KEY,
  starting_balance_usd DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dlmm_positions (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES positions(id),
  position_pubkey TEXT NOT NULL UNIQUE,
  pool_pubkey TEXT NOT NULL,
  lower_bin_id INTEGER NOT NULL,
  upper_bin_id INTEGER NOT NULL,
  active_bin_at_deploy INTEGER NOT NULL,
  strategy TEXT NOT NULL,
  bins_below INTEGER NOT NULL,
  bins_above INTEGER NOT NULL,
  amount_x_deployed DOUBLE PRECISION,
  amount_y_deployed DOUBLE PRECISION,
  initial_value_usd DOUBLE PRECISION,
  bin_step INTEGER,
  volatility_at_deploy DOUBLE PRECISION,
  fee_tvl_ratio_at_deploy DOUBLE PRECISION,
  organic_score_at_deploy DOUBLE PRECISION,
  base_mint TEXT,
  peak_pnl_pct DOUBLE PRECISION,
  last_pnl_pct DOUBLE PRECISION,
  trailing_armed_at TIMESTAMPTZ,
  last_monitored_at TIMESTAMPTZ,
  deployed_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS fee_claims (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES positions(id),
  claimed_usd DOUBLE PRECISION NOT NULL,
  tx_signature TEXT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pool_cooldowns (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  cooldown_until TIMESTAMPTZ NOT NULL,
  source_position_id TEXT REFERENCES positions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oor_events (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES positions(id),
  detected_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  active_bin INTEGER,
  lower_bin INTEGER,
  upper_bin INTEGER
);

CREATE TABLE IF NOT EXISTS decision_episodes (
  id TEXT PRIMARY KEY,
  decision_at TIMESTAMPTZ NOT NULL,
  action TEXT NOT NULL,
  book TEXT,
  signal_types TEXT NOT NULL,
  market_regime TEXT,
  sol_price_usd DOUBLE PRECISION,
  portfolio_size_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  active_position_count INTEGER NOT NULL DEFAULT 0,
  target_pool_id TEXT,
  target_protocol TEXT,
  target_pool_name TEXT,
  position_size_usd DOUBLE PRECISION,
  position_id TEXT,
  reasoning TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'live',
  outcome_resolved_at TIMESTAMPTZ,
  outcome_net_pnl_usd DOUBLE PRECISION,
  outcome_realized_apy_pct DOUBLE PRECISION,
  outcome_days_held DOUBLE PRECISION,
  outcome_exit_reason TEXT,
  outcome_exit_regime TEXT,
  outcome_exit_sol_price DOUBLE PRECISION,
  grade TEXT,
  lesson_learned TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skip_episodes (
  id TEXT PRIMARY KEY,
  skipped_at TIMESTAMPTZ NOT NULL,
  pool_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  pool_name TEXT NOT NULL,
  apy_at_skip DOUBLE PRECISION NOT NULL,
  score_at_skip DOUBLE PRECISION NOT NULL,
  signal_types TEXT NOT NULL,
  market_regime TEXT,
  skip_reason TEXT NOT NULL DEFAULT '',
  hindsight_apy_after_48h DOUBLE PRECISION,
  hindsight_tvl_change_usd DOUBLE PRECISION,
  grade TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_positions_state ON positions(state);
CREATE INDEX IF NOT EXISTS idx_positions_book ON positions(book);
CREATE INDEX IF NOT EXISTS idx_positions_base_mint ON positions(base_mint);
CREATE INDEX IF NOT EXISTS idx_opportunities_scanned ON opportunities(scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_pnl_position ON pnl_snapshots(position_id);
CREATE INDEX IF NOT EXISTS idx_apy_snapshots_position ON apy_snapshots(position_id, snapshot_at);
CREATE INDEX IF NOT EXISTS idx_signal_queue_priority_processed ON signal_queue(priority, processed_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_at ON market_snapshots(snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_position ON decision_episodes(position_id);
CREATE INDEX IF NOT EXISTS idx_episodes_grade ON decision_episodes(grade);
CREATE INDEX IF NOT EXISTS idx_episodes_protocol ON decision_episodes(target_protocol);
CREATE INDEX IF NOT EXISTS idx_episodes_regime ON decision_episodes(market_regime);
CREATE INDEX IF NOT EXISTS idx_episodes_action ON decision_episodes(action);
CREATE INDEX IF NOT EXISTS idx_episodes_book ON decision_episodes(book);
CREATE INDEX IF NOT EXISTS idx_skip_pool ON skip_episodes(pool_id);
CREATE INDEX IF NOT EXISTS idx_skip_grade ON skip_episodes(grade);
