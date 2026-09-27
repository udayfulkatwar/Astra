# ASTRA — Project State

_Last updated: 2026-09-27 · maintained at every milestone (master instructions §34)._

## Current phase

**Phase 0 (architecture) and Phase 1 (foundation) complete. Phase 3 safety core complete.
Phase 2 (market data) complete except the real provider adapter**, which needs the owner's
platform choice (see _Owner inputs_). **Phase 4 calendar groundwork done** (provider port,
poller, validation, change events, event-risk view; a real provider needs the owner's choice);
news is not started. **Phase 5 groundwork done:** market-structure detection (no lookahead).
**Phase 8 started:** the position monitor (live positions, limit buffers, trailing path risk,
alerts) is done; the trade journal and backtesting are next.
Paper trading runs end to end on simulated or ingested data, with bars, a market scanner,
market structure, a quote-quality guard and event blackouts.

## Completed

| Area               | What exists                                                                                                                                                                                                     | Tests                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Architecture       | `docs/ARCHITECTURE.md` (18 sections), ADR-0001…0009                                                                                                                                                             | —                                |
| Tooling            | pnpm workspace, TS 6 strict, ESLint (type-aware), Prettier, Vitest, GitHub Actions CI with Postgres                                                                                                             | —                                |
| `@astra/core`      | `Observed<T>` (no-fabrication wrapper), modes, health, UTC/time-zone (DST-safe) utilities, sessions/trading hours, decimal math, UUIDv7, canonical JSON/hash, DATA/SIGNAL/CONTEXT schemas                       | 38                               |
| `@astra/prop-firm` | Rule-profile schema (all §13 rule families), account tracking (peaks, day-start), account state engine, worst-case `canTrade` rule engine, firm quantity headroom                                               | 51 (incl. property tests)        |
| `@astra/risk`      | Risk policy, position sizing (smallest limit wins, binding constraint reported), policy checks, account health SAFE→HALTED/UNKNOWN; position monitor + alert tracker (ADR-0012)                                 | 33 (incl. 500-run property test) |
| `@astra/safety`    | Kill switches (7 scopes, fail-closed until loaded, human-only manual clears), component health registry (silence → UNKNOWN), halt conditions                                                                    | 24                               |
| `@astra/decision`  | Context assembler (timeouts → TIMEOUT/ERROR), gate checks across 11 layers (incl. `market.session`), required-layer enforcement, decision engine with §58 explanations, persist-or-reject                       | 83 (incl. property test)         |
| `@astra/execution` | Broker adapter interface, paper broker (brackets, P&L, failure injection, persistence), execution gateway (re-validation, per-account lock, 3-level duplicate protection, confirmation polling, UNKNOWN → halt) | 22                               |
| Market data        | `@astra/market-data` (pure, isomorphic; ADR-0009): adapter port, simulation adapter, quote-quality guard, OHLC bars M1…D1 (gaps never filled), ATR(14), market snapshot                                         | 57                               |
| Market structure   | `@astra/market-structure` (pure; ADR-0010): swings with labels, BOS/CHoCH, liquidity pools and sweeps, fair value gaps — complete bars only, every item stamped with when it became known                       | 13 (incl. no-lookahead property) |
| Calendar           | `@astra/calendar` (pure; ADR-0011): provider port + poller (timeout, never overlaps), validation, currency → instrument mapping, change events, event-risk view, SIMULATED schedule; shared `assessBlackout`    | 12 + 3 (core)                    |
| `@astra/db`        | Checksum-verified SQL migrations, hash-chained append-only audit log, immutable decisions, one-approval-per-signal index, `market_bars`, repositories                                                           | 21 (real Postgres)               |
| `@astra/config`    | YAML loader, cross-reference validation, secret detection, config hash; template configs                                                                                                                        | 10                               |
| `apps/api`         | Fastify core service: role tokens, REST + SSE, in-core safety loop, startup reconciliation, restart recovery, DB-outage fail-closed start, market scanner/bars, self-contained bundle                           | 25 (real Postgres, end to end)   |
| `apps/dashboard`   | Command center: status bar, overview (§66), Trade Approval Center, market scanner, accounts, risk controls, health, live activity, audit, calendar, rules, strategies, config; in-browser demo build            | 5 + browser walkthrough          |
| Deployment         | `docker-compose.yml` (postgres, api, dashboard, n8n), Dockerfiles, nginx, `.env.example`, `docs/DEPLOYMENT.md`                                                                                                  | compose validated                |
| n8n                | Heartbeat + error-handler workflows, setup guide                                                                                                                                                                | JSON validated                   |

**Total: 403 automated tests passing.** Verified manually: production bundle boots and runs the
full paper flow over HTTP; dashboard walkthrough in headless Chromium with zero console errors;
Phase 2: production bundle with the simulation adapter builds and persists M1 bars, serves the
scanner, and reloads the bars after a SIGTERM restart.

## Phase 2 — market data (provider-agnostic part done)

Completed:

- `@astra/market-data` package (ADR-0009): `MarketDataAdapter` port, `SimulationAdapter`,
  `MarketDataService` (provider-symbol mapping, validation, ordering, per-symbol freshness,
  listeners, source-kind binding), `QuoteQualityMonitor`, `BarAggregator`,
  `computeMarketSnapshot`, ATR(14) Wilder, feed health.
- `market_bars` table (migration 0003) + `MarketBarRepository`; completed bars persisted in
  batches by the safety loop; aggregators warmed up from the database at startup.
- MARKET_DATA health from quote freshness of instruments traded by ACTIVE accounts (ONLINE /
  DEGRADED / UNKNOWN); abnormal price jumps make quotes INVALID for a cooldown (default 60 s,
  `marketData` block in `config/astra.yaml`), so the `data.quote` gate blocks trades.
- `GET /api/v1/market/scanner` and `GET /api/v1/market/bars`.
- Dashboard **Market Scanner** (price, spread, market status, active sessions, today and
  previous-day levels, change, range bar, ATR(14) H1/D1, data quality with the reason when not OK).
- Bar aggregation fast path: a quote inside the current bar period skips the time-zone window
  calculation (~22 µs per quote instead of ~150 µs).
- **In-browser demo** (`pnpm --filter @astra/dashboard build:demo`): the real engines including
  `@astra/market-data`. It pre-runs the SIMULATED price walk over 22 simulated days so bars,
  levels and ATR exist on open, and has an "Inject bad MNQ tick" button that shows the quality
  guard blocking MNQ trades for the cooldown.

Remaining:

- **Real provider adapter** for the owner's platform (LIVE quotes with provider timestamps and
  `providerSymbols`, reconnect/backoff, honest health) — needs the owner's platform choice.
