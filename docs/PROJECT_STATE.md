# ASTRA — Project State

_Last updated: 2026-10-05 (Stage 1 accepted; Stage 2 P001 audit; P002 preparation) · maintained at every milestone (master instructions §34)._

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
**Phase 7 done except the owner's sources and channels:** n8n workflows (heartbeat, error
handler, news and calendar ingestion, signal webhook, alerts, daily / weekly reports, Notify)
generated from tested code and run in a real n8n 2.40.7.
**Phase 8 in progress:** position monitor, automatic protective closing (owner-authorised), the
trade journal, **backtesting** and **learning metrics** are done; the gate prices the
trailing-drawdown path and the losing-streak limit is daily (owner decisions). **Research on
genuine history is done** for the owner's LSFVG v1.0 (HistData 2010–2019): **no edge**. Neither
model passes the protocol that was committed before the result, so nothing is selected for
trading (`docs/research/RESULTS-2026-09-29.md`). An extended paper run on a live feed remains.
Paper trading runs end to end on simulated or ingested data, with bars, a market scanner,
market structure, a quote-quality guard and event blackouts.
**Free live charts (ADR-0026):** with `ASTRA_FEEDS=yahoo`, ASTRA streams real prices 24/7 from
Yahoo's public stream, with no account and no key. It loads the last 5 days of 1-minute history
and measures each symbol's delay. The dashboard **Charts** page draws interactive candles
(TradingView Lightweight Charts). These are prices only: they never count as a tradable quote,
so the gate still says NO TRADE until the platform's quotes arrive.

## Completed

