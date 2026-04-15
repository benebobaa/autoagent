CLI := npm run cli --
DATABASE_URL ?= postgresql://yield_agent:yield_agent@localhost:5432/yield_agent

# ── Discovery ────────────────────────────────────────────────────────────────

scan:
	$(CLI) scan

suggest:
	$(CLI) suggest

positions:
	$(CLI) positions

report:
	$(CLI) report

# ── Position lifecycle ───────────────────────────────────────────────────────
# Usage:
#   make open POOL=<pool-id> SIZE=<usd>
#   make execute POS=<position-id>
#   make confirm POS=<position-id> SIG=<tx-signature>
#   make close POS=<position-id> REASON=manual

open:
	$(CLI) open --opportunity=$(POOL) --size=$(SIZE)

execute:
	$(CLI) execute --position=$(POS)

confirm:
	$(CLI) confirm --position=$(POS) --signature=$(SIG)

close:
	$(CLI) close --position=$(POS) --reason=$(REASON)

# ── Backtest ─────────────────────────────────────────────────────────────────
# Usage: make backtest DAYS=30

DAYS ?= 30
backtest:
	$(CLI) backtest --days=$(DAYS)

# ── Dev ──────────────────────────────────────────────────────────────────────

db-up:
	docker compose up -d

db-down:
	docker compose down

db-migrate:
	DATABASE_URL="$(DATABASE_URL)" npm run db:migrate

dev:
	npm run dev

test:
	npm test

typecheck:
	npm run typecheck

.PHONY: scan suggest positions report open execute confirm close backtest db-up db-down db-migrate dev test typecheck
