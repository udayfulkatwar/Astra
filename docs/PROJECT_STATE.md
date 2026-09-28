# ASTRA — Project State

_Last updated: 2026-09-28 · maintained at every milestone (master instructions §34)._

## Current phase

**Phase 0 (architecture) and Phase 1 (foundation) complete. Phase 3 safety core complete.
Phase 2 (market data) complete except the real provider adapter**, which needs the owner's
platform choice (see _Owner inputs_). **Phase 4 done except real providers:** economic
calendar (provider port, poller, validation, change events, event-risk view) and **news
intelligence** (provider port, rules classifier, news risk in the gate, provider sentiment) —
real calendar and news providers need the owner's choice. **Phase 5 groundwork done:** market-structure detection (no lookahead).
**Phase 6 done except the owner's key and budget:** the AI analysis layer (orchestrator,
budgets, call log, Claude adapter with refusal fallback, a veto-only gate input, post-trade
reviews) — real model calls need an Anthropic API key in the environment.
**Phase 8 in progress:** position monitor, automatic protective closing (owner-authorised), the
trade journal, **backtesting** and **learning metrics** are done; the gate prices the
trailing-drawdown path and the losing-streak limit is daily (owner decisions). An extended paper
run remains.
Paper trading runs end to end on simulated or ingested data, with bars, a market scanner,
market structure, a quote-quality guard and event blackouts.

## Completed