- Provider history backfill (seed complete bars from the provider) so D1/H4 levels and session
  ranges are available right after a restart (today they return once a full period is observed).

## Phase 4 / 5 groundwork (done without owner input)

- **Market structure** (`GET /api/v1/market/structure`, dashboard Market Scanner card + chart):
  deterministic definitions and DEFAULT parameters in `config/astra.yaml` (`structure`); a
  property test proves analysing a prefix gives exactly the same events (no repainting). Signal
  input only — no gate check, cannot approve.
- **Economic calendar:** `CalendarService` validates and maps windows (currency via optional
  instrument `eventCurrencies`, fail-safe when unset), reports changes as system events, and
  drives CALENDAR health from freshness. `CalendarPoller` pulls a provider with a timeout;
  failures age the window into STALE (no trades). `GET /api/v1/calendar/risk` and the Economic
  Calendar page show CLEAR / BLACKOUT (until when, why) / UNKNOWN per instrument — the same
  `assessBlackout` the gate uses. With `ASTRA_SIMULATION=true` (and in the demo) a SIMULATED
  weekly schedule is polled; the demo can jump to 5 minutes before the next high-impact event.

## Phase 8 — position monitor (done)

- `monitorAccount` / `MonitorAlertTracker` in `@astra/risk`, run by the safety loop after each
  account sync; `GET /api/v1/monitor/positions`; dashboard **Position Monitor** page (alerts,
  worst-case limit buffers, positions with mark, P&L, R, stop/target distance and a stop → target
  gauge). Also in the demo.
- Marks come from fresh exit-side quotes only; the trailing intraday-equity **path risk** (run up
  to the targets, then reverse to the stops) is computed and alerted — known issue 4 is now
  monitored (the gate does not price it yet; see decisions).
