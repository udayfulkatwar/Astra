# ASTRA — System Architecture

**Autonomous Strategic Trading & Risk Agent** — an AI-orchestrated, prop-firm-first trading operating system.

> Governing principle: **account survival has priority over trade opportunity.**
> The default state of every decision is **NO TRADE**. A trade happens only after every
> mandatory layer explicitly passes. Anything UNKNOWN, STALE, ERROR, TIMEOUT, INVALID or
> UNAVAILABLE blocks new trades.

This document is the technical blueprint. It covers the 18 architecture items required by the
master build prompt (§79). Decisions with meaningful trade-offs are recorded as ADRs in
[`docs/adr/`](./adr). Current implementation status lives in [`PROJECT_STATE.md`](./PROJECT_STATE.md).

---

## 1. System architecture

ASTRA is a **modular monolith** ("ASTRA Core") plus three supporting runtimes: the dashboard,
n8n and PostgreSQL. Inside the core, every functional department of the spec is a separate
package with a one-way dependency graph, so any module can later be extracted into its own
service without rewriting it.

```text
                 ┌─────────────────────────── HUMAN OPERATOR ────────────────────────────┐
                 │  monitor · configure · mode control · kill switches · live authorization │
                 └────────────────────────────────▲─────────────┬─────────────────────────┘
                                                  │ HTTPS (REST + SSE), operator token
┌──────────────────┐                     ┌────────┴─────────────▼─────────────────────────────────────┐
│   DASHBOARD      │────── REST/SSE ────▶│                     ASTRA CORE (apps/api)                    │
│ (apps/dashboard) │                     │                                                              │
└──────────────────┘                     │  DATA         market-data · news · calendar adapters         │
                                         │      │                                                       │
┌──────────────────┐   service token     │  CONTEXT      news/calendar/event-risk/sentiment engines     │
│      n8n         │──── REST/webhook ──▶│      │        AI orchestrator (analysis only, never authority)│
│  (orchestrator)  │◀─── notifications ──│  SIGNAL       market structure · strategy engine             │
└──────────────────┘                     │      │                                                       │
                                         │ ═════╪═══════ DETERMINISTIC SAFETY CORE (authority) ═══════  │
                                         │  DECISION     decision gate ← risk engine ← prop-firm engine │
                                         │               kill switches · health registry · halt monitor │
                                         │      │                                                       │
                                         │  EXECUTION    execution gateway → broker adapter             │
                                         │               (paper │ shadow-suppressed │ live*)             │
                                         │      │                                                       │
                                         │  RECORDS      audit log (hash-chained) · decisions · orders  │
                                         │               journal · AI call log · system events          │
                                         └───────────────────────────┬──────────────────────────────────┘
                                                                     │ SQL
                                                             ┌───────▼───────┐
                                                             │  PostgreSQL   │
                                                             └───────────────┘
                          * live adapters exist only behind explicit human authorization
```

### 1.1 The four kinds of information (never mixed)

| Kind         | Meaning                                               | Example                                        | Produced by               |
| ------------ | ----------------------------------------------------- | ---------------------------------------------- | ------------------------- |
| **DATA**     | An observed fact with a source and timestamp          | quote, OHLC bar, headline, CPI actual          | adapters                  |
| **CONTEXT**  | An interpretation of data                             | "headline is hawkish for USD", event risk HIGH | news/sentiment/AI engines |
| **SIGNAL**   | A strategy's claim that a setup exists                | "US100 bullish BOS + retest, QUALIFIED"        | strategy engine           |
| **DECISION** | A deterministic, audited verdict on a candidate trade | APPROVED qty=2 / REJECTED + reasons            | decision gate             |

These are distinct TypeScript types in `@astra/core`. A function that consumes a SIGNAL cannot be
handed a DECISION by accident. Every DATA value is wrapped in `Observed<T>` which is either
`OK` (value + source + `asOf`) or an explicit non-OK status (`STALE`, `UNKNOWN`, `UNAVAILABLE`,
`ERROR`, `TIMEOUT`, `INVALID`) with a reason. **There is no way to represent "missing" as a
plausible-looking default value.** This is how the no-fabrication rule is enforced in code.

### 1.2 The trade path

```text
candidate (SIGNAL + CONTEXT refs)
   → context assembly   (gather DATA snapshots, each Observed<T>, with timeouts)
   → derivations        (account state, position size — deterministic)
   → gate checks        (pure functions over the frozen snapshot)
   → verdict            (APPROVED only if every mandatory check == PASS)
   → persist decision   (if persistence fails → REJECTED)
   → execution gateway  (re-validates approval, mode, kill switches, duplicates, lock)
   → broker adapter     → confirmation (never assume a fill) → monitoring → journal
```

