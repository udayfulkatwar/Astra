# ASTRA — Project overview (for reviewers)

_State as of 2026-09-29, branch `claude/astra-master-instructions-kdahkc`._

This is a self-contained briefing for anyone (a person or another AI) reviewing ASTRA. Every
number here comes from the repository itself. Details and sources are in the documents linked
at the end.

## 1. What ASTRA is

ASTRA (Autonomous Strategic Trading & Risk Agent) is a **prop-firm-first trading operating
system**. It collects market data, news and calendar events, evaluates trade ideas, checks every
risk and prop-firm rule, and executes only through a fail-closed gate.

Its governing rule: **account survival has priority over trade opportunity.** The default state is
**NO TRADE**. A trade happens only when every mandatory check passes; any input that is
UNKNOWN, STALE, ERROR, TIMEOUT, INVALID or UNAVAILABLE blocks it.

```text
DATA → CONTEXT → SIGNAL → AI ANALYSIS → RISK → PROP-FIRM → EXECUTION GATE → EXECUTE → MONITOR → REVIEW
```

- AI and automation (n8n) may analyse, propose and orchestrate. AI can **veto** a trade, never
  approve one.
- Deterministic code owns risk, position sizing, prop-firm rules, kill switches and the
  permission to execute. There is no path from an AI answer to an order.
- **Live trading is not enabled.** It needs six separate conditions, several of which only the
  owner can set (section 6).

The owner gives direction and inputs (about 10 % oversight). Claude (Anthropic's AI) wrote the
code, tests and documents under the owner's master instructions.

## 2. Snapshot

| Item                 | Value                                                                               |
| -------------------- | ----------------------------------------------------------------------------------- |
| Work period          | 2026-09-27 → 2026-09-29 (commits by day: 21 · 9 · 9, then this overview)            |
| Code                 | ≈ 39,600 lines TypeScript (source), ≈ 15,600 lines of tests, ≈ 2,600 lines Python   |
| Automated tests      | **659 passing** in 73 test files (unit, property-based, PostgreSQL integration, UI) |
| CI                   | GitHub Actions: format · lint · typecheck · test (with Postgres) · build — green    |
| Packages             | 18 packages (`packages/`) + API + dashboard + n8n workflows                         |
| Architecture records | 26 ADRs (`docs/adr/`)                                                               |
| Database             | PostgreSQL, 8 migrations, 22 tables                                                 |
| API                  | 53 HTTP endpoints (REST + an SSE event stream)                                      |
| Dashboard            | 21 pages (React)                                                                    |
| Automation           | 8 n8n workflows, generated from tested code                                         |
| Trading mode today   | PAPER (simulated broker). SHADOW and LIVE are built but not used.                   |

## 3. Status by phase

| Phase | Scope                                                        | Status                                                                                                            |
| ----- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 0     | Architecture, stack, ADRs                                    | **Done**                                                                                                          |
| 1     | Foundation: tooling, config, DB, API, dashboard, logging     | **Done**                                                                                                          |
| 3     | Safety core: prop-firm, risk, kill switches, gate, execution | **Done** (built before Phase 2 on purpose: everything plugs into it)                                              |
| 2     | Market data, instruments, sessions, scanner                  | **Done except the trading platform's quote adapter** (needs the owner's platform). Free chart feed done.          |
| 4     | Economic calendar and news                                   | **Engines done.** Real sources need the owner's choice (news RSS links, calendar source).                         |
| 5     | Strategy                                                     | Structure engine, the owner's LSFVG strategy and research done. **LSFVG has no edge.** Paused by the owner.       |
| 6     | AI analysis layer                                            | **Done.** Real calls need the owner's Anthropic API key and budget.                                               |
| 7     | n8n workflows                                                | **Done** (run in a real n8n 2.40.7). Needs the owner's sources and notification channels.                         |
| 8     | Paper trading end to end                                     | Monitor, protection, journal, backtests, learning metrics done. **An extended paper run on a live feed remains.** |
| 9     | Shadow mode on real data                                     | Not started — needs the platform's live quotes.                                                                   |
| 10    | Controlled live trading                                      | Not started — needs the platform adapter and **the owner's explicit authorization**.                              |

## 4. What ASTRA can do today

- **Decision gate:** 22 checks in 11 layers (system, data, market, calendar, news, AI, strategy,
  risk, prop-firm, position, execution). Each decision is stored immutably with its full inputs,
  config hash and a plain-language explanation.
- **Risk and prop-firm rules:**
  - position sizing where the smallest limit wins;
  - daily and trailing drawdown limits, including the worst path of a trailing drawdown
    (run-up, then reversal);
  - consistency, flat times and weekend rules;
  - a daily losing-streak limit.
- **Safety:**
  - kill switches in 7 scopes (global, account, strategy, instrument, execution, AI, news);
  - component health, where silence counts as UNKNOWN;
  - automatic protective closing: risk-reducing only, authorised by the owner, audited;
  - a hash-chained, append-only audit log.
