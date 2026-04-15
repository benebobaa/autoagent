ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS tier INTEGER,
  ADD COLUMN IF NOT EXISTS deployment_mode TEXT,
  ADD COLUMN IF NOT EXISTS position_style TEXT;

ALTER TABLE execution_log
  ADD COLUMN IF NOT EXISTS exit_reason TEXT;

CREATE TABLE IF NOT EXISTS portfolio_value_history (
  id TEXT PRIMARY KEY,
  total_value_usd DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tier_allocation_snapshots (
  id TEXT PRIMARY KEY,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tier INTEGER NOT NULL,
  target_pct DOUBLE PRECISION NOT NULL,
  current_pct DOUBLE PRECISION NOT NULL,
  deployed_usd DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_positions_tier ON positions(tier);
CREATE INDEX IF NOT EXISTS idx_positions_deployment_mode ON positions(deployment_mode);
CREATE INDEX IF NOT EXISTS idx_execution_log_exit_reason ON execution_log(exit_reason);
CREATE INDEX IF NOT EXISTS idx_portfolio_value_history_created_at ON portfolio_value_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tier_allocation_snapshots_at ON tier_allocation_snapshots(snapshot_at DESC, tier);
