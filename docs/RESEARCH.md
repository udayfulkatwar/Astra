# Research backtests — how to run them on real history

ASTRA's research tool (`@astra/research`, ADR-0025) replays genuine historical prices through
the owner's LSFVG v1.0 engine, ASTRA's real decision gate and a pessimistic broker, then
writes a report with the SPEC's §23 metrics and §21–§24 validation. It never downloads,
generates or repairs prices: it reads the files you give it.

## 1. Get the data (2020 → today, EUR/USD, GBP/USD, USD/JPY)

Any one of these works. Bid **and** ask are best: without ask data the spread is an
ASSUMPTION, and the report says so on every line it affects.

| Source                     | What you get                        | How                                                                                                                                               |
| -------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dukascopy (free)           | M1 bid and ask, UTC                 | `npx dukascopy-node -i eurusd -from 2020-01-01 -to 2026-09-01 -t m1 -p bid -f csv`, then the same with `-p ask` (see `npx dukascopy-node --help`) |
| HistData.com (free)        | M1 bid, EST without daylight saving | Download "Generic ASCII / 1 minute" per year and pair                                                                                             |
| MetaTrader 5 (your broker) | M1 bid with spread                  | Symbols → Bars → Export; note your server's time zone                                                                                             |

This cloud environment cannot reach those sites. Put the files where ASTRA runs (for example
`research-data/`, which Git ignores), or allow `datafeed.dukascopy.com` in the environment's
network settings so ASTRA can download them itself.

## 2. Describe the files (manifest)

`research-data/manifest.json` (paths are relative to it; a directory means all `.csv`/`.txt`
files in it):

```json
{
  "pairs": {
    "EURUSD": {
      "format": "dukascopy",
      "side": "BID",
      "files": ["eurusd-bid.csv"],
      "askFiles": ["eurusd-ask.csv"]
    },
    "GBPUSD": {
      "format": "histdata",
      "side": "BID",
      "files": ["gbpusd"],
      "assumedSpreadTicks": 10
    },
    "USDJPY": { "format": "mt5", "side": "BID", "files": ["USDJPY_M1.csv"] }
  },
  "serverTime": "NY+7"
}
```

- `format`: `dukascopy`, `histdata`, `mt5` or `generic`. `generic` is `time,open,high,low,close`
  in UTC, with the time as ISO 8601 or epoch.
- `serverTime` (MT5 only): `"NY+7"` for the common broker clock (UTC+2 in winter, UTC+3 in
  summer), or `{ "utcOffsetMinutes": 120 }`.
- `assumedSpreadTicks`: used only when there is no ask data. 10 ticks = 1 pip.
- Optional `calendar`: `{ "file": "calendar.csv", "source": "…", "from": "…", "to": "…" }`.
  The file has columns `time,currency,impact,title` in UTC. Without it, the report states
  **NEWS FILTER NOT MODELLED**.

## 3. Run

```bash
pnpm --filter @astra/research research -- --manifest research-data/manifest.json \
  --from 2020-01-01 --to 2026-09-01 --oos 2024-01-01 --out research-out --sensitivity
```

`--oos` is where the untouched out-of-sample part starts. `--models A` runs one model.
`--sensitivity` adds eleven harsher or neighbouring runs per model. It needs a few minutes for
six years.

## 4. Read the report (`research-out/report.md`, raw data in `study.json`)

For each model, the report gives:

- the data table and every assumption;
- after-costs and before-costs results, by pair, direction, session, year and month;
- in-sample vs out-of-sample;
- walk-forward windows;
- Monte Carlo drawdown odds;
- robustness: without the best year, pair or session, and without the 5 largest winners;
- sensitivity;
- the strategy funnel, the gate's refusals and the prop-firm (TEMPLATE) simulation.

Fewer than 30 trades is reported as **INSUFFICIENT DATA**. The rules are frozen before the
run: the numbers are never used to pick parameters, and a poor result is reported as poor.
