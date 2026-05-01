# Solana Yield Agent

An AI-driven Solana DeFi yield agent that scans protocol opportunities, scores risk-adjusted yield, tracks positions through a strict state machine, and coordinates analyst/risk/trader/reporter agents through LangGraph.

The agent supports manual CLI workflows, paper trading, dry-run execution, Telegram reporting, RAG decision memory, and Meteora DLMM discovery/management. It is designed to propose, simulate, and record actions safely; unattended real transaction submission should only be enabled after validating the execution path and wallet configuration.

---

## What It Does

- Scans Solana yield sources from DefiLlama and protocol-specific integrations.
- Scores opportunities using APY, TVL, protocol trust, data uncertainty, market regime, diversification, and DLMM-specific risk signals.
- Detects events such as APY drift, liquidity collapse, volume spikes, out-of-range DLMM positions, portfolio drawdown, and better pool opportunities.
- Runs a LangGraph investment-team workflow with analyst, risk manager, trader, and reporter agents.
- Stores decisions, outcomes, grades, and lessons in PostgreSQL/pgvector for RAG-based memory.
- Tracks positions with explicit states: `PENDING_OPEN`, `ACTIVE`, `PENDING_REBALANCE`, `PENDING_CLOSE`, and `CLOSED`.
- Builds execution plans and logs simulations before state transitions are confirmed.
- Sends portfolio and action summaries through Telegram when configured.

---

## Setup

### 1. Install Dependencies

```bash
npm install
```

Node.js `>=20` is required. The project is TypeScript ESM with `module` and `moduleResolution` set to `NodeNext`.

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your local values
```

Core environment variables:

| Variable | Description |
|---|---|
| `SOLANA_RPC_URL` | Solana RPC endpoint. Helius or another reliable provider is recommended. |
| `DATABASE_URL` | PostgreSQL connection string. The local Docker setup includes pgvector. |
| `AGENT_WALLET_ADDRESS` | Wallet public key used for balance checks and execution planning. |
| `DRY_RUN` | `true` disables real submission paths and records dry-run execution plans. |
| `PAPER_TRADING` | `true` enables virtual portfolio mode. Also forces dry-run behavior. |
| `PAPER_STARTING_BALANCE_USD` | Starting virtual capital for paper mode. |
| `TOTAL_CAPITAL_USD` | Capital assumption for live planning when needed. |
| `LOG_LEVEL` | `trace`, `debug`, `info`, `warn`, or `error`. |
| `TELEGRAM_BOT_TOKEN` | Optional Telegram bot token for reports and approvals. |
| `TELEGRAM_CHAT_ID` | Optional Telegram chat ID. |
| `BIRDEYE_API_KEY` | Optional, used by some token/discovery research paths. |

LLM and embedding keys are selected by `agent_config.yaml`:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Required when `llm.*.provider=anthropic`. |
| `OPENAI_API_KEY` | Required when `llm.*.provider=openai`; also used by embeddings unless `EMBEDDING_API_KEY` is set. |
| `DEEPSEEK_API_KEY` | Required when `llm.*.provider=deepseek`. |
| `OPENROUTER_API_KEY` | Required when `llm.*.provider=openrouter`. |
| `OPENROUTER_BASE_URL` | Optional OpenRouter-compatible base URL override. |
| `OPENROUTER_SITE_URL` | Optional OpenRouter attribution field. |
| `OPENROUTER_SITE_NAME` | Optional OpenRouter attribution field. |
| `MIMO_API_KEY` | Required when `llm.*.provider=mimo`. |
| `MIMO_BASE_URL` | Optional MiMo OpenAI-compatible base URL. Defaults to `https://api.xiaomimimo.com/v1`. |
| `EMBEDDING_API_KEY` | Optional separate key for embeddings. |

### 3. Start PostgreSQL And Run Migrations

```bash
docker compose up -d
npm run db:migrate
```

The migrations create core position tables, signal queues, paper portfolio state, decision episodes, DLMM metadata, cooldown memory, and `rag_documents` with pgvector support.

### 4. Configure Runtime Behavior

Edit `agent_config.yaml` to tune:

- enabled protocols and trust scores
- scoring thresholds
- position size and concentration limits
- paper allocator behavior
- signal thresholds
- LangGraph LLM providers and per-agent overrides
- Meteora DLMM discovery and management settings
- active risk tiers