| Area                | What exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Tests                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Architecture        | `docs/ARCHITECTURE.md` (18 sections), ADR-0001…0009                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                           |
| Tooling             | pnpm workspace, TS 6 strict, ESLint (type-aware), Prettier, Vitest, GitHub Actions CI with Postgres                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                           |
| `@astra/core`       | `Observed<T>` (no-fabrication wrapper), modes, health, UTC/time-zone (DST-safe) utilities, sessions/trading hours, decimal math, UUIDv7, canonical JSON/hash, DATA/SIGNAL/CONTEXT schemas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 38                                          |
| `@astra/prop-firm`  | Rule-profile schema (all §13 rule families), account tracking (peaks, day-start), account state engine, worst-case `canTrade` rule engine, firm quantity headroom                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 51 (incl. property tests)                   |
| `@astra/risk`       | Risk policy, position sizing (smallest limit wins, binding constraint reported), policy checks, account health SAFE→HALTED/UNKNOWN; position monitor + alert tracker (ADR-0012)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 33 (incl. 500-run property test)            |
| `@astra/safety`     | Kill switches (7 scopes, fail-closed until loaded, human-only manual clears), component health registry (silence → UNKNOWN), halt conditions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 24                                          |
| `@astra/decision`   | Context assembler (timeouts → TIMEOUT/ERROR), gate checks across 11 layers (incl. `market.session`), required-layer enforcement, decision engine with §58 explanations, persist-or-reject                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 83 (incl. property test)                    |
| `@astra/execution`  | Broker adapter interface, paper broker (brackets, P&L, failure injection, persistence), execution gateway (re-validation, per-account lock, 3-level duplicate protection, confirmation polling, UNKNOWN → halt)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 22                                          |
| Market data         | `@astra/market-data` (pure, isomorphic; ADR-0009): adapter port, simulation adapter, quote-quality guard, OHLC bars M1…D1 (gaps never filled), ATR(14), market snapshot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 57                                          |
| Market structure    | `@astra/market-structure` (pure; ADR-0010): swings with labels, BOS/CHoCH, liquidity pools and sweeps, fair value gaps — complete bars only, every item stamped with when it became known                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 13 (incl. no-lookahead property)            |
| Learning metrics    | `@astra/learning` (pure; ADR-0018): performance by 11 dimensions with 95 % ranges and small-sample flags, R drawdown, streaks, execution quality, observations (never applied); per-trade context in the journal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 5 + 3 (context) + API                       |
| Backtesting         | `@astra/backtest` (pure; ADR-0016): M1 replay through the real gate, sizing, prop-firm rules, protection and journal; next-open pessimistic fills; resampler; TEMPLATE strategy; seeded SIMULATED bars                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 21 (incl. no-lookahead property) + DB + API |
| Trade journal       | `@astra/journal` (pure; ADR-0015): excursion tracker (observed prices only), plan-vs-actual entries (slippage, costs, R, MFE/MAE), statistics; append-only `trade_journal` table                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 7 + DB + API                                |
| AI analysis layer   | `@astra/ai` (isomorphic core; ADR-0020): provider port, config routing, orchestrator (kill switch, worst-case daily budget, timeout, schema validation, call log), TRADE_ANALYSIS + POST_TRADE_REVIEW, SIMULATED stand-in, Claude adapter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 16 + DB + API                               |
| News intelligence   | `@astra/news` (pure; ADR-0019): provider port + poller, per-item validation, de-duplication, rules classifier (13 categories, impact, instruments), news risk per instrument, provider sentiment summary, SIMULATED feed; `news_items` table                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 11 + DB + API                               |
| Calendar            | `@astra/calendar` (pure; ADR-0011): provider port + poller (timeout, never overlaps), validation, currency → instrument mapping, change events, event-risk view, SIMULATED schedule; shared `assessBlackout`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 12 + 3 (core)                               |
| `@astra/db`         | Checksum-verified SQL migrations, hash-chained append-only audit log, immutable decisions, one-approval-per-signal index, `market_bars`, repositories                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 21 (real Postgres)                          |
| `@astra/config`     | YAML loader, cross-reference validation, secret detection, config hash; template configs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 10                                          |
| `apps/api`          | Fastify core service: role tokens, REST + SSE, in-core safety loop, startup reconciliation, restart recovery, DB-outage fail-closed start, market scanner/bars, self-contained bundle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 25 (real Postgres, end to end)              |
| `apps/dashboard`    | Command center: status bar, overview (§66), Trade Approval Center, market scanner, accounts, risk controls, health, live activity, audit, calendar, rules, strategies, config; in-browser demo build                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 5 + browser walkthrough                     |
| Deployment          | `docker-compose.yml` (postgres, api, dashboard, n8n), Dockerfiles, nginx, `.env.example`, `docs/DEPLOYMENT.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | compose validated                           |
| FX valuation        | Account-currency valuation (ADR-0022): USD/JPY's yen tick value converted with a live USDJPY quote in the gate, server, paper broker and backtest; no rate → no trade. FX templates EURUSD / GBPUSD / USDJPY (UNVERIFIED) and a `paper-fx` account                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 12                                          |
| LIMIT entries       | ADR-0023: resting LIMIT orders with expiry — gate checks the whole window (news, calendar, close, firm flat time), exposure counted before the fill, paper broker and backtest fills (pessimistic, missed entries reported), cancel on kill switch / news / stale feeds, operator cancel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 19                                          |
| LSFVG v1.0 strategy | `@astra/strategy-lsfvg` (pure; ADR-0024): the owner's Liquidity Structure FVG strategy — H1 bias, M15 sweep / displacement / CHoCH-BOS / FVG, LIMIT at the FVG midpoint, Model A (2R) and B (liquidity target), §26 decision records; owner risk rules as the gate's `strategy.limits`; server runner + demo runner; configs `lsfvg-a` / `lsfvg-b` on `paper-fx` / `paper-fx-b`                                                                                                                                                                                                                                                                                                                                                                                                                                            | 17 + 5 (gate) + 2 API                       |
| Research backtests  | `@astra/research` (ADR-0025, `docs/RESEARCH.md`): Dukascopy / HistData / MT5 / generic CSV import (gzip too) with explicit time zones, validation and bid/ask pairing; multi-pair replay through the LSFVG engine, the real gate and protection — a strategy study by default (no template prop-firm stop), `--prop-firm` for one evaluation attempt; pessimistic LIMIT fills; §23 metrics before/after costs, OOS split, walk-forward, Monte Carlo, robustness, sensitivity; INSUFFICIENT DATA below 30 trades; CLI → report.md / study.json. **Standalone Python kit** (`packages/research/kit/`) for the owner to run anywhere, checked trade-for-trade against ASTRA (parity test incl. dense scripted setups), with selftest and M1→M5 compaction; resumable, time-boxed Dukascopy downloader; wrong-instrument guard | 30                                          |
| Free chart feed     | ADR-0026: `YahooStreamAdapter` (protobuf decoder checked on a genuine yfinance message; backoff, connect timeout, error-without-close handling, silent-socket reconnect, per-symbol delay), `yahooBackfill` + `rollUp` (complete candles only), price-only path `ingestPrice` / `seedBars`, `ASTRA_FEEDS`, `GET /api/v1/market/feeds` and `/prices`, dashboard **Charts** page                                                                                                                                                                                                                                                                                                                                                                                                                                             | 27 + 4 API + 2 UI                           |
| n8n                 | `@astra/n8n` (ADR-0021): 8 workflows generated from typed, tested code-node logic; drift and secret checks; `/api/v1/reports`; tested in n8n 2.40.7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | JSON validated                              |

**Total: 716 automated tests passing** (82 files, PostgreSQL 16, no skips; I001 combined result — earlier per-branch counts 659 / 674 / 697 / 663 were separate runs, not cumulative). Verified manually: production bundle boots and runs the
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

- **Free chart feed (ADR-0026, 2026-09-29):** Yahoo's public stream and 1-minute history for
  EURUSD, GBPUSD, USDJPY, NQ and MNQ, turned on with `ASTRA_FEEDS=yahoo` (the Compose default).
  - Prices only, through a separate path that builds bars but never a quote.
  - Feed state and per-symbol delay: `GET /api/v1/market/feeds` and the dashboard **Charts**
    page (candles M1…D1, source and delay badges).
  - XAUUSD is not mapped: Yahoo has no spot-gold symbol, and GC=F is futures.
  - Checked here against the real server with outbound access blocked: it reported
    `HTTP 403` / `ERROR … reconnect attempt 6` honestly. This check found a Node WebSocket
    behaviour (`error` without `close`) that is now handled.

Remaining:

- **Real provider adapter** for the owner's platform (LIVE quotes with provider timestamps and
  `providerSymbols`, reconnect/backoff, honest health) — needs the owner's platform choice.
  Only such quotes can make MARKET_DATA ONLINE for trading.
- Measure the free feed's real delay on a host with internet access (the Charts page shows it).

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

## n8n workflows (done, ADR-0021)

- Eight workflows in `automation/n8n/workflows/`, generated from typed, unit-tested code:
  heartbeat, error handler, news ingestion (RSS / Atom), calendar ingestion, signal webhook
  (e.g. TradingView → gate), alerts, daily / weekly reports, and a Notify sub-workflow
  (Telegram / Discord / email).
- ASTRA computes; n8n delivers: `GET /api/v1/reports` builds the report from ASTRA's records;
  alerts poll `GET /api/v1/events?afterSeq=&order=asc` so none are skipped.
- Fail-closed: unconfigured sources, a failed fetch or a malformed document stop the run, so
  ASTRA's feed goes stale and no new trades are approved. No notification channel → a visible
  error, never silence.
- Verified in a real n8n 2.40.7 against the API: all imported and published; heartbeat, news
  and calendar pushes, webhook (403 without the secret, gate decision with it), alert and report
  emails, error workflow. Setup: `automation/n8n/README.md` (publish Notify and Error handler too).

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
  Accepted windows are persisted and restored on startup with their original `asOf` (Task 002).

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

## Demo / paper / live boundaries (honest status, I001)

- **Demo** (in-browser simulation, `build:demo`): works; simulated data only.
- **Paper**: runs end to end on simulated or ingested data. No tradable broker quote feed exists
  (Yahoo prices are chart-only), so the gate says NO TRADE on real data until the owner's platform
  adapter exists. Extended paper run on a live feed has NOT been done.
- **Live**: not enabled and not ready. No broker adapter, no live authorization (ADR-0008's six
  factors need the owner). **No approved profitable strategy exists in this repository.**
  LSFVG v1.0 showed no edge on HistData 2010-2019 (historical result preserved, unchanged).
- **Unverified external research:** the Claude project chat "Project access granted"
  (611bf957-bb1b-486e-ac01-69e2ef0f3a8f) mentions a separate `/home/claude/astra` Cowork prototype and
  Gold / Nasdaq / US30 backtest and payout claims, plus unfinished strategy code. Its files and
  results are NOT in this repository and NOT reproduced. Treat as unverified research awaiting
  reproducible artifacts (data, code, commit); do not cite as proven or live-ready.
  The founder dropped the US30-only constraint; no instrument is selected.

## Integration I001 (2026-10-04)

Combined reviewed heads onto the default branch in one integration branch (no conflicts):
Task 002 calendar persistence (`babf911`), F001+F002 frontend (`0c0aff9`), R001 validation
(`d39129a`). Tracking: `docs/WORK_LEDGER.md`.

## Stage 1 — execution safety (ADR-0027; accepted chain, integrated candidate under review)

The S001 and S001-R3 candidates FAILED safety review and were never accepted; their features
(pre-submit validation, durable account-wide reservations, evidence-after-release quarantine,
migrations 0010–0012) are inherited and were repaired by the subsequently ACCEPTED chain, each
accepted by independent review and exact-head CI (`docs/WORK_LEDGER.md`, `RELEASE_EVIDENCE.md`):
**M001** conservative tombstone upgrade (0013, 0014) → **F003** synchronous final entry freshness
guard → **R004** single-owner PAPER crash/restart safety (0015) → **S002** queued risk-reduction
permissions re-read inside the lock. Together: an entry is
transmitted only after fresh deterministic revalidation, a committed DB reservation and a final
synchronous guard; paper state has one owner and an unclean session blocks its accounts; queued
cancels/protective closes re-prove permission and the pinned adapter binding at the broker call.

**Stage 1 integrated software gate PASSED for the PAPER execution-safety scope** (accepted head
`b9c3b890`, tested code `dcb4f692`, CI 37240369181 / job 111547727471, 100 files / 945 tests, 0 skips;
not live readiness). Standing limitations: no audited clearing path for quarantines or unresolved
completed-day conflicts; unclean paper sessions block accounts and recovery does not re-apply lost
mutations; PAPER only — a real broker adapter must supply position↔order linkage (blocks LIVE);
no distributed takeover. **Live trading is DISABLED; no strategy has a verified edge.**

## Stage 2 — firm/platform selection (IN_PROGRESS; P001 audit under CEO review)

`docs/ledger/P001_PLATFORM_AUDIT.md` separates CEO primary reads (P, 2026-10-04 UTC / 2026-10-05 IST),
unverified Claude leads (L) and third-party pages (never facts). Current P facts: FundingPips 2 Step
Flex targets 10%/8%, static 12% max loss, VPN/VPS forbidden, own-EA automation needs firm-assessed
proof (external own-software/API acceptance unresolved), evaluation permits overnight/weekend while
the Master closes unless Swing; Lucid LucidFlex 25K end-of-day trailing (MLL $1,000, floor $25,100),
optional DLL, automation permitted with the API/cloud route unresolved; CME MYM/MNQ point values.
The founder's named programs are targets, not confirmed accounts; no profile is VERIFIED, no
strategy is promoted, and rule mapping to the profile schema is a gap needing proof. R004 fences are
PAPER-only. The minimum founder unknown is the exact current account (or none) with its options.

**Founder decision 2026-10-05 (addendum; P001 facts above unchanged):** first account firm FundingPips,
phase EVALUATION. The platform is NOT specified and must not be assumed; program, size, evaluation
step, feed and options are unconfirmed (the earlier 10K 2-Step Flex is a historical intention, not an
account). P002 preparation (Markdown only, candidate for CEO review): `docs/ledger/P002_REQUIREMENTS.md`.
Platform-specific API contract/adapter/fake-server conformance stays BLOCKED until the platform is
known; phase rules cannot be applied until the exact program/step/terms are known. No profile is
VERIFIED.

## Remaining (by phase)

| Phase | Scope                                                                                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2     | First real market-data provider adapter (owner's platform) for tradable quotes. Free chart feed with history backfill: done (ADR-0026)                    |
| 4     | Real economic-calendar and news provider adapters (owner's choice); news-driven strategies and §57 actions (reduce size / close / halt)                   |
| 5     | Strategy engine with typed rule schemas on top of the structure engine; order blocks / displacement if the strategy needs them; signal generation         |
| 6     | Done (ADR-0020). Owner: API key + budget; optional second provider adapter; AI news classification / sentiment if wanted                                  |
| 7     | n8n workflows: ingestion, cycles, notifications (Telegram/Discord/email), daily/weekly reports                                                            |
| 8     | Extended paper run on a live feed. Backtests on real history: done (HistData 2010–2019; LSFVG v1.0 shows no edge — `docs/research/RESULTS-2026-09-29.md`) |
| 9     | Shadow mode on LIVE data; decision-vs-outcome comparison                                                                                                  |
| 10    | LIVE broker adapter for the owner's platform; controlled live with strict limits — **owner authorization required**                                       |

## Owner inputs needed (not blocking current work)

1. **Prop firm(s) and program(s)** you trade, so their _current_ published rules can be entered as
   verified profiles (templates only exist today — no firm's rules were invented).
2. **Trading platform / broker** (e.g. MT5, cTrader, DXtrade, Match-Trader, Tradovate,
   Rithmic/ProjectX, NinjaTrader) — determines the execution and market-data adapters.
3. **Instruments** you actually trade, and your broker's contract specs for CFDs (contract size).
   For the FX strategy: your broker's lot size, digits, commission per lot, typical spread and
   trading-day end — the EURUSD / GBPUSD / USDJPY files assume standard values (UNVERIFIED).
4. **Your strategy rules** (entries, confirmation, stops, targets, management) — Phase 5.
   `docs/STRATEGY_PROMPT.md` is a prompt for drafting them with another model in ASTRA's format.
5. **Your personal risk limits** — review `config/risk-policies/template-conservative.yaml`.
6. **Data/AI providers and budget** — charts now have a free feed (ADR-0026). Tradable quotes
   come from your platform (item 2). Still needed: economic calendar and news sources (Phase 4).
   To test the free feed from this cloud environment, allow `query2.finance.yahoo.com` and
   `streamer.finance.yahoo.com` in its network settings; on your own machine it needs nothing.
   For AI,
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
11. **n8n sources and channels** — your RSS / Atom news feeds, your calendar source, and the
    notification channels (Telegram chat, Discord webhook or email) for alerts and reports.
12. **Confirm the LSFVG defaults** (ADR-0024, `packages/strategy-lsfvg/src/params.ts`): the
    displacement must break structure within 6 M15 candles of the sweep; the H1 bias turns
    NEUTRAL when the structure breaks after the last swing; Model B targets the nearest level
    giving ≥ 2R (not only the nearest level); one sweep taking several levels is recorded
    against the strongest (previous day > Asian > equal > swing, then the deepest).
13. **Historical data for research** — 2010–2019 is done (HistData, via a public GitHub
    repository; no edge found). Still wanted: EUR/USD, GBP/USD, USD/JPY 2020–2026 (M1 or M5,
    bid/ask if possible), the untouched confirmation period. Either run the standalone kit yourself (`packages/research/kit/README.md`) and
    send back its results folder, or allow `datafeed.dukascopy.com` in the environment's network
    settings (the setting was not active in two fresh sessions on 2026-09-29: HTTP 403). First
    attempt (2026-09-29, another AI model): the kit's selftest passed. The uploaded files were
    other instruments, two index-like series (about 24,000 and 44,000) and XAU, and the
    downloader was stopped after 3 minutes. The downloader is now resumable and time-boxed.

## Decisions made autonomously (summary)

TypeScript modular monolith; PostgreSQL with plain SQL migrations; decimal math for risk;
fail-closed gate over frozen snapshots; n8n orchestrates but never decides; config as versioned
YAML with verification flags; one compose topology for local and cloud; six-factor live
authorization. Details in `docs/adr/`.

## Known issues and technical debt

1. **Docker images not built here** (no Docker daemon in the build environment). Compose file is
   validated and the API bundle was verified to run without `node_modules`, but the first
   `docker compose up --build` on a real host is still unverified.
2. n8n workflows: tested in a local n8n 2.40.7 (SQLite, no Docker); Telegram and Discord delivery
   were not exercised (no internet from the build environment; email was). Edits made in the n8n
   editor are not synced back to the repository. The ForexFactory-style calendar mapper is
   unverified (the export was unreachable here).
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
19. Calendar windows are persisted (Task 002, migration 0009, `calendar_windows`) and restored on
    startup with their ORIGINAL observation time, so a restart never makes stale data fresh;
    expired / out-of-horizon events are dropped. A stored row that is malformed OR semantically
    invalid (duplicate event ids, which `CalendarService` also rejects) is skipped with a logged
    reason and the newest remaining valid overlapping window is restored. If no valid window
    remains, the calendar stays UNAVAILABLE (no trades, fail-closed). If restoration throws (e.g.
    the database is unavailable), it also emits a `CALENDAR_RESTORE_FAILED` event. A restored
    STALE or UNAVAILABLE calendar, and a restored active blackout, are each
    rejected at the real decision gate (`apps/api/test/calendar-persistence.test.ts`). Open: no
    retention/pruning of `calendar_windows`; store failures are logged/evented but not in health.
    Decision records keep the calendar each decision saw.
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
27. Free chart feed (ADR-0026):
    - Yahoo's stream is unofficial: no service guarantee, Yahoo's terms apply, and FX prices are
      indicative. Futures may be delayed by exchange rules; the delay is measured, not assumed.
    - The real delay has not been measured yet: outbound access is blocked in the build
      environment.
    - After a restart, the H1/H4/D1 bar that is still forming appears only from the next period.
      The history fills only whole periods, and the stream's first partial period is discarded.
    - Rule-based strategies observe these bars. Each setup is evaluated and rejected by the gate
      (no quote), which records it as a decision.

## Next implementation target

**R001 (2026-10-03): the owner's pause of strategy research (2026-09-29) is superseded.** The
founder resumed research and delegated choosing, building and testing strategies. **No strategy is
approved or selected**; LSFVG stays paper-only. R001 fixed validation defects (walk-forward
boundaries, invalid-input handling, held-out labelling; `docs/research/R001-validation-audit.md`).
Next target (the founder removed the US30-only constraint; no instrument is selected): compare the instruments the target prop firms support on verifiable data, trading costs and compatibility; none is a prerequisite, and examined datasets, including the FX losses, are never treated as untouched. Route:
credible modern data → pre-registered candidate tests → unseen-period / cost / stress checks →
prop-rule replay → paper / shadow verification → owner-authorized limited live. The product must
support real execution, but nothing here enables it. Market-data feeds and the owner's news
websites remain in parallel (ADR-0026 chart feed done).

**No strategy is selected for trading.** LSFVG v1.0 showed no edge on 2010–2019
(`docs/research/RESULTS-2026-09-29.md`). Before costs Model A makes +0.02 R per trade and after
costs −0.11 R; Model B is negative even before costs.

What can change this, all needing the owner:

- the SPEC's 2020–2026 period, via the standalone kit or with `datafeed.dukascopy.com` allowed;
- new strategy rules, tested under a protocol written before any result.

The rest of the roadmap needs the owner's platform (Phase 2/9 live data, Phase 10 broker
adapter), firm rules and, for live trading, the six live factors (ADR-0008).
Then: the paper run on a real feed (the market-data adapter for the owner's platform), and the
prop-firm simulation once the owner names the firm and account and its current rules are
verified.