| Area               | What exists                                                                                                                                                                                                                                  | Tests                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Architecture       | `docs/ARCHITECTURE.md` (18 sections), ADR-0001…0009                                                                                                                                                                                          | —                                           |
| Tooling            | pnpm workspace, TS 6 strict, ESLint (type-aware), Prettier, Vitest, GitHub Actions CI with Postgres                                                                                                                                          | —                                           |
| `@astra/core`      | `Observed<T>` (no-fabrication wrapper), modes, health, UTC/time-zone (DST-safe) utilities, sessions/trading hours, decimal math, UUIDv7, canonical JSON/hash, DATA/SIGNAL/CONTEXT schemas                                                    | 38                                          |
| `@astra/prop-firm` | Rule-profile schema (all §13 rule families), account tracking (peaks, day-start), account state engine, worst-case `canTrade` rule engine, firm quantity headroom                                                                            | 51 (incl. property tests)                   |
| `@astra/risk`      | Risk policy, position sizing (smallest limit wins, binding constraint reported), policy checks, account health SAFE→HALTED/UNKNOWN; position monitor + alert tracker (ADR-0012)                                                              | 33 (incl. 500-run property test)            |
| `@astra/safety`    | Kill switches (7 scopes, fail-closed until loaded, human-only manual clears), component health registry (silence → UNKNOWN), halt conditions                                                                                                 | 24                                          |
| `@astra/decision`  | Context assembler (timeouts → TIMEOUT/ERROR), gate checks across 11 layers (incl. `market.session`), required-layer enforcement, decision engine with §58 explanations, persist-or-reject                                                    | 83 (incl. property test)                    |
| `@astra/execution` | Broker adapter interface, paper broker (brackets, P&L, failure injection, persistence), execution gateway (re-validation, per-account lock, 3-level duplicate protection, confirmation polling, UNKNOWN → halt)                              | 22                                          |
| Market data        | `@astra/market-data` (pure, isomorphic; ADR-0009): adapter port, simulation adapter, quote-quality guard, OHLC bars M1…D1 (gaps never filled), ATR(14), market snapshot                                                                      | 57                                          |
| Market structure   | `@astra/market-structure` (pure; ADR-0010): swings with labels, BOS/CHoCH, liquidity pools and sweeps, fair value gaps — complete bars only, every item stamped with when it became known                                                    | 13 (incl. no-lookahead property)            |
| Learning metrics   | `@astra/learning` (pure; ADR-0018): performance by 11 dimensions with 95 % ranges and small-sample flags, R drawdown, streaks, execution quality, observations (never applied); per-trade context in the journal                             | 5 + 3 (context) + API                       |
| Backtesting        | `@astra/backtest` (pure; ADR-0016): M1 replay through the real gate, sizing, prop-firm rules, protection and journal; next-open pessimistic fills; resampler; TEMPLATE strategy; seeded SIMULATED bars                                       | 21 (incl. no-lookahead property) + DB + API |
| Trade journal      | `@astra/journal` (pure; ADR-0015): excursion tracker (observed prices only), plan-vs-actual entries (slippage, costs, R, MFE/MAE), statistics; append-only `trade_journal` table                                                             | 7 + DB + API                                |
| AI analysis layer  | `@astra/ai` (isomorphic core; ADR-0020): provider port, config routing, orchestrator (kill switch, worst-case daily budget, timeout, schema validation, call log), TRADE_ANALYSIS + POST_TRADE_REVIEW, SIMULATED stand-in, Claude adapter    | 16 + DB + API                               |
| News intelligence  | `@astra/news` (pure; ADR-0019): provider port + poller, per-item validation, de-duplication, rules classifier (13 categories, impact, instruments), news risk per instrument, provider sentiment summary, SIMULATED feed; `news_items` table | 11 + DB + API                               |
| Calendar           | `@astra/calendar` (pure; ADR-0011): provider port + poller (timeout, never overlaps), validation, currency → instrument mapping, change events, event-risk view, SIMULATED schedule; shared `assessBlackout`                                 | 12 + 3 (core)                               |
| `@astra/db`        | Checksum-verified SQL migrations, hash-chained append-only audit log, immutable decisions, one-approval-per-signal index, `market_bars`, repositories                                                                                        | 21 (real Postgres)                          |
| `@astra/config`    | YAML loader, cross-reference validation, secret detection, config hash; template configs                                                                                                                                                     | 10                                          |
| `apps/api`         | Fastify core service: role tokens, REST + SSE, in-core safety loop, startup reconciliation, restart recovery, DB-outage fail-closed start, market scanner/bars, self-contained bundle                                                        | 25 (real Postgres, end to end)              |
| `apps/dashboard`   | Command center: status bar, overview (§66), Trade Approval Center, market scanner, accounts, risk controls, health, live activity, audit, calendar, rules, strategies, config; in-browser demo build                                         | 5 + browser walkthrough                     |
| Deployment         | `docker-compose.yml` (postgres, api, dashboard, n8n), Dockerfiles, nginx, `.env.example`, `docs/DEPLOYMENT.md`                                                                                                                               | compose validated                           |
| n8n                | Heartbeat + error-handler workflows, setup guide                                                                                                                                                                                             | JSON validated                              |

**Total: 517 automated tests passing.** Verified manually: production bundle boots and runs the
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

## News intelligence (done, ADR-0019)

- The gate now **requires** a fresh news-risk assessment (`decision.news.required: true`):
  HIGH-impact news for an instrument blocks new trades on it for 30 min (MEDIUM → ELEVATED,
  shown as context for 15 min); a feed silent for 15 min is STALE → no new trades.
- Headlines are classified by deterministic, explainable rules (category, impact, affected
  instruments via currencies, keywords and provider tags; fail-safe when relevance is unknown).
  Impact only ever rounds up. Sentiment is the provider's only — never guessed.
- `POST /api/v1/news/items` (n8n push, MANUAL), `GET /api/v1/news`, `GET /api/v1/news/context`;
  items stored and restored after a restart; HIGH-impact items raise warnings. Dashboard **News
  Intelligence** page; demo "Breaking news" button; backtests take an explicit news choice.

## AI analysis layer (done, ADR-0020)

- AI is CONTEXT: it can veto a trade, never approve one, and never sets size, limits or risk.
  A strategy opts in with `requiresAiAnalysis: true`; then the deterministic checks run first,
  the model is asked only when they all pass, and the gate decides on freshly assembled data
  plus the stored analysis (CONFLICTS, confidence < 0.6 or event risk HIGH → no trade).
