# Allocation And Telemetry Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add deterministic paper-capital deployment, usable decision/outcome telemetry, pool cooldown memory, a lightweight management loop, and correct Docker health semantics.

**Architecture:** Keep the existing LangGraph flow for analysis/reporting, but move paper-capital deployment into deterministic code paths. Add a small pure allocator module for core/scout selection, persist cooldown memory in SQLite, link decision episodes to positions at creation time, and expose separate liveness/readiness HTTP endpoints so Docker stops flagging false negatives.

**Tech Stack:** TypeScript, Node HTTP server, better-sqlite3, Vitest, LangGraph, existing SQLite/RAG abstractions.

---

### Task 1: Health Endpoints And Docker Probe

**Files:**
- Modify: `src/utils/health.ts`
- Modify: `docker-compose.yml`
- Test: `src/utils/health.test.ts`

**Step 1: Write the failing test**

Create `src/utils/health.test.ts` covering:
- `GET /live` returns `200` when the process is up, even if `lastTickTime` is `0`
- `GET /ready` returns `503` when the poller is stale
- `GET /health` remains backward-compatible and matches readiness semantics

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/health.test.ts`
Expected: FAIL because `/live` and `/ready` do not exist yet.

**Step 3: Write minimal implementation**

Update `src/utils/health.ts` to:
- factor readiness calculation into a small helper
- expose `/live`, `/ready`, and `/health`
- keep `/health` as the readiness-style endpoint for compatibility

Update `docker-compose.yml` to:
- probe `http://127.0.0.1:3000/live`
- stop relying on `localhost` IPv6 resolution inside the container

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/health.test.ts`
Expected: PASS.

### Task 2: Deterministic Core/Scout Allocator

**Files:**
- Create: `src/portfolio/allocator.ts`
- Test: `src/portfolio/allocator.test.ts`
- Modify: `src/config/loader.ts`
- Modify: `agent_config.yaml`

**Step 1: Write the failing test**

Create `src/portfolio/allocator.test.ts` covering:
- core-book allocation opens only `SUGGEST` opportunities first
- scout-book allocation is used only when utilization is below the configured threshold and no `SUGGEST` candidates exist
- scout-book allocation ignores pools on cooldown and pools already held
- allocator respects `min_position_usd`, `max_position_usd`, open-position count, and available paper cash

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/portfolio/allocator.test.ts`
Expected: FAIL because allocator code/config do not exist yet.

**Step 3: Write minimal implementation**

Add `src/portfolio/allocator.ts` as a pure module that:
- accepts scored opportunities, active positions, available cash, config, and cooldown data
- returns deterministic open intents for `core` and `scout` books
- keeps scout behavior paper-only via config