AI output enters only as CONTEXT inside the snapshot. The gate is a logical AND: AI can make a
decision _more_ restrictive, never less. There is no code path from an AI response to an order.

### 1.3 The market-data path (ADR-0009)

```text
provider adapter (provider symbol + provider timestamp) ─┐
HTTP ingestion from n8n (sourceKind MANUAL) ─────────────┤
SimulationAdapter (sourceKind SIMULATED, paper only) ────┘
   → MarketDataService: symbol mapping → schema → ordering → quality (jump → SUSPECT)
        ├→ latest quote (Observed; INVALID while suspect) → decision gate `data.quote`
        ├→ bar aggregator M1…D1 → completed bars → market_bars (batched)
        ├→ listeners (paper broker stops/targets)
        └→ market snapshot (scanner): levels, sessions, ATR — null when not derivable
```

| Element         | Where                                    | Rule                                                                                      |
| --------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| Adapter port    | `@astra/market-data` `MarketDataAdapter` | provider timestamps, provider symbols, honest `health()`; real providers await the owner  |
| Quality monitor | `QuoteQualityMonitor`                    | move > `maxQuoteJumpTicks` → quotes INVALID for the cooldown (default 60 s)               |
| Bars            | `BarAggregator`                          | quote-built, per symbol × source; gaps never filled; partially observed periods discarded |
| Snapshot        | `computeMarketSnapshot`                  | exact contract served by `/api/v1/market/scanner`; missing → null                         |
| Feed health     | health probe (`MARKET_DATA`)             | ONLINE all traded instruments fresh · DEGRADED some · UNKNOWN none                        |

---

## 2. Technology stack

| Concern      | Choice                                                       | Why                                                                    |
| ------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Language     | TypeScript 6 (strict) on Node.js 22 LTS                      | one typed language across backend, frontend, contracts                 |
| Monorepo     | pnpm workspaces, internal source packages                    | enforced module boundaries without per-package builds                  |
| API          | Fastify 5                                                    | fast, schema-first, first-class pino logging, `inject()` for tests     |
| Validation   | Zod 4                                                        | runtime validation of every boundary (config, API, AI output, DB rows) |
| Money math   | decimal.js                                                   | no binary-float drift in risk/position-size calculations (ADR-0004)    |
| Time zones   | Luxon                                                        | DST-correct prop-firm day resets and trading sessions; UTC internally  |
| Database     | PostgreSQL 16, `postgres` driver, plain SQL migrations       | transparent, auditable schema; checksum-verified migrations (ADR-0002) |
| Logging      | pino (JSON) with secret redaction                            | structured, cheap, container-friendly                                  |
| Frontend     | React 19 + Vite + TanStack Query + React Router              | fast dev loop, cache-aware polling of the API                          |
| Automation   | n8n (self-hosted)                                            | orchestration/notifications; never decision authority (ADR-0005)       |
| Tests        | Vitest + fast-check (property tests) + real Postgres         | risk math is proven by invariants, not examples only                   |
| Packaging    | Docker + docker compose                                      | identical local and cloud topology (ADR-0007)                          |
| CI           | GitHub Actions                                               | lint, typecheck, unit + DB integration tests on every push             |
| AI (Phase 6) | `AiProvider` port; Anthropic SDK adapter; SIMULATED stand-in | models are replaceable components (ADR-0020)                           |

---

## 3. Repository structure

```text
astra/
├── apps/
│   ├── api/                 ASTRA Core service (Fastify). Composition root: wires packages together.
│   └── dashboard/           Operator command center (React). No secrets, no trading logic.
├── packages/
│   ├── core/                Domain primitives: Observed<T>, modes, health, time, decimal, ids, schemas
│   ├── config/              YAML config loading, validation, hashing (config version in every decision)
│   ├── prop-firm/           Rule profiles, account-state engine, prop-firm rule engine (canTrade)
│   ├── risk/                Capital preservation engine: sizing, policy limits, account health
│   ├── safety/              Kill switches, component health registry, halt monitor
│   ├── market-data/         Market-data adapter port, quote quality, OHLC bars, market snapshots
│   ├── market-structure/    Swings, BOS/CHoCH, liquidity, fair value gaps from complete bars (ADR-0010)
│   ├── calendar/            Calendar provider port + poller, validation, currency mapping, event risk (ADR-0011)
│   ├── news/                News provider port + poller, rules classifier, news risk, sentiment (ADR-0019)
│   ├── ai/                  AI orchestrator: provider port, routing, budgets, call log, tasks; Claude adapter (ADR-0020)
│   ├── journal/             Trade journal: excursions, plan-vs-actual entries, statistics (ADR-0015)
│   ├── learning/            Learning metrics over journal entries, observations only (ADR-0018)
│   ├── backtest/            M1 replay through the real gate, protection and journal (ADR-0016)
│   ├── decision/            Fail-closed gate pipeline, standard checks, decision records
│   ├── execution/           Broker adapter interface, paper broker, execution gateway
│   └── db/                  SQL migrations, migration runner, repositories
├── config/                  Versioned configuration (profiles, instruments, accounts, strategies, policies)
├── automation/n8n/          n8n workflows (JSON, version-controlled)
├── infra/docker/            Dockerfiles
├── docs/                    Architecture, ADRs, runbooks, project state
├── docker-compose.yml       Local + single-host cloud topology
└── .github/workflows/       CI
```

