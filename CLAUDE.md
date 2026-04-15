# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev              # Run cron-scheduled agent (tsx watch)
npm run cli -- <cmd>     # CLI interface (see below)
npm test                 # Run vitest tests
npm run test:watch       # Watch mode for tests
npm run typecheck        # tsc --noEmit (strict mode)
npm run build            # Compile to dist/
```

**CLI commands:**
```bash
npm run cli -- scan
npm run cli -- suggest
npm run cli -- open --opportunity=<pool-id> --size=<usd>
npm run cli -- execute --position=<pos-id>
npm run cli -- confirm --position=<pos-id> --signature=<sig>
npm run cli -- close --position=<pos-id> --reason=manual|rebalance|circuit_breaker|apy_drop
npm run cli -- positions
npm run cli -- report
npm run cli -- backtest --days=30
```

**Run a single test file:**
```bash
npx vitest run src/scoring/engine.test.ts
```

## Architecture

**Two execution modes:**
1. **Cron agent** (`src/agent.ts`) — schedules scan (06:00 UTC), monitor (hourly), and report (07:00 UTC) jobs
2. **CLI** (`src/cli/index.ts`) — manual control of every workflow step

**Data flow:** Scanner → Scorer → DB → (CLI user actions) → State machine → Executor → Telegram reporter

**Phase 1 constraint:** The executor (`src/executor/index.ts`) is a stub — it builds and simulates unsigned transactions but **never submits** them. All positions require manual signing in Phantom and explicit `confirm` via CLI.

### Scanner (`src/scanner/`)
Fetches yield data using `Promise.allSettled()` — partial protocol failure never crashes the scan. `defillama.ts` provides the baseline for all pools; `kamino.ts`, `marginfi.ts`, `jito.ts` layer on protocol-specific SDK data. Returns `RawOpportunity[]`.

### Scoring (`src/scoring/engine.ts`)
Pure functions. Formula: `(apy×0.4) + (liquidity×0.3) + (trust×0.2) - (risk_penalty×0.1)`. Thresholds and trust scores come from `agent_config.yaml`. SUGGEST ≥ 60, WATCH ≥ 45.

### Positions (`src/positions/`)
- `db.ts` — PostgreSQL via `pg`. Core tables include `opportunities`, `positions`, `pnl_snapshots`, and `execution_log`.
- `statemachine.ts` — Enforces valid transitions: `PENDING_OPEN → ACTIVE → PENDING_REBALANCE → PENDING_CLOSE → CLOSED`. Transition to ACTIVE requires a `tx_signature`.
- `pnl.ts` — Two methods: cash flow PnL (yield − gas) and mark-to-market PnL (current value − cost basis).

### Config
`agent_config.yaml` is the runtime config (thresholds, cron schedules, protocol trust scores, position limits). Loaded and validated via Zod in `src/config/loader.ts`. Requires a `.env` file — copy from `.env.example`.

## TypeScript

Strict mode with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and `noImplicitOverride`. Module resolution is `NodeNext`. Always use indexed access with null checks when reading from arrays/records.