- The brief holds only observed data (signal, structure, recent bars, news, calendar), each
  section with its status — never balances or sizes. Malformed/truncated output → INVALID, never
  repaired; refusals and blocked calls → UNAVAILABLE; timeouts → TIMEOUT.
- Deterministic cost control: daily call and cost limits (DEFAULTS: 200 calls, $5), each call
  checked at its worst-case cost; AI kill switch; every call (sent or blocked) logged with
  tokens, cost and latency in `ai_model_calls`; analyses keep the exact brief the model saw.
- Claude adapter: `claude-opus-5`, structured output, prompt-cached instructions, **server-side
  refusal fallback on by default** (`fallbacks: "default"`), `refusal` / `max_tokens` handled.
  The key is read only from the env var named in config (`ANTHROPIC_API_KEY`).
- Post-trade reviews: GOOD/POOR process × WIN/LOSS outcome (outcome from the journal); suggested
  changes stored as PROPOSED for a human, never applied. On demand, or automatic when
  `ai.postTradeReview.auto` is set (off).
- In simulation mode (and the demo) a clearly-labelled SIMULATED stand-in (fixed rules, not an
  AI model) runs the same path; SHADOW/LIVE refuse its output. Template strategy
  `paper-ai-test` exercises the veto. Dashboard **AI Model Monitor** page.

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

## Owner decisions implemented (2026-09-27 / 28)

- **The losing-streak limit is daily** (ADR-0017, 2026-09-28): after `maxConsecutiveLosses`
  losses in a row, new trades stop for the rest of that trading day; the count starts fresh at
  the next reset (core, demo and backtests).

- **The gate prices the trailing intraday-equity path** (ADR-0013): while the threshold is
  unlocked a new trade must survive running to its target and reversing to its stop — rule
  check, sizing cap `trailing-drawdown-path`, survival check, monitor share one implementation.
- **ASTRA may close positions by itself** (ADR-0014, `protection` in `config/astra.yaml`):
  hard limit 90 % used at the current mark → close all + ACCOUNT kill switch; no stop for 10 s →
  close it; 2 min before the firm's flat time / weekly close (or held through) → close all.
  Never under an EXECUTION kill switch, never in SHADOW; retried 3×, then a human; every action
  audited and CRITICAL. Demo: "Simulate a big loss".

## Trade journal (done)

- One append-only entry per closed trade (ADR-0015), recorded by the account sync:
  plan vs actual (entry/exit slippage), costs from the instrument's commission, net P&L, R,
  MFE/MAE from observed quotes (PARTIAL when observation began late), exit reason, duration.
- `GET /api/v1/journal`, `GET /api/v1/journal/summary` (overall and by strategy / instrument /
  exit reason); dashboard **Trade Journal** page; also in the demo.

## Backtesting (done)

- `runBacktest` replays M1 bars (stored recordings from one source, or seeded SIMULATED bars)
  through the same gate (mode BACKTEST inside the simulator only), sizing, prop-firm rules,
  tracking, position monitor, automatic protection and journal (ADR-0016). No lookahead: a replay
  cut at any bar matches the full replay up to the cut (property test).
- Fills: next bar's open, ask/bid + slippage; stop assumed first when a bar hits both; gapped stops
  at the open; targets never better; expired approvals dropped; commission from the spec.
- Every result states its label (SIMULATED → "engine test, not evidence of performance"),
  assumptions and warnings, what the gate blocked and why, protective actions, the first
  prop-firm breach, trades (journal entries) and a downsampled equity curve with max drawdown.
- `POST/GET /api/v1/backtests` (runs stored append-only in `backtest_runs`, migration 0005; one
  at a time, yields to the safety loop; never touches accounts, orders, kill switches or mode);
  dashboard **Backtesting** page; also in the demo. A month of M1 bars replays in about 2 s.
- The only strategy is a clearly-marked TEMPLATE (break of structure) to exercise the engine.

## Learning metrics (done)