Default LLM configuration currently uses DeepSeek reasoning:

```yaml
llm:
  default:
    provider: deepseek
    model: deepseek-reasoner
    temperature: 1
```

Example MiMo per-agent override:

```yaml
llm:
  default:
    provider: deepseek
    model: deepseek-reasoner
    temperature: 1
  overrides:
    reporter:
      provider: mimo
      model: mimo-v2.5
      temperature: 0.3
    analyst:
      provider: mimo
      model: mimo-v2.5-pro
      temperature: 0.7
```

Minimal MiMo environment:

```bash
MIMO_API_KEY=your_key
MIMO_BASE_URL=https://api.xiaomimimo.com/v1
```

OpenAI embeddings are still used for RAG by default:

```yaml
rag:
  embedding_provider: openai
  embedding_model: text-embedding-3-small
```

---

## Running The Agent

### Event-Driven Agent Runtime

```bash
npm run dev
```

This starts `src/agent.ts`, which initializes:

- PostgreSQL access
- Solana RPC clients
- Telegram reporter and approval bridge when configured
- OpenAI-compatible embeddings and RAG store
- selected LLM provider
- LangGraph investment team
- signal polling, detection, queueing, dispatch, and DLMM monitoring
- health endpoints

The runtime is event-driven rather than a simple cron-only scheduler. Timing is controlled by `agent_config.yaml` fields such as `polling`, `dispatch`, `reporting`, and Meteora management intervals.

### Health Endpoints

The agent exposes lightweight health endpoints when the runtime starts:

| Endpoint | Meaning |
|---|---|
| `/live` | Process liveness. |
| `/ready` | Readiness based on polling freshness. |
| `/health` | Backward-compatible readiness-style endpoint. |

---

## CLI Commands

All commands run through:

```bash
npm run cli -- <command> [options]
```

### Scan Opportunities

```bash
npm run cli -- scan
```

Runs protocol scanners, scores opportunities, persists them, and prints the top results.

### Show Suggestions

```bash
npm run cli -- suggest
```

Prints current `SUGGEST`-tier opportunities from a fresh scan.

### Open A Position

```bash
npm run cli -- open --opportunity=<pool-id-or-opportunity-id> --size=<usd> --book=core
```

Creates a `PENDING_OPEN` position after validating size, max open positions, duplicate exposure, cooldowns, and concentration limits. `--book` may be `core` or `scout`.

### Build An Execution Plan

```bash
npm run cli -- execute --position=<position-id>
```

Builds and records the execution plan for a `PENDING_OPEN` or `PENDING_CLOSE` position. In dry-run/paper mode this records a dry-run plan. In live mode, protocol support and wallet configuration determine whether real simulation/submission paths are available.

### Confirm Execution

```bash
npm run cli -- confirm --position=<position-id> --signature=<tx-signature>
```

Records the human-supplied transaction signature and transitions `PENDING_OPEN -> ACTIVE` or `PENDING_CLOSE -> CLOSED`.

### Close A Position

```bash
npm run cli -- close --position=<position-id> --reason=manual
```

Moves an `ACTIVE` position to `PENDING_CLOSE`.

Common reasons: `manual`, `rebalance`, `circuit_breaker`, `apy_drop`.

### List Positions

```bash
npm run cli -- positions
```

Lists all positions with book, protocol, state, size, entry APY, and estimated cash-flow PnL.

### Generate Report

```bash
npm run cli -- report
```

Runs a scan, computes active-position PnL summaries, and sends or prints the daily report.

### Backtest

```bash
npm run cli -- backtest --days=30
```

Runs a historical simulation against DefiLlama-derived data.

### Seed Learning Episodes

```bash
npm run cli -- seed-episodes --days=30
```

Runs the backtest and ingests synthetic decision episodes into the RAG memory store.

### View Lessons

```bash
npm run cli -- lessons --limit=10
```

Prints recent graded lessons learned from stored decision episodes.

---

## Safety Model

The system separates decisioning from execution:

1. Scanners and signals discover opportunities or risks.
2. Scoring and risk checks filter candidates.
3. The allocator and/or LangGraph agents produce position intents.
4. Positions enter explicit pending states before execution.
5. Execution plans are logged before confirmation.
6. State transitions require valid paths through `PositionStateMachine`.