**Dependency direction (enforced by package.json dependencies, no cycles):**

```text
prop-firm   → core
risk        → core, prop-firm
safety      → core
market-data → core   (pure and isomorphic: also runs in the browser)
market-structure → core, market-data   (pure and isomorphic; no lookahead)
calendar    → core   (pure and isomorphic)
news        → core   (pure and isomorphic; CONTEXT only)
ai          → core, journal, market-data, market-structure, news   (isomorphic core; CONTEXT only;
              the Anthropic SDK only in the `@astra/ai/anthropic` subpath, used by apps/api)
journal     → core   (pure and isomorphic)
learning    → core, journal   (pure and isomorphic; descriptive only, no write path)
backtest    → core, calendar, decision, journal, market-data, market-structure, prop-firm, risk, safety
              (pure and isomorphic; composes the real engines; no lookahead)
decision    → core, prop-firm, risk, safety
execution   → core, decision (approval types), safety
config      → core, ai, prop-firm, risk, decision, market-structure   (composes their schemas; loads YAML)
db          → core, ai, backtest, decision, execution, journal, market-data, prop-firm, safety   (implements their ports)
apps/api    → everything (composition root)
apps/dashboard → type-only imports of domain packages (nothing enters the browser bundle)
```

Domain packages never import `db`, Fastify, or any I/O library. They expose **ports**
(interfaces) that the API wires to concrete adapters. This keeps every safety-critical rule a
pure, unit-testable function.

---

## 4. Service boundaries

| Runtime        | Responsibility                                                                                                              | Must never                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **ASTRA Core** | all authoritative state and decisions: risk, rules, kill switches, gate, execution, audit, safety-critical monitoring loops | delegate a safety decision to n8n or AI                             |
| **Dashboard**  | display state, human controls (pause, halt, kill switches, mode)                                                            | hold secrets, compute risk, talk to brokers                         |
| **n8n**        | schedules, event fan-out, data fetching workflows, AI analysis requests, notifications, reports                             | call brokers, compute risk, approve trades, hold broker credentials |
| **PostgreSQL** | durable state, append-only audit                                                                                            | be bypassed: no trade if critical records cannot be persisted       |

**Safety-critical loops run inside the core, not in n8n** (ADR-0005). If n8n stops, position
monitoring, daily-loss halts and kill switches keep working; only orchestration pauses and the
automation health becomes `UNKNOWN`, which blocks new trades.

Future extraction candidates (only when justified by load or isolation needs): execution
gateway (co-located with the broker region), market-data ingestion (high-frequency feeds).

---

## 5. Database schema

PostgreSQL, UTC `timestamptz` everywhere, `numeric` for money. Migrations are plain SQL files
in `packages/db/migrations`, applied in order by a runner that records a SHA-256 checksum of
each file and **refuses to start if an applied migration was edited**. An advisory lock prevents
two instances migrating concurrently.

### Phase-1 tables