- Every journal entry now records its context: the strategy's setup label, timeframe, and
  whether a high-impact event for the instrument fell on that trading day or while the trade
  was open — from a calendar that covers the period, otherwise UNKNOWN (ADR-0018).
- `GET /api/v1/learning` (journal with mode filter, or any backtest run; chosen time zone):
  overall expectancy with a 95 % range, win rate, profit factor, Sharpe-like ratio, R and money
  drawdown, losing streaks; eleven breakdowns; execution quality; observations only when both
  sides have ≥ 30 trades, with a multiple-comparisons caution. Dashboard **Learning Metrics**
  page; also in the demo. Nothing is ever applied automatically.

## Remaining (by phase)

| Phase | Scope                                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2     | First real market-data provider adapter (owner's platform); provider history backfill for bars                                                    |
| 4     | Real economic-calendar and news provider adapters (owner's choice); news-driven strategies and §57 actions (reduce size / close / halt)           |
| 5     | Strategy engine with typed rule schemas on top of the structure engine; order blocks / displacement if the strategy needs them; signal generation |
| 6     | Done (ADR-0020). Owner: API key + budget; optional second provider adapter; AI news classification / sentiment if wanted                          |
| 7     | n8n workflows: ingestion, cycles, notifications (Telegram/Discord/email), daily/weekly reports                                                    |
| 8     | Extended paper run; backtests on real recorded / provider history                                                                                 |
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
6. **Data/AI providers and budget** — market data, economic calendar, news (Phase 2/4); for AI,
   an Anthropic API key set as `ANTHROPIC_API_KEY` in the server environment, and your daily AI
   budget (`ai.budget` in `config/astra.yaml`, DEFAULTS $5 / 200 calls). Verify `ai.prices`.
7. **Which of your strategies should require AI analysis** (`requiresAiAnalysis`) — AI can only
   veto; with it required, no key / no budget / a bad answer means no trade.
8. **Which currencies' events matter per instrument** (`eventCurrencies`, e.g. NQ → USD) — unset
   means every event blocks every instrument (safe but restrictive).
9. **Review the structure definitions** (ADR-0010: swing strength, equal-level tolerance, FVG
   minimum) against your strategy.
10. **Protection levels** (ADR-0013/0014, decided: both enabled) — review the thresholds in
    `config/astra.yaml` (`protection`, `monitors.positions`) against your firm and style.

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
4. Intraday trailing drawdown: resolved — the gate, sizing and monitor price the
   run-up-then-reverse path (ADR-0013). Fast gaps between two safety-loop cycles (2 s) can still
   move past a protection level before the automatic close.
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
21. When a calendar event's currency matches none of the configured instruments'
    `eventCurrencies`, the ingested event keeps an empty instrument list, which means "affects
    every instrument" — safe (over-blocking), but wrong once currencies are configured.
22. Backtests know only M1 OHLC: the path inside a bar is unknown (stop assumed first), and there
    is no historical news, AI or real calendar yet; queueing and partial fills are not modelled.
23. News classification is keyword-based (rules-v1): some headlines will be misclassified; impact
    only rounds up, so errors lean towards blocking. Paper trading without simulation now needs a
    news source (provider, or n8n pushing at least every 15 minutes).
24. `news_items` has no retention policy yet (the in-memory window is 48 h).
25. AI: the budget reservation estimates input tokens as characters / 3 (pessimistic); list
    prices in `ai.prices` are unverified DEFAULTS. A timed-out call is charged at its worst case.
    The Claude adapter is tested offline (injected fetch) — no real model call has been made from
    this environment. `ai_model_calls` has no retention policy yet.
26. The AI brief uses the signal's timeframe, or M5 when the signal gives none.

## Next implementation target

Without owner input: n8n workflows for news/calendar ingestion, cycles and notifications
(Phase 7). With owner input: a first real AI analysis run with your API key and budget; the real market-data and calendar adapters for the chosen
providers, the owner's strategy on top of the structure engine (Phase 5), and later the
execution adapter.
