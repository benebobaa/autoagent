# Solana Yield Agent — Phase 1 MVP

A modular agent that scans real DeFi yields on Solana, scores opportunities with rule-based logic, tracks positions through a strict state machine, and proposes (but never auto-executes) transactions.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your values
```

Required environment variables:

| Variable | Description |
|---|---|
| `SOLANA_RPC_URL` | Solana RPC endpoint (Helius free tier works) |
| `AGENT_WALLET_ADDRESS` | Your wallet public key (read-only in Phase 1) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (optional — falls back to stdout) |
| `TELEGRAM_CHAT_ID` | Telegram chat ID (optional) |
| `DRY_RUN` | `true` = no simulation, just print proposed actions |
| `LOG_LEVEL` | `info` | `debug` | `warn` |
| `DATABASE_URL` | PostgreSQL connection string |

LLM provider keys are configured separately based on `agent_config.yaml`:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Required when `llm.*.provider=anthropic` |
| `OPENAI_API_KEY` | Required when `llm.*.provider=openai` |
| `DEEPSEEK_API_KEY` | Required when `llm.*.provider=deepseek` |
| `OPENROUTER_API_KEY` | Required when `llm.*.provider=openrouter` |

### 3. Configure thresholds

Edit `agent_config.yaml` to tune scoring thresholds, position sizing, cron schedules, and embedding model settings. Use `docker compose up -d` to start the local pgvector-enabled PostgreSQL instance, then run `npm run db:migrate` before starting the agent.

Example OpenRouter LLM configuration:

```yaml
llm:
  default:
    provider: openrouter
    model: anthropic/claude-4-sonnet
    temperature: 0
```

Minimal OpenRouter setup:

```bash
OPENROUTER_API_KEY=your_key
```

---

## CLI Commands

All commands run via `npm run cli -- <command> [options]`.

### `scan`
Run a full scan of all protocols and print scored opportunities.
```bash
npm run cli -- scan
```

### `suggest`
Show all SUGGEST-tier opportunities (score ≥ 60) not yet opened as positions.
```bash
npm run cli -- suggest
```

### `open`
Create a `PENDING_OPEN` position for a given opportunity.
```bash
npm run cli -- open --opportunity=<pool-id> --size=<usd>
```

### `execute`
Build and simulate the unsigned transaction for a `PENDING_OPEN` or `PENDING_CLOSE` position.
Prints the base64 transaction for manual signing in Phantom or any compatible wallet.
```bash
npm run cli -- execute --position=<position-id>
```

### `confirm`
After you've signed and broadcast the transaction manually, record it:
```bash
npm run cli -- confirm --position=<position-id> --signature=<tx-signature>
```
This transitions the position to `ACTIVE` (for opens) or `CLOSED` (for closes).

### `close`
Move an `ACTIVE` position to `PENDING_CLOSE`:
```bash
npm run cli -- close --position=<position-id> --reason=manual
```
Reasons: `manual` | `rebalance` | `circuit_breaker` | `apy_drop`

### `positions`
List all positions with current state and estimated PnL:
```bash
npm run cli -- positions
```

### `report`
Generate and send (or print) the daily Telegram report:
```bash
npm run cli -- report
```

### `backtest`
Run a historical simulation against DefiLlama data:
```bash
npm run cli -- backtest --days=30
```

---

## Running the Agent (Cron Mode)

To run the agent as a persistent process that executes on cron schedules:
```bash
npm run dev
```

Cron schedules (configured in `agent_config.yaml`):
- **06:00 UTC** — full scan
- **Every hour** — APY drop monitor
- **07:00 UTC** — Telegram daily report

---

## Manual Approval Flow

The agent **never auto-submits transactions**. Every position action requires human confirmation:

1. `scan` → discovers opportunities
2. `suggest` → shows top picks
3. `open --opportunity=<id> --size=<usd>` → creates PENDING_OPEN position
4. `execute --position=<id>` → builds unsigned tx, prints base64 + simulation
5. Sign the transaction in Phantom (or any wallet that accepts raw base64)
6. `confirm --position=<id> --signature=<sig>` → records it, transitions to ACTIVE
7. `positions` → see live PnL estimates

---

## Running Tests

```bash
npm test
```

TypeScript strict mode check:
```bash
npx tsc --noEmit
```

---

## Architecture

```
src/
├── scanner/        # Protocol data fetchers (DefiLlama, Kamino, Marginfi, Jito)
├── scoring/        # Rule-based scoring engine (pure functions, fully tested)
├── positions/      # PostgreSQL DB layer, state machine, PnL calculations
├── executor/       # Builds + simulates transactions (never submits)
├── reporter/       # Telegram bot + report formatting
├── backtest/       # Historical simulation runner
├── config/         # YAML config loader with Zod validation
├── cli/            # Commander-based CLI entry point
└── agent.ts        # Cron scheduler entry point
```

## SDK Notes

| Protocol | SDK | Notes |
|---|---|---|
| Kamino Lending | `@kamino-finance/klend-sdk` v7 | Uses `@solana/kit` RPC |
| Kamino Vaults | `@kamino-finance/kliquidity-sdk` v11 | APY from DefiLlama only in Phase 1 |
| Marginfi | `@mrgnlabs/marginfi-client-v2` v6 | Uses `@solana/web3.js` v1 Connection |
| Jito | DefiLlama only | No public APY SDK endpoint in Phase 1 |

## Phase 2 Roadmap

- Real protocol transaction instructions (Kamino deposit, Marginfi supply)
- Meteora DLMM integration
- Live wallet balance tracking
- Automated rebalance suggestions