| Table                  | Purpose                                                                                           | Mutability                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `schema_migrations`    | applied migrations + checksums                                                                    | append-only                                       |
| `config_versions`      | every distinct config snapshot loaded (hash → content)                                            | append-only                                       |
| `system_state`         | current trading mode (single row, versioned)                                                      | update with optimistic version                    |
| `audit_log`            | hash-chained record of every important action                                                     | **append-only, UPDATE/DELETE blocked by trigger** |
| `system_events`        | live activity stream (what the dashboard shows)                                                   | append-only                                       |
| `kill_switches`        | current kill-switch state per scope/target                                                        | upsert                                            |
| `kill_switch_events`   | activation/deactivation history                                                                   | append-only                                       |
| `component_heartbeats` | last heartbeat per external component (n8n, feeds)                                                | upsert                                            |
| `trade_candidates`     | submitted candidates (signal + context refs)                                                      | append-only                                       |
| `trade_decisions`      | verdict, every check result, sizing, input snapshot, config hash, approval expiry/consumption     | insert; only `approval_state` transitions         |
| `orders`               | orders with **unique `approval_id`** and unique `client_order_id` (DB-level duplicate protection) | status transitions                                |
| `order_events`         | every broker interaction and status change                                                        | append-only                                       |
| `account_snapshots`    | periodic account state (balance, equity, HWM, computed buffers)                                   | append-only                                       |

### Phase-2 tables

| Table         | Purpose                                                                                                                    | Mutability                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `market_bars` | completed OHLC bars built from observed quotes; PK (symbol, timeframe, open_time, source); `volume` NULL when not reported | upsert (complete bars only) |

### Phase-4 tables

| Table        | Purpose                                                                 | Mutability  |
| ------------ | ----------------------------------------------------------------------- | ----------- |
| `news_items` | accepted news items with their classification (classifier version kept) | insert-only |

### Phase-6 tables

| Table            | Purpose                                                                                     | Mutability  |
| ---------------- | ------------------------------------------------------------------------------------------- | ----------- |
| `ai_model_calls` | every AI call, sent or blocked: task, model served, status, tokens, cost, latency, fallback | append-only |
| `ai_analyses`    | trade analyses per exact signal, with the brief the model saw                               | append-only |
| `ai_reviews`     | post-trade reviews (process × outcome, lessons, PROPOSED changes — never applied)           | append-only |

### Phase-8 tables

| Table           | Purpose                                                                            | Mutability  |
| --------------- | ---------------------------------------------------------------------------------- | ----------- |
| `trade_journal` | one entry per closed trade: plan vs actual, costs, R, observed excursions          | append-only |
| `backtest_runs` | each backtest's request and full deterministic result (label, assumptions, trades) | append-only |

### Later phases (planned)

`instruments`, `economic_events`, `sentiment_readings`, `signals`,
`positions`, `ai_model_calls`, `workflow_runs`, `alerts`, `performance_metrics`,
`operating_costs`.

The conceptual entities of spec §47 that are _configuration_ (prop-firm profiles, rules,
strategies, instruments, risk policies, account definitions) live in version-controlled YAML
under `config/` (ADR-0006): git history is the change-review process, and the SHA-256 of the
loaded configuration is stamped on every decision so any decision can be traced to the exact
rules in force.

---

## 6. API architecture

- REST, JSON, versioned under `/api/v1`. Server-Sent Events for the live activity stream.
- Every request and response body is validated with Zod. Errors use one envelope:
  `{ "error": { "code": "...", "message": "...", "requestId": "..." } }`.
- **Authentication:** bearer tokens mapped to roles, compared in constant time.

  | Role         | Holder               | Can                                                               |
  | ------------ | -------------------- | ----------------------------------------------------------------- |
  | `viewer`     | read-only dashboards | read state                                                        |
  | `automation` | n8n                  | read state, submit candidates, heartbeats, report workflow errors |
  | `operator`   | the human            | everything above + mode changes, kill switches, execution         |

  Live-mode activation additionally requires a server-side environment authorization
  (`ASTRA_LIVE_TRADING_AUTHORIZED=true`) _and_ per-account `liveTradingAuthorized: true` in
  config _and_ verified rule profile + instrument specs. No API call alone can enable live trading.

- Rate limiting and security headers on all routes; CORS restricted to the dashboard origin.

### Endpoints (Phases 1–2)

