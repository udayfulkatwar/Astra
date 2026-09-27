# ASTRA — Project State

_Last updated: 2026-09-27 · maintained at every milestone (master instructions §34)._

## Current phase

**Phase 0 (architecture) and Phase 1 (foundation) complete. Phase 3 safety core complete.**
Next: Phase 2 (market data) and Phase 4 (calendar/news) — both need owner input to pick
providers/platforms (see _Owner inputs_). Paper trading can already run end to end on
simulated or ingested data.

## Completed

| Area               | What exists                                                                                                                                                                                                     | Tests                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Architecture       | `docs/ARCHITECTURE.md` (18 sections), ADR-0001…0008                                                                                                                                                             | —                                |
| Tooling            | pnpm workspace, TS 6 strict, ESLint (type-aware), Prettier, Vitest, GitHub Actions CI with Postgres                                                                                                             | —                                |
| `@astra/core`      | `Observed<T>` (no-fabrication wrapper), modes, health, UTC/time-zone (DST-safe) utilities, decimal math, UUIDv7, canonical JSON/hash, DATA/SIGNAL/CONTEXT schemas                                               | 29                               |
| `@astra/prop-firm` | Rule-profile schema (all §13 rule families), account tracking (peaks, day-start), account state engine, worst-case `canTrade` rule engine, firm quantity headroom                                               | 51 (incl. property tests)        |
| `@astra/risk`      | Risk policy, position sizing (smallest limit wins, binding constraint reported), policy checks, account health SAFE→HALTED/UNKNOWN                                                                              | 20 (incl. 500-run property test) |
| `@astra/safety`    | Kill switches (7 scopes, fail-closed until loaded, human-only manual clears), component health registry (silence → UNKNOWN), halt conditions                                                                    | 24                               |
| `@astra/decision`  | Context assembler (timeouts → TIMEOUT/ERROR), 20 gate checks across 11 layers, required-layer enforcement, decision engine with §58 explanations, persist-or-reject                                             | 78 (incl. property test)         |
| `@astra/execution` | Broker adapter interface, paper broker (brackets, P&L, failure injection, persistence), execution gateway (re-validation, per-account lock, 3-level duplicate protection, confirmation polling, UNKNOWN → halt) | 22                               |
| `@astra/db`        | Checksum-verified SQL migrations, hash-chained append-only audit log, immutable decisions, one-approval-per-signal index, repositories                                                                          | 15 (real Postgres)               |
| `@astra/config`    | YAML loader, cross-reference validation, secret detection, config hash; template configs                                                                                                                        | 10                               |
| `apps/api`         | Fastify core service: role tokens, REST + SSE, in-core safety loop, startup reconciliation, restart recovery, DB-outage fail-closed start, self-contained bundle                                                | 15 (real Postgres, end to end)   |
| `apps/dashboard`   | Command center: status bar, overview (§66), Trade Approval Center, accounts, risk controls, health, live activity, audit, calendar, rules, strategies, config; honest placeholders                              | 5 + browser walkthrough          |
| Deployment         | `docker-compose.yml` (postgres, api, dashboard, n8n), Dockerfiles, nginx, `.env.example`, `docs/DEPLOYMENT.md`                                                                                                  | compose validated                |
| n8n                | Heartbeat + error-handler workflows, setup guide                                                                                                                                                                | JSON validated                   |

**Total: 269 automated tests passing.** Verified manually: production bundle boots and runs the
full paper flow over HTTP; dashboard walkthrough in headless Chromium with zero console errors.

## Remaining (by phase)

| Phase | Scope                                                                                                                                                           |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2     | Market-data adapter interface + first real provider; instrument sessions engine; candles/OHLC; scanner                                                          |
| 4     | Economic-calendar provider adapter; news ingestion + classification; event-risk engine; sentiment; flip `decision.news.required`                                |
| 5     | Strategy engine with typed rule schemas; market-structure detection (swings, BOS, CHoCH, liquidity); signal generation; owner's strategy                        |
| 6     | AI orchestrator (provider adapters, routing, schema-validated outputs, call log, budgets); post-trade analysis                                                  |
| 7     | n8n workflows: ingestion, cycles, notifications (Telegram/Discord/email), daily/weekly reports                                                                  |
| 8     | Position monitor events (stop/target approaching, live trailing-threshold distance), trade journal, learning metrics, backtesting subsystem; extended paper run |
| 9     | Shadow mode on LIVE data; decision-vs-outcome comparison                                                                                                        |
| 10    | LIVE broker adapter for the owner's platform; controlled live with strict limits — **owner authorization required**                                             |

## Owner inputs needed (not blocking current work)

1. **Prop firm(s) and program(s)** you trade, so their _current_ published rules can be entered as
   verified profiles (templates only exist today — no firm's rules were invented).
2. **Trading platform / broker** (e.g. MT5, cTrader, DXtrade, Match-Trader, Tradovate,
   Rithmic/ProjectX, NinjaTrader) — determines the execution and market-data adapters.
3. **Instruments** you actually trade, and your broker's contract specs for CFDs (contract size).
4. **Your strategy rules** (entries, confirmation, stops, targets, management) — Phase 5.
5. **Your personal risk limits** — review `config/risk-policies/template-conservative.yaml`.
6. **Data/AI providers and budget** — market data, economic calendar, news, AI API keys (Phase 2/4/6).

## Decisions made autonomously (summary)

TypeScript modular monolith; PostgreSQL with plain SQL migrations; decimal math for risk;
fail-closed gate over frozen snapshots; n8n orchestrates but never decides; config as versioned
YAML with verification flags; one compose topology for local and cloud; six-factor live
authorization. Details in `docs/adr/`.

## Known issues and technical debt

1. **Docker images not built here** (no Docker daemon in the build environment). Compose file is
   validated and the API bundle was verified to run without `node_modules`, but the first
   `docker compose up --build` on a real host is still unverified.
2. **n8n workflows not yet imported into a live n8n** instance; node type versions may need
   adjusting to the installed n8n version.
3. Day-start values are observed from the first snapshot after the reset unless the platform
   reports them; late observations use the conservative (higher) value.
4. Intraday trailing drawdown: worst-case checks use the current threshold. A trade that runs up
   then reverses raises the threshold during the trade — Phase 8's position monitor must watch
   live distance to the trailing threshold.
5. "No holding through news" (a position opened before a restricted window) is not modelled.
6. Cross-currency instruments are rejected (no FX conversion of tick values yet).
7. Only MARKET entries are supported; LIMIT entries are rejected by the gate.
8. Paper broker keeps all closed trades in its persisted state (unbounded growth; archive later).
9. `system_events` has no retention policy yet.
10. The API connects as the table owner, which could disable audit triggers (tampering is still
    detected by chain verification). Hardening: separate least-privilege runtime role.
11. Dashboard auth is a bearer token in session storage; cloud hardening path is OIDC + cookies.
12. Rate limiting is in-memory per instance (fine for a single instance).
13. Candidates are stored inside each decision's input snapshot (no separate `trade_candidates` table).
14. `pnpm audit` in CI is report-only.

## Next implementation target

Without owner input: Phase 2 foundations that are provider-agnostic — the market-data adapter
interface with health/freshness reporting, instrument trading-session engine (configurable
sessions per spec §56, used by a new `market.session` gate check), and OHLC aggregation; plus
the Phase 4 calendar-provider adapter interface. With owner input on the platform: the first
real market-data and (later) execution adapters.
