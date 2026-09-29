# Third-party notices

ASTRA's own code is not derived from these projects except where stated. Each entry names what
ASTRA uses and under which licence.

## TradingView Lightweight Charts™ (dashboard Charts page)

- Package: `lightweight-charts` (npm), Apache License 2.0 —
  <https://github.com/tradingview/lightweight-charts>
- Attribution notice (from the project's NOTICE file, reproduced verbatim):

```text
TradingView Lightweight Charts™
Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/
```

- The chart keeps the TradingView attribution logo, and the Charts page links to
  <https://www.tradingview.com/>, as the licence's NOTICE requirement asks.
- Its dependency `fancy-canvas` is MIT-licensed.

## yfinance (Yahoo stream protocol reference and one test fixture)

- <https://github.com/ranaroussi/yfinance>, Apache License 2.0.
- ASTRA's Yahoo stream client (`packages/market-data/src/feeds/`) is an independent
  TypeScript implementation. It follows the protocol that yfinance documents in
  `yfinance/live.py` and `yfinance/pricing.proto` (stream URL, subscribe message, protobuf
  field numbers).
- One genuine stream message from yfinance's test suite (`tests/test_live.py`) is used as a
  test fixture: `packages/market-data/test/yahoo-fixtures.ts`, `YFINANCE_BTC_MESSAGE`.
- Yahoo Finance data itself is not covered by these licences: Yahoo's terms of service apply
  (see ADR-0026).
