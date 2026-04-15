-- OOR Token Exit Tracking
-- Tracks how many times each base token has triggered an out-of-range close.
-- After `triggerCount` exits (default 3), the token mint is put on cooldown for
-- `cooldownHours` (default 12h) — the discovery scanner skips cooled mints.
--
-- Cooldown prevents re-entry into tokens that repeatedly trigger OOR closes.

CREATE TABLE IF NOT EXISTS oor_token_exits (
  base_mint    TEXT        PRIMARY KEY,
  exit_count   INTEGER     NOT NULL DEFAULT 0,
  last_exit_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cooldown_until TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_oor_token_exits_cooldown ON oor_token_exits(cooldown_until);
