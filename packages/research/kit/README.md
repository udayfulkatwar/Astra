# LSFVG v1.0 research kit — run the strategy test anywhere

`lsfvg_kit.py` is one Python file that runs the owner's strategy (LSFVG v1.0, Model A and
Model B) on **your** price history with exactly ASTRA's rules. Those rules are the engine, the
0.25 % sizing, the owner's limits, costs and pessimistic fills. It writes a small results folder
that you send back.

- **Needs:** Python 3.9 or newer and nothing else (no packages, no internet).
- **Trust:** ASTRA's automated test runs this file and ASTRA's own code on the same data. It
  requires identical engine events and identical trades, to the cent.
- **Honesty rules:** it never invents, fills or repairs prices. Poor results are reported as they
  are. Fewer than 30 trades is reported as INSUFFICIENT DATA.

## 1. Quick start

```bash
# 0. Check that this Python reproduces ASTRA (must end with "selftest OK")
python3 lsfvg_kit.py selftest

# 1. Price data: EUR/USD, GBP/USD, USD/JPY, M1 bid + ask, 2020 → today (free, no account).
#    Takes a while and needs about 1 GB of disk. Writes research-data/manifest.json too.
python3 dukascopy_download.py --from 2020-01-01 --to 2026-09-27 --out research-data

# 2. The test (a few minutes; about 15–30 minutes with --sensitivity)
python3 lsfvg_kit.py run --manifest research-data/manifest.json \
    --from 2020-01-01 --to 2026-09-27 --oos 2024-01-01 --out lsfvg-results --sensitivity

# 3. Zip the folder lsfvg-results/ (1–3 MB) and send it back.
```

`dukascopy_download.py` is in `packages/research/scripts/`. If you already have data from
HistData.com or MetaTrader 5, skip step 1 and write a manifest (section 5).

**Too big to upload?** The M1 files come to about 1 GB. `compact` turns them into M5 files of
about 40 MB in total that give identical results:

```bash
python3 lsfvg_kit.py compact --manifest research-data/manifest.json --out research-m5
# then use --manifest research-m5/manifest.json
```

## 2. Running it with another AI model

Give the model three things: `lsfvg_kit.py`, this README, and the data (the `research-m5`
folder is the easiest to upload). Paste this instruction exactly:

> Run `python3 lsfvg_kit.py selftest`. It must print "selftest OK"; if it does not, stop and
> show me the full output. Then run
> `python3 lsfvg_kit.py run --manifest research-m5/manifest.json --from 2020-01-01 --to 2026-09-27 --oos 2024-01-01 --out lsfvg-results --sensitivity`.
> Do **not** edit, rewrite, re-implement, optimise or "improve" the script. Do not change any
> parameter, and do not clean, fill or resample the data. If anything fails, show me the exact
> error text. When it finishes, give me the folder `lsfvg-results` as a zip file.

Why this matters: a re-implemented strategy produces different trades. Only the unmodified
file is checked against ASTRA. The results record the kit version and a fingerprint (SHA-256)
of every input file.

## 3. What to send back

Send the zipped `lsfvg-results/` folder. It contains:

| File                           | What it is                                                                |
| ------------------------------ | ------------------------------------------------------------------------- |
| `report.md`                    | The readable report (§23 metrics, OOS, walk-forward, Monte Carlo, …)      |
| `summary.json`                 | Every number, the daily equity, the data coverage and the input checksums |
| `trades-A.csv`, `trades-B.csv` | Every trade after costs (and `-before-costs` versions)                    |
| `setups-A.csv`, `setups-B.csv` | Every setup, with the gate's decision and the checks that refused it      |
| `verify-sample-2024-03.csv.gz` | The M5 data of March 2024 (+3 weeks before), about 1 MB                   |

ASTRA then does three things:

- It re-runs its own engine and gate on the verification sample and compares the trades.
- It recomputes the metrics from the trade lists.
- It replays the daily equity against your prop firm's rules once they are known.

If you can only paste text, paste `report.md` and `summary.json`.

## 4. The strategy, exactly as the kit runs it

Prices: M5 candles (closed) drive everything. M15 and H1 candles are built from them, aligned to
the UTC clock. The strategy sees mid prices (bid + ask) / 2. Fills use the real bid and ask.
ATR is ATR(14) with Wilder smoothing. A swing is a strict 5-candle fractal: the high is above
the 2 highs on each side, and it is known only when the 2 candles on its right have closed. The
trading day ends at 17:00 New York.

LONG is described below; SHORT is the mirror image.

1. **H1 bias.** BULLISH when all of these hold:
   - the last two H1 swing highs rise;
   - the lowest swing low between them is above the swing low before the first of them;
   - the structure has not broken since: no later swing low below that higher low, and the last
     H1 close is still above it.

   BEARISH is the mirror image. Anything else is NEUTRAL, which means no trade. The last point
   is **default 2**.

2. **Liquidity (M15).** Four kinds of level:
   - the previous trading day's low;
   - the Asian-range low (00:00–06:00 UTC, usable from 06:00);
   - unswept M15 swing lows (the newest 40);
   - equal lows: two or more swing lows within 0.10 × M15 ATR of each other, taken at their
     lowest.
3. **Sweep.** An M15 candle trades below such a level. If one candle takes several levels, the
   strongest counts, in this order: previous day, Asian, equal, swing (**default 4**).
4. **Reclaim.** An M15 close back above the level, on the sweep candle or within the next 2 M15
   candles. Until then the sweep low extends. A later M15 low below the sweep low cancels the
   pattern.