| Method   | Path                                                                                       | Role                                         |
| -------- | ------------------------------------------------------------------------------------------ | -------------------------------------------- |
| GET      | `/healthz` (liveness) · `/readyz` (readiness)                                              | none                                         |
| GET      | `/api/v1/system/status` — the core status bar                                              | viewer                                       |
| GET      | `/api/v1/system/health` — per-component health                                             | viewer                                       |
| GET/POST | `/api/v1/system/mode`                                                                      | viewer / operator                            |
| GET      | `/api/v1/accounts`, `/api/v1/accounts/:id`                                                 | viewer                                       |
| POST     | `/api/v1/accounts/:id/snapshots`                                                           | automation                                   |
| GET      | `/api/v1/config/summary` (profiles, instruments, strategies; never secrets)                | viewer                                       |
| GET      | `/api/v1/kill-switches` · POST `/activate` · POST `/deactivate`                            | viewer / operator                            |
| POST     | `/api/v1/decisions/evaluate`                                                               | automation                                   |
| GET      | `/api/v1/decisions`, `/api/v1/decisions/:id`                                               | viewer                                       |
| POST     | `/api/v1/executions` (by approval id)                                                      | operator (automation later, per mode policy) |
| GET      | `/api/v1/audit`, `/api/v1/events`, `/api/v1/stream` (SSE)                                  | viewer                                       |
| POST     | `/api/v1/automation/heartbeat`, `/api/v1/automation/errors`                                | automation                                   |
| GET/POST | `/api/v1/market/quotes` (latest quotes / ingestion)                                        | viewer / automation                          |
| GET      | `/api/v1/market/scanner` (market snapshots)                                                | viewer                                       |
| GET      | `/api/v1/market/bars?symbol=&timeframe=&limit=`                                            | viewer                                       |
| GET      | `/api/v1/journal`, `/api/v1/journal/summary`                                               | viewer                                       |
| POST     | `/api/v1/backtests` (replay; never trades)                                                 | operator                                     |
| GET      | `/api/v1/backtests`, `/api/v1/backtests/:id`                                               | viewer                                       |
| GET      | `/api/v1/learning` (journal or a backtest run)                                             | viewer                                       |
| POST     | `/api/v1/news/items` (push; MANUAL)                                                        | automation                                   |
| GET      | `/api/v1/news`, `/api/v1/news/context`                                                     | viewer                                       |
| GET      | `/api/v1/ai/status`, `/api/v1/ai/calls`, `/api/v1/ai/analyses[/:id]`, `/api/v1/ai/reviews` | viewer                                       |
| POST     | `/api/v1/ai/analyses` (analyse a signal now)                                               | automation                                   |
| POST     | `/api/v1/ai/reviews` (post-trade review of a journaled trade)                              | operator                                     |

---

## 7. n8n architecture

- Runs in its own container with its own database (`n8n`) on the same Postgres server.
- Authenticates to ASTRA with the `automation` token stored in **n8n credentials**, never inside
  workflow JSON. Workflow JSON is version-controlled in `automation/n8n/workflows/`.
- Workflow families:
  1. **Health** — heartbeat to `/automation/heartbeat` every minute (ASTRA marks n8n `UNKNOWN`
     when the heartbeat is older than the configured threshold).
  2. **Ingestion** — poll news / calendar providers, normalise, POST to ASTRA (Phase 4).
  3. **Cycle** — scheduled and event-driven scan triggers → candidate submission (Phase 5/7).
  4. **AI analysis** — request structured analysis through ASTRA's AI orchestrator (Phase 6).
  5. **Notifications** — subscribe to ASTRA alerts → Telegram/Discord/email.
  6. **Reports** — daily and weekly reports (Phase 7).
  7. **Error handler** — global n8n error workflow → `/automation/errors` → system event + alert.
- Every workflow call carries a `workflowRunId` so ASTRA's audit log can correlate actions to
  n8n executions. n8n is never trusted for correctness: every payload is re-validated server-side.

---

## 8. AI architecture (Phase 6; built — ADR-0020)

```text
caller (engine / n8n) → AI Orchestrator → router(task → model) → provider adapter → model
                               │                                        │
                               └──── schema validation ◀── raw output ◀─┘
                               └──── ai_model_calls log (model, tokens, cost, latency, status)
```

- **Providers are adapters** behind one `AiProvider` interface (Anthropic, OpenAI, mock).
  Routing is configuration: task → provider/model, so models are swapped without code changes.
- **Structured output only.** Every task has a Zod schema. Malformed output is `INVALID` — never
  "repaired" by guessing. Unavailable AI is `UNAVAILABLE`. ASTRA never invents AI output.
- **AI is CONTEXT.** A strategy may declare AI analysis _mandatory_; then AI `UNAVAILABLE` or
  `INVALID` → NO TRADE. AI can veto, never approve; it never computes sizing, drawdown, limits.
- **AI kill switch** disables all model calls. Budgets (daily tokens/cost) degrade AI health when
  exceeded. Deterministic code is preferred whenever it can solve the problem (cost + safety).
- AI suggestions for configuration changes (e.g., from post-trade analysis) become _proposals_
  that require human review; ASTRA never auto-applies AI suggestions to live risk parameters.