- Alerts are events (WARN/CRITICAL) raised once per crossing with hysteresis; missing data never
  clears one. It warns only — no automatic closing.

## Remaining (by phase)

| Phase | Scope                                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2     | First real market-data provider adapter (owner's platform); provider history backfill for bars                                                    |
| 4     | Real economic-calendar provider adapter (owner's choice); news ingestion + classification; sentiment; flip `decision.news.required`               |
| 5     | Strategy engine with typed rule schemas on top of the structure engine; order blocks / displacement if the strategy needs them; signal generation |
| 6     | AI orchestrator (provider adapters, routing, schema-validated outputs, call log, budgets); post-trade analysis                                    |
| 7     | n8n workflows: ingestion, cycles, notifications (Telegram/Discord/email), daily/weekly reports                                                    |
| 8     | Trade journal, learning metrics, backtesting subsystem; extended paper run                                                                        |
| 9     | Shadow mode on LIVE data; decision-vs-outcome comparison                                                                                          |
| 10    | LIVE broker adapter for the owner's platform; controlled live with strict limits — **owner authorization required**                               |

## Owner inputs needed (not blocking current work)

1. **Prop firm(s) and program(s)** you trade, so their _current_ published rules can be entered as
   verified profiles (templates only exist today — no firm's rules were invented).
2. **Trading platform / broker** (e.g. MT5, cTrader, DXtrade, Match-Trader, Tradovate,
   Rithmic/ProjectX, NinjaTrader) — determines the execution and market-data adapters.
3. **Instruments** you actually trade, and your broker's contract specs for CFDs (contract size).
4. **Your strategy rules** (entries, confirmation, stops, targets, management) — Phase 5.
5. **Your personal risk limits** — review `config/risk-policies/template-conservative.yaml`.
6. **Data/AI providers and budget** — market data, economic calendar, news, AI API keys (Phase 2/4/6).
7. **Which currencies' events matter per instrument** (`eventCurrencies`, e.g. NQ → USD) — unset
   means every event blocks every instrument (safe but restrictive).
8. **Review the structure definitions** (ADR-0010: swing strength, equal-level tolerance, FVG
   minimum) against your strategy.
9. **Decisions on protection** (ADR-0012): should the gate size new trades against the trailing
   path risk (stricter), and should ASTRA ever close positions automatically (e.g. before a
   trailing breach)? Today it only warns.

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
4. Intraday trailing drawdown: the gate's worst-case checks use the current threshold. The
   position monitor now prices and alerts the run-up-then-reverse path (ADR-0012); using it in
   the gate is an owner decision (stricter sizing).
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
15. `market_bars` has no retention policy yet (M1 grows by ~1,440 rows per instrument and source
    per day).
16. After a restart the in-progress bars of every timeframe are discarded (partially observed), so
    `today`, D1/H4 ATR and session ranges return only after a full period — until a provider
    backfill exists. Feed outages while running are not detected at bar level (bars spanning an
    outage hold only what was observed; the outage itself shows as STALE / MARKET_DATA not ONLINE).
17. Bad ticks enter bars (observed data is never edited); the quality monitor flags them and blocks
    trading for the cooldown. A reopen gap larger than `maxQuoteJumpTicks` also triggers the
    cooldown (fail-closed at the open).
18. MARKET_DATA is DEGRADED — which blocks all trades while `allowDegradedComponents: false` — when
    any instrument traded by an ACTIVE account lacks a fresh quote, including instruments whose
    market is closed while another's is open.
19. Calendar windows are not persisted: after a restart the calendar is UNAVAILABLE (no trades)
    until the next poll or push. Decision records keep the calendar each decision saw.
20. The event-risk view uses the global blackout rule; strategy and firm rules can only widen it
    at decision time (the gate applies the merged rule).

## Next implementation target

Without owner input: the trade journal (per-trade record from decision to close, with MAE/MFE
and outcome vs plan), then the news-ingestion port (Phase 4). With owner input: the real market-data and calendar adapters for the chosen
providers, the owner's strategy on top of the structure engine (Phase 5), and later the
execution adapter.
