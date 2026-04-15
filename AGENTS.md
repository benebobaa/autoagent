# AGENTS.md — Solana Yield Agent

## Scope

- This file is for coding agents working in this repository.
- No extra editor-agent instruction files were found in `.cursorrules`, `.cursor/rules/`, or `.github/copilot-instructions.md`.
- The root `AGENTS.md` is the repo-specific guidance source.

## Runtime

- Node.js `>=20`.
- TypeScript ESM project with `"type": "module"`.
- Compiler mode is `NodeNext` for both `module` and `moduleResolution`.
- Output goes to `dist/`; source lives under `src/`.

## Build / Lint / Test

```bash
# Install
npm install

# Dev entrypoints
npm run dev
npm run cli -- <command>

# Build and static checks
npm run build
npm run typecheck

# Tests
npm test
npm run test:watch
npx vitest run src/scoring/engine.test.ts
npx vitest run src/scoring/engine.test.ts -t "returns 20 at exactly 5% APY (floor)"
```

- There is no repo-level `npm run lint` script today.
- There is no checked-in top-level ESLint, Prettier, or Biome config.
- Default validation for code changes is `npm run typecheck` plus the most relevant Vitest coverage.
- If you touch broad shared behavior, run `npm test` before finishing.

## Makefile

- `Makefile` wraps the common CLI flows: `scan`, `suggest`, `positions`, `report`, `open`, `execute`, `confirm`, `close`, and `backtest`.
- It also provides `make dev`, `make test`, and `make typecheck`.

## CLI Commands

```bash
npm run cli -- scan
npm run cli -- suggest
npm run cli -- open --opportunity=<pool-id> --size=<usd>
npm run cli -- execute --position=<position-id>
npm run cli -- confirm --position=<position-id> --signature=<sig>
npm run cli -- close --position=<position-id> --reason=manual|rebalance|circuit_breaker|apy_drop
npm run cli -- positions
npm run cli -- report
npm run cli -- backtest --days=30
npm run cli -- seed-episodes --days=30
npm run cli -- lessons --limit=10
```

## Repo Layout

- `src/agent.ts` is the cron-scheduled agent entrypoint; `src/cli/index.ts` is the Commander CLI.
- `src/config/loader.ts` handles YAML plus env loading and Zod validation.
- Core domains live under `src/scanner/`, `src/scoring/`, `src/signals/`, `src/positions/`, `src/executor/`, `src/reporter/`, `src/graph/`, `src/rag/`, `src/embeddings/`, `src/utils/`, and `src/backtest/`.

## Imports and Modules

- Always use `.js` extensions in local TypeScript imports.
- Prefer `import type` for type-only imports.
- Follow existing ESM patterns; do not switch files back to CommonJS.
- Keep imports explicit and relative; avoid adding index barrels unless the repo already uses one nearby.

```ts
import { logger } from '../utils/logger.js';
import type { AgentConfig } from '../config/loader.js';
```

## Formatting

- Preserve the existing style: 2-space indentation, semicolons, and single quotes.
- Keep multiline objects and argument lists trailing-comma friendly when the surrounding file already does that.
- Larger files often use banner comments like `// ---------------------------------------------------------------------------`; keep them if you are editing those files.
- Prefer small, direct functions over introducing extra helpers without a clear reuse case.
- There is no enforced formatter config, so match the surrounding file closely.

## TypeScript Rules

- `strict` mode is enabled.
- `exactOptionalPropertyTypes` is enabled: distinguish omitted values from `undefined` intentionally.
- `noUncheckedIndexedAccess` is enabled: guard array and record lookups.
- `noImplicitOverride` is enabled: subclasses must use `override`.
- Avoid `any`; if an SDK forces it, keep the unsafe cast local and documented.
- Export inferred types from Zod schemas with `z.infer<typeof Schema>`.

## Naming Conventions

- Files: `kebab-case` or established names like `index.ts`.
- Functions and variables: `camelCase`.
- Types, interfaces, classes: `PascalCase`.
- Constants and env vars: `SCREAMING_SNAKE_CASE`.
- Database columns and YAML config keys: `snake_case`.
- TypeScript objects that mirror DB rows often keep `snake_case`; domain objects often use `camelCase`.

## Config and Validation

- Runtime config comes from `agent_config.yaml` plus env vars loaded in `src/config/loader.ts`.
- Keep secrets in env vars, never in YAML.
- Use Zod for schema validation.
- For external API payloads, prefer `.safeParse()` and log `error.issues` on failure.
- For startup-critical config, fail fast is acceptable; `loadConfig()` currently ends with `AgentConfigSchema.parse(...)`.

## Database Conventions

- Use PostgreSQL directly via `pg`; there is no ORM.
- Schema changes live under `migrations/` and can be applied with `npm run db:migrate`.
- Use parameterized queries for every write and read.
- Use `uuid` v4 for IDs.
- Use ISO 8601 timestamps from `new Date().toISOString()` at the application boundary.
- Use explicit transactions for related multi-statement writes.

## Error Handling and Logging

- Use the shared `pino` logger from `src/utils/logger.ts`.
- Log with context objects: `logger.info({ poolId, apy }, 'message')`.
- Scanner and ingestion code should prefer degraded-mode behavior over crashing the whole run.
- `src/scanner/index.ts` uses `Promise.allSettled()` so one protocol failure does not kill the scan.
- Lower-level utilities and executor code may throw; catch at higher boundaries when you can add context or recover.
- Do not silently swallow failures.

## Testing Conventions

- Tests live next to code as `src/**/*.test.ts`.
- The project uses Vitest with `describe` and `it`.
- Prefer deterministic unit tests around pure logic in scoring, signals, positions, and executor helpers.
- Keep fixtures minimal and explicit; many tests build narrow inline objects rather than large shared factories.
- When changing behavior, update the nearest colocated test file first.

## Domain Rules

- The Phase 1 executor builds and simulates unsigned transactions but never auto-submits them.
- Manual signing plus `confirm` is required to move positions forward.
- Valid position states are `PENDING_OPEN`, `ACTIVE`, `PENDING_REBALANCE`, `PENDING_CLOSE`, and `CLOSED`.
- `ACTIVE` transitions require a transaction signature.
- The scanner treats partial data as better than no data; keep protocol integrations resilient.

## Working Safely

- Never commit `.env` or other secrets.
- Copy `.env.example` to `.env` for local setup.
- `DRY_RUN=false` enables real simulation paths; it still does not mean unattended transaction submission.
- If you add a new protocol, wire it through scanner fetching, scoring/config trust settings, and relevant tests.
