# ADR-0026: Free chart feed — Yahoo's public price stream, prices only

**Status:** Accepted · **Date:** 2026-09-29

## Context

The owner wants real market charts in ASTRA 24/7, fetched by ASTRA itself with low delay. The
data must be free and must not come from a funded or demo trading account. ASTRA's instruments
are FX majors (EURUSD, GBPUSD, USDJPY), CME equity-index futures (NQ, MNQ) and spot gold
(XAUUSD). Until now the only price sources were the simulation, HTTP ingestion and the
not-yet-chosen trading platform.

Options considered (from open-source clients on GitHub and the providers' public docs):

| Option                                             | Why not / why                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Broker / prop-platform feeds (MT5, cTrader, OANDA) | Need an account — explicitly excluded by the owner                                   |
| Keyed data APIs (Finnhub, Twelve Data, Polygon, …) | Need an account and API key; free tiers are rate-limited                             |
| Crypto exchange public streams (e.g. Binance)      | Free and keyless, but crypto only — none of ASTRA's instruments                      |
| TradingView                                        | No public data API (its charting library is free; its data is not)                   |
| **Yahoo Finance public stream + chart endpoint**   | **Keyless, free, covers FX (`=X`) and CME futures (`=F`), streams around the clock** |

The Yahoo protocol is taken from the open-source yfinance client (Apache-2.0,
`yfinance/live.py`, `yfinance/pricing.proto`). The decoder is checked against a genuine message
from yfinance's own test suite, so ASTRA reads the real wire format.

## Decision

- **Stream** (`@astra/market-data` `YahooStreamAdapter`): WebSocket
  `wss://streamer.finance.yahoo.com/?version=2`, subscribe with `{"subscribe":[…]}`, re-sent
  every 15 s. Messages are base64 `PricingData` protobuf, decoded by a small dependency-free
  decoder. Every message keeps the **provider's timestamp**. Its delay (receive time − provider
  time) is measured per symbol: last and maximum.
- **Prices only — never a quote.** A public, indicative price is not the price of the venue an
  order would go to. The adapter therefore never emits a tradable quote, even when a message
  carries a bid and ask: those are only counted (`withBidAsk`). Prices take a separate path
  (`MarketDataService.ingestPrice`). It uses the same symbol mapping, validation, source-kind
  binding, ordering and clock-skew rules as quotes, but it only builds bars and a
  `lastPrices()` view. `latest()` / `fresh()` stay UNAVAILABLE, so with this feed alone the gate
  rejects every trade (no quote → no trade). MARKET_DATA health keeps its status from tradable
  quotes and only mentions the chart feed in its detail.
- **Robust 24/7 connection:**
  - reconnect with exponential backoff (1 s … 60 s);
  - any socket error ends the connection. Node's WebSocket reports a failed handshake with an
    `error` and no `close` (observed in this environment), which would otherwise hang in
    "connecting";
  - a 30 s connect timeout;
  - reconnect after 5 min without any message (a silently dead socket);
  - health is ONLINE only while prices arrive. It is DEGRADED when the stream is silent or a
    symbol is delayed by more than `maxLagMs` (30 s), and ERROR after 5 failed reconnects.
- **History** (`yahooBackfill`): at start, the last 5 days of 1-minute candles from the public
  chart endpoint (`/v8/finance/chart/{symbol}?range=5d&interval=1m`).
  - Only complete, consistent, minute-aligned candles are kept. Nulls, inconsistent candles and
    the minute still in progress are dropped; FX volume 0 becomes null (unknown), never 0.
  - Coarser timeframes are rolled up only for whole periods inside the history (`rollUp`).
  - The bars are seeded into the same series the stream continues (source `yahoo`, kind `LIVE`)
    and stored. A failed request is logged and shown; the stream runs anyway.
- **Opt-in per deployment and per instrument:**
  - `ASTRA_FEEDS=yahoo` turns it on. It cannot be combined with `ASTRA_SIMULATION`, because
    simulated and real prices must never mix. Docker Compose defaults to `yahoo`.
  - Tuning lives in `marketData.feeds.yahoo` in `config/astra.yaml`.
  - Instruments opt in with `providerSymbols.yahoo`: EURUSD=X, GBPUSD=X, USDJPY=X, NQ=F, MNQ=F.
  - **XAUUSD is not mapped.** Yahoo has no spot-gold symbol (`XAUUSD=X` does not exist there),
    and `GC=F` is COMEX gold futures — a different price (basis). No chart is better than a
    proxy shown as spot.
- **Visibility:**
  - `GET /api/v1/market/feeds` gives connection state, per-symbol delay and history load;
    `GET /api/v1/market/prices` gives the latest prices.
  - The dashboard **Charts** page draws interactive candles with TradingView Lightweight
    Charts™ (Apache-2.0; attribution logo and link kept, notice in `THIRD_PARTY_NOTICES.md`),
    with the source, delay and a "prices only · not tradable" badge.

The feed code lives in `@astra/market-data` (`src/feeds/`) like the simulation adapter. It is
isomorphic, with no Node built-ins: it uses the runtime's `WebSocket` and `fetch`, both
injectable for tests. `apps/api/src/runtime/feeds.ts` wires it (symbols from `providerSymbols`,
history storage, status).

## Consequences

- ASTRA has real charts, structure and scanner bar metrics around the clock, with no account,
  key or cost. The rule-based strategies observe these bars, and every setup still meets the
  gate — which rejects it without a platform quote.
- **Limits (stated, not hidden):**
  - The stream is unofficial and best effort: no service guarantee, and it can change or stop
    without notice. The decoder then discards messages (counted and logged) rather than guessing.
  - Yahoo's terms of service apply; the owner must check that they fit the intended use.
  - FX prices are indicative (not a specific venue's bid/ask).
  - Exchange-traded futures may be delayed by exchange rules. ASTRA measures and shows this
    instead of assuming "real-time".
  - 1-minute history covers only the last days.
- The delay could not be measured from the development sandbox, where outbound connections are
  blocked. There, ASTRA reported `HTTP 403` for history and `ERROR … reconnect attempt 6` for
  the stream, which is the intended fail-honest behaviour. The owner's machine, or any host with
  internet access, shows the real delay on the Charts page.
- Trading still needs the execution platform's own quotes (Phase 2 remainder). Only then can
  MARKET_DATA be ONLINE for the gate.