Extend config in `src/config/loader.ts` and `agent_config.yaml` with a small `allocator` block, including:
- `enabled`
- `target_utilization_pct`
- `scout_enabled_paper`
- `scout_min_score`
- `scout_max_positions`
- `scout_position_usd`
- `cooldown_hours_after_bad_exit`

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/portfolio/allocator.test.ts`
Expected: PASS.

### Task 3: Pool Cooldowns And Episode Linking

**Files:**
- Modify: `src/positions/db.ts`
- Modify: `src/positions/statemachine.ts`
- Modify: `src/graph/tools/executor-tools.ts`
- Modify: `src/agent.ts`
- Modify: `src/cli/index.ts`
- Test: `src/positions/db.test.ts`
- Test: `src/graph/tools/executor-tools.test.ts`

**Step 1: Write the failing tests**

Create tests for:
- cooldown rows can be inserted/read/expired in `src/positions/db.test.ts`
- `validateNewPosition(...)` rejects pools with active cooldowns
- `create_position(...)` creates a position-linked decision episode or updates the latest matching unlinked open episode
- CLI `confirm` close path triggers outcome tracking instead of bypassing it

**Step 2: Run tests to verify they fail**

Run:
- `npx vitest run src/positions/db.test.ts`
- `npx vitest run src/graph/tools/executor-tools.test.ts`

Expected: FAIL because cooldown persistence and linking behavior do not exist yet.

**Step 3: Write minimal implementation**

Update `src/positions/db.ts` to add a `pool_cooldowns` table plus read/write helpers.

Update `src/positions/statemachine.ts` so `validateNewPosition(...)` blocks cooled-down pools.

Update `src/graph/tools/executor-tools.ts` and `src/agent.ts` to:
- link open decisions to `position_id` and `position_size_usd`
- avoid leaving all new episodes unlinked

Update close flows (`src/graph/tools/executor-tools.ts` and `src/cli/index.ts`) to:
- call outcome tracking on close
- record cooldowns after bad exits such as `apy_drop`, `fee_yield_low`, `oor_timeout`, `pumped_past_range`, and `stop_loss`

**Step 4: Run tests to verify they pass**

Run:
- `npx vitest run src/positions/db.test.ts`
- `npx vitest run src/graph/tools/executor-tools.test.ts`

Expected: PASS.

### Task 4: Paper Allocation Execution Path

**Files:**
- Modify: `src/agent.ts`
- Modify: `src/signals/poller.ts`
- Modify: `src/graph/agents/heartbeat.ts`
- Modify: `src/graph/supervisor.ts`
- Modify: `src/graph/state.ts`
- Test: `src/agent-allocation.test.ts`

**Step 1: Write the failing test**

Create `src/agent-allocation.test.ts` covering:
- when paper cash is idle and `SUGGEST` opportunities exist, deterministic allocation opens positions without relying on LLM wording
- when no `SUGGEST` opportunities exist and utilization is below target, the paper-only scout sleeve opens capped `WATCH` positions
- no duplicate pool opens occur

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent-allocation.test.ts`
Expected: FAIL because deterministic allocation execution is not wired.

**Step 3: Write minimal implementation**

Wire a deterministic paper allocation pass into the runtime path so it can:
- compute cash/utilization from the paper portfolio and active positions
- scan current opportunities and invoke the allocator
- create positions and build execution plans directly in code for paper mode
- record linked episodes for the resulting opens

Keep the LLM graph for narrative analysis/reporting rather than first-pass capital deployment.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent-allocation.test.ts`
Expected: PASS.

### Task 5: Lightweight DLMM Management Loop

**Files:**
- Modify: `src/positions/dlmm-monitor.ts`
- Modify: `src/agent.ts`
- Modify: `src/config/loader.ts`
- Modify: `agent_config.yaml`
- Test: `src/positions/dlmm-monitor.test.ts`

**Step 1: Write the failing test**

Create `src/positions/dlmm-monitor.test.ts` covering:
- monitor decisions for stop-loss, take-profit, and cooldown-worthy exits
- loop skips work safely when no wallet or no DLMM positions exist

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/positions/dlmm-monitor.test.ts`
Expected: FAIL because tests do not exist yet and the runtime loop is not wired.

**Step 3: Write minimal implementation**

Keep `monitorDlmmPositions(...)` as the rules engine and add a lightweight runtime loop in `src/agent.ts` that:
- runs on a short interval from config
- only activates when wallet/DLMM prerequisites exist
- logs and acts on close/claim decisions through existing execution helpers
- degrades cleanly instead of crashing the agent

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/positions/dlmm-monitor.test.ts`
Expected: PASS.

### Task 6: Verification

**Files:**
- Modify as needed based on test results

**Step 1: Run targeted suite**

Run:
- `npx vitest run src/utils/health.test.ts src/portfolio/allocator.test.ts src/positions/db.test.ts src/graph/tools/executor-tools.test.ts src/agent-allocation.test.ts src/positions/dlmm-monitor.test.ts`

Expected: PASS.

**Step 2: Run static verification**

Run: `npm run typecheck`
Expected: PASS.

**Step 3: Run broader regression coverage if shared paths changed materially**

Run:
- `npx vitest run src/signals/detector.test.ts`
- `npx vitest run src/scoring/engine.test.ts`

Expected: PASS.
