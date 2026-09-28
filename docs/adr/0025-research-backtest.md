# ADR-0025: Research backtests on genuine history through the real gate

**Status:** Accepted · **Date:** 2026-09-28

## Context

The owner's strategy document (§20–§25, §28) requires the following before the strategy can
be believed:

- each pair tested on genuine 2020–2026 data, with realistic costs and fills;
- no lookahead;
- an untouched out-of-sample period, walk-forward, Monte Carlo, sensitivity and robustness
  checks;
- the §23 metrics before and after costs;
- honest reporting: INSUFFICIENT DATA when data is lacking, and poor results reported as they
  are.

The existing single-instrument backtest (ADR-0016) replays one symbol and uses market entries.

## Decision

- **`@astra/research`**, an isomorphic library plus a Node CLI (`scripts/research.ts`).
- **Data:**
  - It parses Dukascopy, HistData, MT5 and generic CSV files into UTC candles. Time zones are
    explicit: HistData is EST without daylight saving; MT5 uses a stated server offset or `NY+7`.
  - Invalid rows, duplicates and out-of-order rows are counted and dropped, never repaired.
  - M1 is aggregated to M5, and a missing minute is never invented.
  - Bid is paired with ask. Without ask data the spread is ASSUMED, and the report says so per
    pair.
- **Replay** (`runResearch`):
  - All pairs are merged in time order, with one LSFVG engine per pair, fed mid candles.
  - Every setup goes through the REAL gate (`assembleDecisionInputs` + `DecisionEngine`, mode
    BACKTEST in the simulator environment): the 0.25 % sizing, the owner limits
    (`strategy.limits`), the template prop-firm rules, and the calendar blackout when a
    historical calendar is supplied.
  - Prop-firm tracking, breach detection and ASTRA's automatic protection run as in paper
    trading, for example flattening before the template's weekly close.
  - Candles before the window only warm up the engines.
- **Broker** (`ResearchBroker`, pessimistic):
  - Orders become active from the next candle.
  - A resting LIMIT fills at its limit only when the entry side trades `limitThroughTicks`
    through it, in a candle that closes before the expiry; otherwise it is MISSED.
  - In the fill candle, the stop counts but the target does not.
  - When stop and target are hit in the same candle, the stop is assumed first.
  - A gapped stop fills at the open. Stops and protective closes pay slippage.
  - Commission is charged at entry, and money is valued in USD at fill and exit time.
  - "Before costs" means mid prices, touch fills, no slippage and no commission.
- **Validation:**
  - The report gives the §23 metrics by pair, direction, session, year and month.
  - The in-sample / out-of-sample split is at a date the owner chooses.
  - Walk-forward uses 6-month windows and reports the share of windows with positive
    expectancy.
  - Monte Carlo is a seeded bootstrap of trade R (total R, drawdown percentiles, chance of
    reaching 4 / 8 / 12 / 20 R).
  - Robustness removes the best year, pair or session, or the 5 largest winners.
  - Sensitivity covers spread × 1.5 / × 2, slippage, limit-through ticks and nearby engine
    parameters. It measures stability only and never chooses anything.
  - Fewer than 30 trades is reported as INSUFFICIENT DATA.

## Consequences

- The strategy's evidence comes from the same code that trades: engine, gate, limits,
  protection.
- This environment cannot download market data (its network policy blocks the data hosts). The
  owner supplies files, or allows a data host, and the report is produced from them.
  `docs/RESEARCH.md` explains how.
- Prop-firm pass/fail is not claimed while the profile is a TEMPLATE. With the owner's firm
  rules entered and verified, the same replay simulates the real account.
- Headline news is not modelled historically; only a supplied economic calendar is. Every
  report states which.
