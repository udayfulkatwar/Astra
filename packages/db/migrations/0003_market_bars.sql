-- Phase 2 market data: completed OHLC bars built from observed quotes (or loaded from a
-- provider's history). Only COMPLETE bars are stored. A period without quotes has no row:
-- gaps are never filled. One series per source (a bar never mixes sources); prices are exact.
CREATE TABLE market_bars (
  symbol      text        NOT NULL,
  timeframe   text        NOT NULL CHECK (timeframe IN ('M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1')),
  open_time   timestamptz NOT NULL,
  close_time  timestamptz NOT NULL,
  open        numeric     NOT NULL CHECK (open > 0),
  high        numeric     NOT NULL,
  low         numeric     NOT NULL CHECK (low > 0),
  close       numeric     NOT NULL CHECK (close > 0),
  -- NULL when the source reports no volume (quote-built bars): never 0 as a stand-in.
  volume      numeric     NULL CHECK (volume IS NULL OR volume >= 0),
  tick_count  integer     NOT NULL CHECK (tick_count >= 0),
  source      text        NOT NULL,
  source_kind text        NOT NULL CHECK (source_kind IN ('LIVE', 'SIMULATED', 'HISTORICAL', 'MANUAL')),
  PRIMARY KEY (symbol, timeframe, open_time, source),
  CHECK (close_time > open_time),
  CHECK (low <= open AND low <= close AND high >= open AND high >= close)
);

-- Warm-up and chart queries read the newest bars of one symbol/timeframe.
CREATE INDEX market_bars_recent ON market_bars (symbol, timeframe, open_time DESC);