Important constraints:

- `PENDING_OPEN -> ACTIVE` requires a transaction signature.
- `PENDING_CLOSE -> CLOSED` is confirmed through the same execution log/state path.
- `PAPER_TRADING=true` initializes a virtual portfolio and forces dry-run-style behavior.
- `DRY_RUN=true` prevents real submission paths even when execution builders exist.
- Scanner failures degrade gracefully with `Promise.allSettled()`; one protocol failure should not stop the whole scan.
- Live active DLMM execution should be treated cautiously and validated on small amounts before relying on it.

---

## Architecture

```text
src/
├── agent.ts          # Event-driven runtime: config, DB, RAG, LLM, graph, signals, health
├── cli/              # Commander CLI entry point
├── config/           # YAML/env loader, risk tiers, portfolio config
├── scanner/          # DefiLlama, Kamino, Marginfi, Jito, Meteora, discovery scanners
├── scoring/          # Opportunity scoring, correlation groups, IL/risk helpers
├── signals/          # Poller, detector, queue, dispatcher, supervised signal loop
├── graph/            # LangGraph supervisor and analyst/risk/trader/reporter agents
├── portfolio/        # Capital planning, allocation, live/paper capital helpers
├── positions/        # PostgreSQL layer, state machine, PnL, DLMM sync/monitor/rebalance
├── executor/         # Jito, Meteora, Jupiter/wallet, execution plan builders
├── reporter/         # Telegram transport and report formatting
├── rag/              # Decision logging, outcome tracking, grading, retrieval, ingestion
├── embeddings/       # Embedding model adapter
├── storage/          # PostgreSQL pool helpers
├── utils/            # Logging, health server, price utilities
└── backtest/         # Historical simulation runner
```

### Data Flow

1. `DataPoller` runs `runScan()` and stores a market snapshot.
2. `detectSignals()` compares market snapshots and active positions.
3. `SignalQueue` persists deduplicated signals.
4. `SignalDispatcher` batches signals by priority.
5. Capital planning creates deterministic open/close/claim intents.
6. LangGraph routes work between analyst, risk, trader, and reporter agents.
7. Trader tools create or transition positions and build execution plans.
8. Outcomes and lessons are persisted for RAG retrieval.
9. Telegram reports summarize portfolio state and decisions.

---

## Protocol Notes

| Protocol | Source / SDK | Current Role |
|---|---|---|
| DefiLlama | `https://yields.llama.fi` | Baseline yield and TVL data. |
| Kamino Lending | `@kamino-finance/klend-sdk` | Optional scanner path; currently disabled in aggressive DLMM config. |
| Kamino Vaults | `@kamino-finance/kliquidity-sdk` and DefiLlama | Optional yield source. |
| Marginfi | `@mrgnlabs/marginfi-client-v2` | Optional scanner path; currently disabled in aggressive DLMM config. |
| Jito | SPL Stake Pool / DefiLlama | Safe SOL staking baseline; Jito execution helpers exist. |
| Meteora DLMM | `@meteora-ag/dlmm`, Meteora APIs | Main active discovery/management focus. |
| Jupiter | Jupiter APIs | Swap helper paths after DLMM closes. |

---

## Testing And Validation

Run the full test suite:

```bash
npm test
```

Run TypeScript strict checks:

```bash
npm run typecheck
```

Run a targeted test file:

```bash
npx vitest run src/scoring/engine.test.ts
```

Useful local test DB commands:

```bash
npm run test:db:up
npm run test:isolated
npm run test:db:down
```

There is no repo-level lint script today. For code changes, run `npm run typecheck` plus the most relevant Vitest tests. Run `npm test` for broad behavior changes.

---

## Development Notes

- Keep secrets in `.env`, never in `agent_config.yaml` or committed files.
- Use `.js` extensions in local TypeScript imports.
- Tests live next to source as `src/**/*.test.ts`.
- Database schema changes belong in `migrations/` and should be applied with `npm run db:migrate`.
- Prefer parameterized SQL through the existing `Database` layer.
- Keep protocol integrations resilient: partial data is better than crashing the scan.
- Start new LLM providers as per-agent overrides, usually `reporter` or `analyst`, before using them for `risk` or `supervisor`.
