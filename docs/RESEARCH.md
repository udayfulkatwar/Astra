# Research backtests — how to run them on real history

ASTRA's research tool (`@astra/research`, ADR-0025) replays genuine historical prices through
the owner's LSFVG v1.0 engine, ASTRA's real decision gate and a pessimistic broker, then
writes a report with the SPEC's §23 metrics and §21–§24 validation. It never downloads,
generates or repairs prices: it reads the files you give it.

## 1. Get the data (2020 → today, EUR/USD, GBP/USD, USD/JPY)

Any one of these works. Bid **and** ask are best: without ask data the spread is an
ASSUMPTION, and the report says so on every line it affects.

| Source                     | What you get                        | How                                                                                                                                                                                     |
| -------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dukascopy (free)           | M1 bid and ask, UTC                 | `python3 packages/research/scripts/dukascopy_download.py --from 2020-01-01 --to 2026-09-01 --out research-data` (Python standard library only; writes the CSVs **and** `manifest.json`) |
| HistData.com (free)        | M1 bid, EST without daylight saving | Download "Generic ASCII / 1 minute" per year and pair                                                                                                                                   |
| MetaTrader 5 (your broker) | M1 bid with spread                  | Symbols → Bars → Export; note your server's time zone                                                                                                                                   |

Put the files where ASTRA runs (for example `research-data/`, which Git ignores). In a cloud
session the host `datafeed.dukascopy.com` must be allowed in the environment's network settings
for the downloader to work.

The downloader is resumable. Each day file is cached as soon as it arrives, so re-running the
same command continues after a stop. `--max-minutes N` stops cleanly for tools that limit how
long a command runs. It assembles the CSVs and `manifest.json` only when every day is there
(exit code 0 = complete, 3 = run it again). It records every weekday the feed has no data for,
and every candle with inconsistent OHLC, in `download-log.json`; it never fills or repairs
anything.

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
six years. Data files may be gzip-compressed (`.gz`).

By default the run is a **strategy study**. The accounts' prop-firm profile is replaced by one
without firm limits: no daily loss limit, no drawdown limit short of a lost account, no position
caps and no profit target. The whole history is therefore traded, at 0.25 % of equity per trade
with the owner's strategy limits. The trading day (17:00 New York) and flat-before-the-weekend
are kept. `--prop-firm` runs the accounts' own profile instead: one evaluation attempt, which
stops at a breach or at the profit target. That is only meaningful once the owner's firm is
configured and verified.

## 4. Read the report (`research-out/report.md`, raw data in `study.json`)

For each model, the report gives:

- the data table and every assumption;
- after-costs and before-costs results, by pair, direction, session, year and month;
- in-sample vs out-of-sample;
- walk-forward windows;
- Monte Carlo drawdown odds;
- robustness: without the best year, pair or session, and without the 5 largest winners;
- sensitivity;
- the strategy funnel and the gate's refusals;
- the prop-firm section: a strategy study says that no firm limits were applied.

Fewer than 30 trades is reported as **INSUFFICIENT DATA**. The rules are frozen before the
run: the numbers are never used to pick parameters, and a poor result is reported as poor.

## 5. Run it somewhere else: the standalone kit

`packages/research/kit/lsfvg_kit.py` is the same study in one Python file (Python 3.9+, no
packages, no internet), for running on your own computer or with another tool.
`packages/research/kit/README.md` explains it step by step, including the exact instruction to
give another AI model.

- **Checked against ASTRA.** `packages/research/test/kit-parity.test.ts` runs the kit and ASTRA
  on the same synthetic test data. It requires identical engine events and identical trades to
  the cent: after costs, before costs, under sensitivity, and with dense scripted setups that hit
  every owner limit and the weekend close.
- **Selftest.** `python3 lsfvg_kit.py selftest` repeats that check on the user's machine.
- **Results.** Its results folder holds the report, every trade and setup, the daily equity,
  checksums of the input files, and a one-month data sample. ASTRA re-runs its own engine on
  that sample to cross-check.
- **Smaller data.** `compact` turns M1 files into M5 files (about 40 MB for all three pairs)
  that give identical results. ASTRA's CLI reads them too.