- **As built (ADR-0020):** tasks TRADE_ANALYSIS and POST_TRADE_REVIEW; the budget checks each
  call's worst-case cost before sending; the Claude adapter uses structured output and the
  server-side refusal fallback; for an AI-required strategy the deterministic checks run first and
  the model is asked only when they all pass, then the gate decides on re-assembled data plus the
  stored analysis. In simulation mode a SIMULATED stand-in (fixed rules, not an AI model) can run
  the same path; SHADOW/LIVE refuse its output.

---

## 9. Prop-firm rule architecture

- **Rule profiles are data**, not code (`config/prop-firm-profiles/*.yaml`), validated by a Zod
  schema. The core engine contains **no firm-specific rules**.
- Each profile carries `verification.status`: `UNVERIFIED` (template/example) or
  `USER_VERIFIED` (the owner confirmed it against the firm's current terms). **LIVE mode refuses
  accounts whose profile is unverified.** ASTRA ships only clearly-labelled templates; real firm
  rules must be supplied/verified by the owner (no fabrication).
- Supported rule families: daily loss (fixed / % of initial / % of day-start; balance / equity /
  higher-of basis; realized-only vs floating; reset time in a named time zone), max drawdown
  (static, trailing intraday, trailing end-of-day, trailing lock level), max contracts / lots,
  scaling plans, max open positions, leverage, max risk per trade, stop-loss requirement,
  consistency (max share of total profit from one day), news restrictions, weekend / overnight
  holding, allowed trading hours, minimum trading days, profit target, payout requirements/caps.
- **Account State Engine** (`computeAccountState`) derives, per account: daily-loss floor and
  remaining, drawdown threshold and remaining, distance to breach, profit-target progress,
  consistency status, open risk — as exact decimals.
- **Rule Engine** (`evaluatePropFirmRules`) is the spec's `canTrade(account, proposedTrade)`:
  it evaluates the _worst case_ (all open positions and the new trade stopped out, plus
  slippage allowance) against every limit and returns
  `{ approved, status, reasons[], checks[] }`. Missing data → `UNKNOWN` → not approved.
- Accounts are isolated: every computation takes one account's snapshot and one profile; there
  is no shared mutable state between accounts.

---

## 10. Risk architecture — the Capital Preservation Engine

Layered limits; **the smallest applicable limit always wins**:

```text
1. Prop-firm hard limits     (external — breach = account loss)
2. Internal risk policy      (stricter self-imposed buffers per account)
3. Strategy limits           (per-strategy max risk, trades/day)
4. Instrument limits         (max quantity, spread)
5. Per-trade sizing          (risk % of equity, cash cap, R:R minimum)
```

- **Position sizing** (`calculatePositionSize`): allowed risk = min(equity × risk%, cash cap,
  fraction of remaining daily-loss buffer, fraction of remaining drawdown buffer, remaining
  open-risk capacity, strategy cap); per-unit risk includes stop distance, commission and a
  slippage allowance; quantity is floored to the instrument's step and clamped by contract/lot
  limits and scaling plans. Output reports recommended / maximum / actual size, dollar risk,
  risk %, and **which constraint was binding**. Size below minimum → rejection, never rounding up.
- **Policy checks**: max trades per day, max consecutive losses, min reward:risk, max open risk,
  max positions per instrument, duplicate exposure.
- **Account health** (`classifyAccountHealth`): `SAFE → CAUTION → RESTRICTED → BREACH_RISK →
HALTED`, plus `UNKNOWN` when inputs are stale/missing. Thresholds are policy configuration.
  `CAUTION` reduces size by a configured multiplier; `RESTRICTED`, `BREACH_RISK`, `HALTED` and
  `UNKNOWN` forbid new trades.
- **Kill switches** (`@astra/safety`): GLOBAL, ACCOUNT, STRATEGY, INSTRUMENT, EXECUTION, AI,
  NEWS. Any active switch whose scope matches a candidate blocks it. Registry state must be
  loaded from the database before anything is allowed (**fail-closed on startup**).
- **Halt monitor** (in-core loop): automatically activates kill switches on daily-loss /
  drawdown thresholds, stale data, broker disconnection, unconfirmed orders, duplicate orders,
  integrity failures — per spec §25. System-activated switches clear only by human action or at
  the next trading day when configured.

---

## 11. Execution abstraction

```text
decision (APPROVED, approvalId, expiresAt)
   → ExecutionGateway.execute(approvalId)
        1. approval exists, APPROVED, unexpired, unconsumed        (else reject)
        2. mode policy: HALTED/BACKTEST → reject; SHADOW → record, never send;
           PAPER → paper adapter only; LIVE → live adapter + full live authorization
        3. kill switches re-evaluated at execution time
        4. per-account execution lock (no concurrent orders for one account)
        5. duplicate protection: atomic approval consumption, unique approval_id and
           client_order_id in DB, open-order and open-position checks
        6. order built *from the approval* (quantity ≤ approved; stop mandatory)
        7. submit with idempotency key (clientOrderId derived from approvalId)
        8. confirm by polling broker state; unconfirmed within timeout → status UNKNOWN →
           EXECUTION kill switch for that account + critical alert
   → BrokerAdapter (PaperBrokerAdapter now; platform adapters later)
```

- `BrokerAdapter` is the only thing that knows a platform. Adapter kinds are `PAPER` or `LIVE`;
  the gateway refuses mismatches with the mode.
- The paper adapter supports failure injection (rejects, timeouts, partial fills, slippage) so the
  whole safety chain is testable without a real account (spec §65).
- Candidate adapters (decided when the owner confirms the platform): MT5, cTrader, DXtrade,
  Match-Trader, Tradovate, Rithmic-based, ProjectX-based — each behind the same interface.

---

## 12. Security architecture

- **Secrets** only in environment variables / a secret manager. Never in git, frontend bundles,
  logs, config YAML, or n8n workflow JSON. Config references secrets by env-var _name_
  (e.g., `credentialsEnv: BROKER_ACCOUNT_A_TOKEN`). `.env` is git-ignored; `.env.example`
  documents names only.
- **Log redaction**: pino redacts authorization headers, tokens, passwords, API keys.
- **Least privilege**: role-based API tokens; separate automation vs operator tokens; DB role
  without superuser; containers run as non-root.
- **Frontend**: no secrets; the operator types their token at login; it is kept in session
  storage for the tab only and sent as a bearer header. (Cloud hardening path: OIDC + HttpOnly
  session cookies behind the reverse proxy.)
- **Integrity**: audit log is append-only (trigger-enforced) and hash-chained; migrations are
  checksum-verified; configuration hash is recorded with each decision.
- **Network**: in cloud, only the reverse proxy (TLS) is exposed; Postgres and n8n editor are
  private or behind authentication. n8n basic auth / user management enabled.
- **Supply chain**: lockfile committed; CI runs `pnpm audit` (report-only initially).

---

## 13. Development phases

| Phase | Scope                                                                                      | Exit criteria                                           |
| ----- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| 0     | Architecture, repo, stack, ADRs                                                            | this document                                           |
| 1     | Foundation: tooling, config, DB, API, dashboard, logging, observability                    | CI green, API + DB + dashboard run locally              |
| 3*    | Prop-firm engine, risk engine, kill switches, decision gate, execution abstraction (paper) | risk/prop tests incl. property tests; fail-closed tests |
| 2     | Market data adapters, instrument registry, session engine, scanner                         | live quotes with freshness health                       |
| 4     | News + economic calendar ingestion, event-risk engine, sentiment                           | calendar gate on real data                              |
| 5     | Strategy engine, market structure, setup detection, candidates                             | owner's strategy configured                             |
| 6     | AI orchestrator, structured analysis, explanations, post-trade analysis                    | malformed/unavailable AI tests                          |
| 7     | n8n workflows: ingestion, cycles, alerts, journaling, reports                              | workflow failure/recovery tests                         |
| 8     | Paper trading end-to-end                                                                   | weeks of paper runs, reviewed                           |
| 9     | Shadow mode on real data                                                                   | decision-vs-outcome comparison                          |
| 10    | Controlled live (strict limits, human authorization)                                       | owner sign-off                                          |

\* The safety core (Phase 3) is built before market data because every later phase plugs into
it, and because the spec calls it the critical phase. It is pure logic, fully testable without
external data.

---

## 14. Testing strategy

| Spec category                                            | Where                             | How                                                                                                                                   |
| -------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Unit — risk, sizing, drawdown, rules                     | `packages/{risk,prop-firm}`       | examples + **property tests** (fast-check): size never exceeds any limit, dollar risk ≤ allowed risk, worst case never crosses breach |
| Integration — data → strategy → risk → approval          | `packages/decision`, `apps/api`   | full pipeline over frozen snapshots; API via `fastify.inject`                                                                         |
| Failure — API failure, timeout, stale data, DB failure   | `decision`, `api`                 | every non-OK `Observed` status must reject; audit write failure must reject                                                           |
| Prop-firm — daily loss, drawdown, consistency, contracts | `prop-firm`                       | table-driven cases per rule family, trailing/lock edge cases                                                                          |
| Execution — duplicates, rejects, partial fills           | `execution`                       | paper adapter failure injection, concurrent execute() races                                                                           |
| AI — malformed / unavailable                             | `ai` (Phase 6)                    | schema-violating outputs → INVALID → NO TRADE                                                                                         |
| Automation — n8n failure                                 | `api`                             | stale heartbeat → automation UNKNOWN → NO TRADE                                                                                       |
| Recovery — restart, reconnection                         | `db`, `api`                       | kill switches/mode survive restart; fail-closed before state load                                                                     |
| Kill switch                                              | `safety`, `decision`, `execution` | every scope blocks both decision and execution                                                                                        |
| DB                                                       | `packages/db`                     | real Postgres (local service or CI container); audit immutability + chain verification                                                |

Rule: nothing is reported as "working" because it compiles. CI runs lint, typecheck and all
tests; DB tests run against a real Postgres.

---

## 15. Deployment architecture

One topology, two targets (ADR-0007): `docker-compose.yml` defines `postgres`, `api`,
`dashboard` (static build served by nginx), `n8n`. Configuration differs only through
environment variables and mounted `config/`.

## 16. Local development architecture

- `docker compose up postgres n8n` for infrastructure; `pnpm dev` runs the API (tsx watch) and the
  dashboard (Vite) with hot reload. Or `docker compose up` for the full stack.
- Works on Linux and Windows (Docker Desktop / WSL2). Default mode is **PAPER**; the database
  starts in `PAPER` and never starts in `LIVE`.

## 17. Cloud architecture

```text
Internet ─TLS─▶ reverse proxy (Caddy) ─▶ dashboard (static)
                                     └─▶ api  ─▶ postgres (managed or volume + backups)
                                     └─▶ n8n editor (auth required, optionally IP-restricted)
```

- Initial target: a single VM (2 vCPU / 4 GB) in a region close to the broker's servers.
- Managed Postgres (or daily `pg_dump` + WAL archiving) with tested restores.
- External uptime monitor on `/healthz`; alerts through the notification workflows plus an
  out-of-band channel for "ASTRA itself is down".
- Scale-out path: extract the execution gateway / market-data ingestion into their own
  containers; the package boundaries already match.

## 18. Failure and recovery architecture

| Failure                         | Detection                             | Behaviour                                                                                                                            | Recovery                                    |
| ------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Market data stale / missing     | `Observed` status, freshness limits   | NO NEW TRADE for affected instruments; halt monitor may trip INSTRUMENT switch                                                       | automatic when fresh data returns           |
| Abnormal quote jump (bad tick)  | quality monitor (`maxQuoteJumpTicks`) | quotes INVALID for the cooldown → NO NEW TRADE on the instrument; MARKET_DATA not ONLINE                                             | automatic after the cooldown                |
| News / calendar unavailable     | provider status                       | calendar check UNKNOWN → NO NEW TRADE                                                                                                | automatic                                   |
| AI unavailable / malformed      | provider status, schema validation    | AI `UNAVAILABLE`/`INVALID`; strategies requiring AI → NO TRADE                                                                       | automatic                                   |
| n8n down                        | heartbeat age                         | automation `UNKNOWN` → NO NEW TRADE; in-core monitoring continues                                                                    | automatic on heartbeat                      |
| Database down                   | readiness probe, write failures       | decisions rejected (cannot persist audit); execution refused                                                                         | automatic on reconnect                      |
| Broker disconnected             | adapter health                        | EXECUTION unhealthy → NO NEW TRADE; halt monitor trips switch                                                                        | human review                                |
| Order state unknown             | confirmation timeout                  | EXECUTION kill switch for the account + CRITICAL alert                                                                               | reconcile with broker, human clears         |
| Duplicate order detected        | DB unique constraints, gateway checks | order refused; halt monitor trips switch                                                                                             | human review                                |
| Daily loss / drawdown threshold | account-state engine                  | account kill switch (SYSTEM)                                                                                                         | next trading day (daily) / human (drawdown) |
| Process restart                 | startup sequence                      | fail-closed until mode + kill switches loaded; approvals issued before restart are invalid; open orders reconciled before new trades | automatic                                   |
| Config invalid                  | Zod validation at load                | service refuses to start (no partially-valid config)                                                                                 | fix config                                  |
| Clock drift                     | server time vs broker/feed timestamps | data marked STALE/INVALID when timestamps are in the future beyond tolerance                                                         | fix NTP                                     |

**Startup sequence:** load + validate config → connect DB → verify migrations → load trading
mode → load kill switches → mark safety state `LOADED` → start monitors → accept candidates.
Before the safety state is loaded, every decision is `REJECTED` with reason
"safety state not loaded".