- **Execution:** a paper broker with brackets and LIMIT orders with expiry. The gateway has
  re-validation, a per-account lock, three levels of duplicate protection and confirmation
  polling; an UNKNOWN order state halts trading.
- **Market data:**
  - quote validation and a quality guard for abnormal jumps;
  - OHLC bars M1…D1 (gaps are never filled), a market scanner, and market structure (swings,
    BOS/CHoCH, liquidity, fair value gaps);
  - **free live charts 24/7** from Yahoo's public price stream (no account, no key). These are
    prices only, never used to trade (ADR-0026).
- **Calendar and news:**
  - event blackouts, change events and an event-risk view;
  - a rules-based news classifier (13 categories) with news risk in the gate.
- **AI:** an orchestrator with a daily budget, timeout, schema validation and call log, plus a
  Claude adapter. AI trade analysis is a veto-only gate input; post-trade reviews are also
  available.
- **Strategy:** the owner's **LSFVG v1.0** (H1 bias, M15 sweep / displacement / CHoCH-BOS /
  FVG, M5 LIMIT entry, Model A 2R and Model B liquidity target) runs inside ASTRA through the
  full gate.
- **Review and research:**
  - a trade journal (plan vs actual, R, MFE/MAE) and learning metrics that are descriptive
    only and never change settings;
  - backtests through the real gate;
  - research tools: data import, out-of-sample tests, walk-forward, Monte Carlo and
    sensitivity;
  - a standalone Python research kit whose trades match ASTRA's exactly.
- **Operations:** Docker Compose (Postgres, API, dashboard, n8n), a self-contained API bundle,
  and an in-browser demo that runs the real engines on simulated data.

## 5. What ASTRA does not do yet (and why)

| Missing                            | Reason / what is needed                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| Trading on real prices             | The owner has not chosen a trading platform (MT5, cTrader, Tradovate, …)        |
| Verified prop-firm rules           | Only **templates** exist; no firm's rules were invented. Needs the owner's firm |
| Verified instrument specs          | Templates (UNVERIFIED). Needs the broker's contract sizes, commission, hours    |
| A strategy approved for trading    | LSFVG v1.0 showed **no edge** (section 7); the owner will supply a new strategy |
| Real news and calendar sources     | Needs the owner's RSS/Atom links and calendar source                            |
| Real AI calls                      | Needs an Anthropic API key and budget in the server environment                 |
| Live trading                       | Deliberately off; six factors including the owner's authorization (ADR-0008)    |
| Docker images built on a real host | No Docker daemon in the build environment; compose file validated only          |

## 6. Safety rules that hold everywhere

1. **No fabrication.** Every external input is wrapped in `Observed<T>` with source, kind
   (LIVE / SIMULATED / HISTORICAL / MANUAL), timestamp and status. Missing data stays missing;
   it is never estimated.
2. **Fail closed.** Any non-OK input rejects the trade. Every layer keeps at least one
   mandatory check.
3. **Templates stay templates.** Configs are marked `UNVERIFIED` / `TEMPLATE`, and LIVE refuses
   them.
4. **Secrets only in environment variables.** Configuration holds variable _names_, and the
   loader rejects values that look like secrets.
5. **SIMULATED data can never drive SHADOW or LIVE decisions** (`data.source-kinds` check).
6. **Live needs all six factors:**
   1. `ASTRA_LIVE_TRADING_AUTHORIZED=true` on the host;
   2. an operator sets the mode to LIVE (audited);
   3. the account has `liveTradingAuthorized: true`;
   4. the prop-firm profile and instrument spec are `USER_VERIFIED`;
   5. a LIVE broker adapter is registered;
   6. every gate check passes.

   No single mistake can start live trading.

7. **AI can only say no.** Risk parameters are never changed automatically from AI suggestions.

## 7. Research result (honest outcome)

The owner's LSFVG v1.0 was tested on genuine HistData 1-minute prices for EUR/USD, GBP/USD and
USD/JPY, 2010-01-03 → 2019-06-21. The test used ASTRA's real gate and costs (0.8 pip spread,
7 USD/lot, slippage), under a protocol committed **before** any result existed.

| After costs, 9.5 years | Model A (2R)                 | Model B (liquidity target)   |
| ---------------------- | ---------------------------- | ---------------------------- |
| Trades                 | 437                          | 363                          |
| Expectancy per trade   | −0.113 R                     | −0.184 R                     |
| Profit factor          | 0.83                         | 0.75                         |
| Total                  | −49.3 R (50,000 → 44,663.73) | −66.9 R (50,000 → 42,825.27) |
| Before costs           | +0.020 R per trade           | −0.059 R per trade           |

None of the 14 in-sample parameter variants was positive either. **Conclusion: no edge; nothing
is selected for trading.** Phase 5 is paused until the owner supplies a new strategy
(`docs/research/RESULTS-2026-09-29.md`).

## 8. Architecture in brief

- **Stack:**
  - pnpm monorepo, TypeScript 6 (strict), Node 22, Zod 4, decimal.js (money math) and Luxon
    (time zones; all stored times are UTC);
  - Fastify 5 API, PostgreSQL with plain SQL migrations, React 19 + Vite dashboard;
  - Vitest, ESLint (type-aware), Prettier.