5. **Displacement and structure.** A bullish M15 candle that meets all of these:
   - its body is at least 60 % of its range;
   - its body is at least 0.8 × M15 ATR (the ATR of the candles before it);
   - it closes above the most recent M15 swing high confirmed before the sweep. That is a CHoCH
     if that high was lower than the one before it, otherwise a BOS.

   It must come within 6 M15 candles of the sweep candle (**default 1**) and may be the reclaim
   candle itself.

6. **Fair value gap.** On the next M15 candle (c3), the high of the candle before the
   displacement (c1) is below c3's low. The FVG runs from c1's high to c3's low.
7. **Setup** at the close of c3, only with the H1 bias BULLISH:
   - **Entry:** a LIMIT order at the FVG midpoint (rounded to the tick), valid for 12 M5 candles
     (1 hour). If it is not filled, there is no trade; the price is never chased. An M5 close
     below the sweep low before the fill cancels the order.
   - **Stop:** the sweep low − 0.10 × M5 ATR, rounded down to the tick.
   - **Target, Model A:** entry + 2 × risk, rounded up.
   - **Target, Model B:** the nearest untouched buy-side level above c3's high that gives at
     least 2R (**default 3**). If there is none, there is no trade.
8. **Risk and limits** (ASTRA's gate):
   - Risk is 0.25 % of equity per trade. The size is in 0.01 lots, and the risk counts the stop
     distance plus a 5-tick slippage allowance plus commission.
   - At most 4 trades a day, and at most 2 per pair a day. Working orders count; missed or
     cancelled ones do not.
   - The day stops after a −1 % realised loss, or after 3 losses in a row of −0.9R or worse.
     ASTRA's risk policy also stops the day after 3 losses in a row of any size.
   - At most 2 positions or orders at once across the three pairs (they share USD), with combined
     open risk of 0.5 % or less. At most one per pair.
   - The spread must be at most 20 ticks (EUR/USD, USD/JPY) or 25 ticks (GBP/USD).
   - The market must be open, and the order's whole window must end at least 10 minutes before
     the daily close (17:00 New York).
   - No order window may end within 15 minutes of Friday 16:00 New York. Open positions are
     closed at Friday 16:00 New York (no weekend holding).
   - News blackout: ±30 minutes around HIGH-impact events of the pair's currencies. It applies
     only when a calendar file is supplied (section 5).
9. **Costs and fills** (pessimistic):
   - An order is active from the next candle.
   - A limit fills, at the limit, only when the ask (for a buy) trades 1 tick through it.
   - In the fill candle the stop counts but the target does not.
   - If one candle reaches both the stop and the target, the stop is assumed.
   - A stop gapped through at the open fills at the open.
   - Stop exits and protective closes pay 2 ticks of slippage.
   - Commission is 7 USD per lot round turn.
   - Spreads come from the ask data.

   "Before costs" means mid prices, touch fills, no slippage and no commission.

**Defaults 1–4** are the interpretations the owner accepted ("use your defaults") where the
strategy document is silent. The owner can still change them.

**Not included:** prop-firm rules. This is a _strategy study_: the firm is not known yet, so
there is no daily loss limit, drawdown limit, position cap or profit target, and the whole
history is traded. The weekend rule above is kept. Instrument specs (100k lots, 7 USD
commission) are UNVERIFIED templates. The score (out of 18) is recorded but does not filter
anything.

## 5. Your own data files (manifest)

`manifest.json` lists the files. Paths are relative to it; a folder means every
`.csv`/`.txt` file in it, and `.gz` files are fine. The Dukascopy downloader writes the
manifest for you.

```json
{
  "pairs": {
    "EURUSD": {
      "format": "dukascopy",
      "side": "BID",
      "files": ["eurusd-bid.csv"],
      "askFiles": ["eurusd-ask.csv"]
    },
    "GBPUSD": { "format": "histdata", "files": ["gbpusd"], "assumedSpreadTicks": 10 },
    "USDJPY": { "format": "mt5", "files": ["USDJPY_M1.csv"] }
  },
  "serverTime": "NY+7"
}
```

- `format`:
  - `dukascopy`: `timestamp,open,high,low,close` with the timestamp in epoch ms, UTC;
  - `histdata`: HistData "Generic ASCII" M1, in EST without daylight saving;
  - `mt5`: a MetaTrader 5 export with `<SPREAD>`;
  - `generic`: `time,open,high,low,close[,spread]` in UTC.
- `serverTime` (MT5 only): `"NY+7"` for the usual broker clock (UTC+2 in winter, UTC+3 in
  summer), or `{"utcOffsetMinutes": 120}`.
- `assumedSpreadTicks` is used only without ask data or a spread column (10 ticks = 1 pip). The
  report marks it as ASSUMED.
- Optional `calendar`: `{"file": "calendar.csv", "source": "…", "from": "2020-01-01T00:00:00Z", "to": "…"}`.
  The file has the columns `time,currency,impact,title` (UTC; impact HIGH/MEDIUM/LOW) and must
  list every HIGH event in the window. Without it the report says **NEWS FILTER NOT MODELLED**.

## 6. Commands

| Command                                                                                                      | What it does                                                                                   |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `selftest`                                                                                                   | Checks this Python reproduces ASTRA's trades on built-in synthetic test data (not market data) |
| `run --manifest M --from D --to D --oos D --out DIR [--sensitivity] [--models A,B] [--sample-month YYYY-MM]` | The study                                                                                      |
| `compact --manifest M --out DIR`                                                                             | M1 files → M5 files (gzip) with identical results                                              |
| `constants`                                                                                                  | Prints the built-in configuration (the same as ASTRA's `config/`)                              |
