# CLAUDE.md — working on ASTRA

Management state: [`CEO_STATE.md`](CEO_STATE.md), [`DECISIONS.md`](DECISIONS.md), [`RESEARCH_REGISTRY.md`](RESEARCH_REGISTRY.md), [`RELEASE_EVIDENCE.md`](RELEASE_EVIDENCE.md).

Read first: `docs/WORK_LEDGER.md` (task/branch/evidence ledger and lessons), `docs/PROJECT_STATE.md` (current phase, gaps, owner inputs), `docs/ARCHITECTURE.md`,
`docs/adr/`. The owner's master instructions delegate implementation to Claude; ask only for
information only the owner has (credentials, firm rules, platform, strategy, live authorization).

## Non-negotiable rules

- Default is NO TRADE. Any non-OK input (`Observed` status) must reject, never default.
- Never fabricate data, firm rules, broker specs or strategy rules. Templates stay
  `UNVERIFIED` / `TEMPLATE`; LIVE refuses them.
- AI is CONTEXT only (can veto, never approve). Risk, sizing, rules, kill switches and execution
  permission are deterministic code.
- An entry is transmitted only after fresh deterministic revalidation and a committed DB reservation (ADR-0027); never add a permissive revalidation default.
- Never enable live trading; ADR-0008's six factors require the owner.
- Secrets only via env vars; config references env-var _names_.

## Architecture in one breath

pnpm monorepo, TypeScript 6 strict. Domain packages (`core`, `prop-firm`, `risk`, `safety`,
`decision`, `execution`, `ai`, …) are pure and expose ports; `db` implements them; `apps/api` is the
composition root; `apps/dashboard` only type-imports domain packages. Money math uses decimal.js.
All times UTC; local zones only via Luxon for rule evaluation.

## Commands

- `pnpm check` — prettier check, eslint (type-aware), tsc, vitest (all must pass before commit)
- DB tests: local Postgres `postgres://astra:astra_dev_only@localhost:5432/astra_test` or
  `TEST_DATABASE_URL`; each test file isolates itself in a throwaway schema
- `pnpm --filter @astra/api build` — self-contained bundle (needs `ASTRA_MIGRATIONS_DIR` when run from dist)

## Conventions

- New external data → wrap in `Observed<T>`; new gate check → `packages/decision/src/checks`,
  pure over `DecisionInputs` + derivations; every layer must keep ≥1 mandatory check.
- Schema changes → new numbered file in `packages/db/migrations` (never edit applied ones).
- Postgres jsonb params: use `jsonb(sql, value)`, never `${JSON.stringify(v)}::jsonb`.
- Keep `docs/PROJECT_STATE.md` current at each milestone.

## Lessons (see `docs/WORK_LEDGER.md`)

- Read the ledger before restarting work; never infer working code or passing tests from a chat claim.
- Report the exact tested SHA, test count and DB skips; retain regression tests for reproduced bugs.
- AI may veto only; never relax a safety rule to obtain a pass.