- **Shape:** a modular monolith. The domain packages are pure and expose ports. `@astra/db`
  implements the storage ports. `apps/api` is the only place where everything is wired together.
  The dashboard only reads types from the domain packages and holds no secrets and no trading
  logic.

| Package / app                                    | Role                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `core`                                           | `Observed<T>`, modes, health, time, decimal math, schemas                               |
| `config`                                         | Versioned YAML loader, cross-checks, secret detection, config hash                      |
| `prop-firm`                                      | Rule profiles, account state engine, `canTrade` rule engine                             |
| `risk`                                           | Sizing, risk policy, account health, position monitor, protective closing               |
| `safety`                                         | Kill switches, component health registry, halt conditions                               |
| `decision`                                       | The fail-closed gate: context assembly, 22 checks, decision records                     |
| `execution`                                      | Broker adapter port, paper broker, execution gateway                                    |
| `market-data`                                    | Adapter port, quality guard, bars, snapshots, Yahoo free chart feed                     |
| `market-structure`                               | Swings, BOS/CHoCH, liquidity, FVG (complete bars only, no lookahead)                    |
| `calendar` · `news`                              | Provider ports, validation, event risk, news classification                             |
| `ai`                                             | Orchestrator, budget, call log, Claude adapter (veto-only context)                      |
| `strategy-lsfvg`                                 | The owner's LSFVG v1.0 strategy engine                                                  |
| `journal` · `learning` · `backtest` · `research` | Trade journal, learning metrics, backtests, research on real history                    |
| `db`                                             | Migrations, hash-chained audit log, repositories                                        |
| `apps/api`                                       | ASTRA Core service: REST/SSE, safety loop, orchestration                                |
| `apps/dashboard`                                 | Operator command center (21 pages, incl. Charts)                                        |
| `automation/n8n`                                 | 8 workflows: heartbeat, errors, news, calendar, signal webhook, alerts, reports, notify |

## 9. How to run it

```sh
corepack enable && pnpm install
cp .env.example .env              # DATABASE_URL + three tokens (openssl rand -hex 32)
ASTRA_SIMULATION=true pnpm dev    # paper sandbox on simulated prices: API :8080, dashboard :5173
ASTRA_FEEDS=yahoo pnpm dev        # or: real prices for charts (needs internet; never used to trade)
docker compose up -d --build      # full stack: Postgres, API, dashboard :3000, n8n :5678
pnpm check                        # format, lint, typecheck, all tests
```

Sign in to the dashboard with `ASTRA_OPERATOR_TOKEN`. Full runbook: `docs/DEPLOYMENT.md`.

## 10. What the owner still has to provide

1. Prop firm(s) and program(s), so their current published rules can be entered and verified.
2. Trading platform / broker. This decides the execution and live-quote adapters.
3. The broker's instrument specs: contract size, commission, spread, trading hours.
4. A strategy with an edge (LSFVG v1.0 did not have one).
5. Personal risk limits (review `config/risk-policies/`).
6. News RSS/Atom links, a calendar source and notification channels (Telegram, Discord or
   email).
7. Optional: an Anthropic API key and daily AI budget; 2020–2026 price history for further
   research.
8. For live trading, later: the owner's explicit authorization (ADR-0008).

## 11. Known limitations (main ones)

- Yahoo's free stream is unofficial and best effort; Yahoo's terms apply. Its real delay has
  not been measured yet, because the build environment has no internet access.
- Backtests know only 1-minute OHLC: the stop is assumed to be hit first inside a bar, and
  there is no historical news.
- The news classifier is keyword-based; errors lean towards blocking.
- Some tables have no retention policy yet: `market_bars`, `news_items`, `system_events`,
  `ai_model_calls`.
- Dashboard login is a bearer token; the hardening path is OIDC.

The full list (27 items) is in `docs/PROJECT_STATE.md`.

## 12. Where to read more

| Document                             | What it answers                             |
| ------------------------------------ | ------------------------------------------- |
| `docs/PROJECT_STATE.md`              | Detailed status, owner inputs, known issues |
| `docs/ARCHITECTURE.md`               | Full architecture (18 sections)             |
| `docs/adr/README.md`                 | The 26 design decisions and their reasons   |
| `docs/DEPLOYMENT.md`                 | Running locally, Docker, cloud, operations  |
| `docs/RESEARCH.md`, `docs/research/` | Research method, protocol, data and results |
| `config/README.md`                   | Configuration files and verification flags  |
| `automation/n8n/README.md`           | The n8n workflows                           |
| `THIRD_PARTY_NOTICES.md`             | Third-party licences and attributions       |

**Not in the repository (by design):**

- `node_modules/` — run `pnpm install`;
- `.env` and all secrets;
- the raw research price data (`research-data/`, about 571 MB). Its source, how to re-download
  it and its checksums are in `docs/research/data-histdata-2010-2019.md`.
