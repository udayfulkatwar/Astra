# ADR-0009: Market data — one ingestion service, quote-built bars, no fabrication

**Status:** Accepted · **Date:** 2026-09-27

## Context

Phase 2 needs quotes with freshness and quality checks, OHLC bars for the scanner (and later the
strategy engine), and a slot for real market-data providers. The owner has not chosen a trading
platform yet, so no provider-specific code can be written; the design must stay
provider-agnostic. The no-fabrication rule (ADR-0003) applies to derived data as well: a bar or
level that misrepresents the market is as dangerous as a guessed quote. The dashboard also wants
to run the same logic in the browser.

## Decision

- **New pure package `@astra/market-data`** (depends only on `@astra/core` and Zod; no Node
  built-ins, lint-enforced) holding the adapter port, the quote quality monitor, the bar
  aggregator, indicators and the market snapshot. `apps/api` only wires it (persistence, loops,
  routes); `@astra/db` implements its `BarStore` port.
- **One entry point for quotes:** `MarketDataService.ingest(quote, source, sourceKind)`, used by
  adapters (through a sink that never throws into the adapter) and by HTTP ingestion. Pipeline:
  provider symbol → ASTRA symbol via `instrument.providerSymbols[adapterId]` (unknown → rejected)
  → `QuoteSchema` (crossed/zero → rejected) → ordering (older than the latest quote, or dated
  beyond the clock-skew tolerance → ignored and counted) → quality → latest → bars → listeners.
  Each source is bound to one `DataSourceKind` (a SIMULATED source can never turn LIVE).
- **Quality:** a quote-to-quote mid move above `maxQuoteJumpTicks` marks the symbol SUSPECT for
  a configurable cooldown (default 60 s); meanwhile `latest()` returns `INVALID` ("abnormal price
  jump …") and the existing `data.quote` gate check rejects trades. Both sides of a jump are
  suspect, so the newest quote is always the reference and every further abnormal move restarts
  the cooldown. Reopen gaps trigger it too (fail-closed at the open).
- **Bars are built from observed quotes only** (price basis: last trade if reported, else mid),
  one series per symbol × source, for M1/M5/M15/M30/H1/H4 (UTC epoch alignment) and D1 (the
  instrument's trading day via `tradingHours.dayStart`, DST-safe; UTC midnight without trading
  hours). Periods without quotes have no bar (no carry-forward). Out-of-order prices are ignored
  and counted. A bar whose period began before the process started observing is **incomplete**
  and is discarded, never emitted, stored or shown — otherwise a restart at 10:00 would present
  the first observed price as the day's open and a partial range as the day's high/low.
- **Persistence:** only complete bars are written to `market_bars` (PK symbol, timeframe,
  open time, source), batched by the safety loop without delaying it; failures are logged and
  retried; the queue is bounded. At startup the aggregators are seeded from the newest stored bars
  (misaligned or duplicate seeds are rejected).
- **Snapshot contract** (`computeMarketSnapshot`, served by `GET /api/v1/market/scanner`): quote
  with freshness and quality applied, mid/spread (null unless the quote is OK), market status,
  active sessions, today/previous-day levels, change, per-session high/low (omitted when
  observation began after the session started), ATR(14) Wilder on complete H1/D1 bars (null with
  fewer than 15), quality status and bar counts. Anything not derivable is null.
- **MARKET_DATA health** is computed by the health probe from freshness of the instruments traded
  by ACTIVE accounts (decision policy `quoteMaxAgeMs`): ONLINE all fresh, DEGRADED some, UNKNOWN
  none. With `allowDegradedComponents: false`, a partial feed blocks every new trade.
- **Provider slot:** `MarketDataAdapter { id, kind, start(sink), stop(), health() }`. Today:
  `SimulationAdapter` (SIMULATED, paper only) and HTTP ingestion (MANUAL). A real adapter for the
  owner's platform must use provider timestamps, send provider symbols, reconnect with backoff,
  report health honestly and declare `LIVE` only for real-time data.

## Consequences

- - Every derived figure can be traced to observed quotes; missing data is visible as null, not
    hidden behind a plausible number.
- - The same aggregation and snapshot code runs in the core and in the browser.
- - Providers are swappable without touching the gate, the scanner or persistence.
- − After a restart, the current D1/H4/… bars (and session ranges) stay unavailable until the
  next period starts; ATR(14) on D1 needs 15 fully observed trading days. A provider history
  backfill (seeding with the provider's own complete bars) removes this once a platform is chosen.
- − Feed outages while running are not detected at bar level: bars spanning an outage contain only
  what was observed (the outage itself is visible live as STALE / MARKET_DATA not ONLINE).
- − Bad ticks enter bars (the system does not edit observed data); they are flagged by the
  quality monitor (`lastJumpAt`) and block trading for the cooldown.
