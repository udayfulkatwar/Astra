#!/usr/bin/env python3
"""
LSFVG v1.0 research kit — ASTRA's strategy engine and research replay in one Python file.

Needs only Python 3.9+ (standard library; no packages, no internet). It reads your price files,
runs the owner's strategy (Model A and Model B) through the same rules ASTRA uses — engine,
0.25 % sizing, the owner's limits, costs, pessimistic fills — and writes a small results folder
to send back. ASTRA's automated test (packages/research/test/kit-parity.test.ts) checks that this
file produces exactly the trades ASTRA's own code produces.

    python3 lsfvg_kit.py selftest
    python3 lsfvg_kit.py run --manifest research-data/manifest.json \\
        --from 2020-01-01 --to 2026-09-27 --oos 2024-01-01 --out lsfvg-results [--sensitivity]

The manifest is ASTRA's research manifest (docs/RESEARCH.md); the Dukascopy downloader
(packages/research/scripts/dukascopy_download.py) writes one. See README.md next to this file.

Honesty rules (the owner's): nothing here invents, fills or repairs prices; poor results are
reported as they are; fewer than 30 trades is INSUFFICIENT DATA. This is a STRATEGY STUDY: no
prop-firm rules are applied (the firm is not known yet) — see README.md.
"""
import argparse
import datetime as dt
import gzip
import hashlib
import json
import math
import os
import re
import sys
import time
from decimal import ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_EVEN, Context, Decimal, setcontext

KIT_VERSION = "1.0.0"

# decimal.js as ASTRA configures it: 40 significant digits, half-even.
setcontext(Context(prec=40, rounding=ROUND_HALF_EVEN, Emin=-999999, Emax=999999))

M1 = 60_000
M5 = 300_000
M15 = 900_000
HOUR = 3_600_000
DAY = 86_400_000

# ---------------------------------------------------------------------------------------------
# Configuration — copied from ASTRA's config/ (the parity test checks these against it).
# Instrument specs are UNVERIFIED templates (100k lots, 5/3 digits, 7 USD per lot round turn).
# ---------------------------------------------------------------------------------------------

INSTRUMENTS = {
    "EURUSD": {"tickSize": 0.00001, "tickValue": 1.0, "quoteCurrency": "USD", "commission": 7.0,
               "slippageAllowanceTicks": 5, "maxSpreadTicks": 20, "quantityStep": 0.01,
               "minQuantity": 0.01, "eventCurrencies": ["EUR", "USD"]},
    "GBPUSD": {"tickSize": 0.00001, "tickValue": 1.0, "quoteCurrency": "USD", "commission": 7.0,
               "slippageAllowanceTicks": 5, "maxSpreadTicks": 25, "quantityStep": 0.01,
               "minQuantity": 0.01, "eventCurrencies": ["GBP", "USD"]},
    "USDJPY": {"tickSize": 0.001, "tickValue": 100.0, "quoteCurrency": "JPY", "commission": 7.0,
               "slippageAllowanceTicks": 5, "maxSpreadTicks": 20, "quantityStep": 0.01,
               "minQuantity": 0.01, "eventCurrencies": ["USD", "JPY"]},
}
SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY"]  # the strategy's order (same-candle priority)
# Where each pair's price has plausibly been (a guard against mislabelled files, not a filter).
PLAUSIBLE = {"EURUSD": (0.5, 2.5), "GBPUSD": (0.8, 3.0), "USDJPY": (50.0, 300.0)}
ACCOUNT_CURRENCY = "USD"
STARTING_BALANCE = 50_000  # the account size of the template profile the accounts use

# FX market hours (America/New_York): Sun 17:05 – Fri 17:00 with a daily 17:00–17:05 break.
MARKET_WEEK = [((7, 17, 5), (1, 17, 0)), ((1, 17, 5), (2, 17, 0)), ((2, 17, 5), (3, 17, 0)),
               ((3, 17, 5), (4, 17, 0)), ((4, 17, 5), (5, 17, 0))]  # (isoweekday, hour, minute)

STRATEGY = {
    "minRewardToRisk": 2,
    "maxRiskPercentPerTrade": 0.25,
    "maxTradesPerDay": 4,
    "signalTtlSeconds": 120,
    "eventBlackout": {"impactLevels": ["HIGH"], "minutesBefore": 30, "minutesAfter": 30},
    "maxEntriesPerSymbolPerDay": 2,
    "dailyRealizedLossStopPercent": 1,
    "fullRiskLosses": {"atOrBelowR": -0.9, "maxConsecutive": 3},
    "correlation": [{"id": "usd", "symbols": ["EURUSD", "GBPUSD", "USDJPY"],
                     "maxOpenPositions": 2, "maxOpenRiskPercent": 0.5}],
}
RISK_POLICY = {
    "riskPercentOfEquity": 0.25, "minRewardToRisk": 2,
    "maxDailyBufferUsePct": 40, "maxDrawdownBufferUsePct": 20, "survivalBufferAmount": 150,
    "maxOpenRiskPercentOfEquity": 0.5, "maxOpenPositions": 2, "maxPositionsPerInstrument": 1,
    "allowPyramiding": False, "maxTradesPerDay": 4, "maxConsecutiveLosses": 3,
    "cautionUsagePct": 40, "restrictedUsagePct": 70, "breachRiskUsagePct": 85,
    "cautionSizeMultiplier": 0.5, "noNewTradesMinutesBeforeFlat": 15,
}
SYSTEM = {
    "minMinutesBeforeMarketClose": 10, "maxWorkingOrderMinutes": 240,
    "eventBlackout": {"impactLevels": ["HIGH"], "minutesBefore": 15, "minutesAfter": 15},
    "lateObservationThresholdMs": 300_000, "flattenMinutesBeforeFlat": 2,
    "flattenAtLimitUsagePct": 90,
}
# The strategy study keeps the template profile's holding rules: no weekend holding, weekly
# close Friday 16:00 New York; the trading day ends at 17:00 New York.
WEEKLY_CLOSE = (5, 16, 0)
TRADING_DAY_RESET = (17, 0)

DEFAULT_PARAMS = {
    "atrPeriod": 14, "displacementBodyToRange": 0.6, "displacementBodyToAtr": 0.8,
    "equalLevelAtrFraction": 0.1, "stopAtrFraction": 0.1, "reclaimCandles": 2,
    "displacementWindowCandles": 6, "entryWaitM5Candles": 12, "minRewardToRisk": 2,
    "modelBTarget": "NEAREST_WITH_MIN_RR", "asianStartUtc": (0, 0), "asianEndUtc": (6, 0),
    "maxSwingLevels": 40,
}

REALISTIC_COSTS = {"slippageTicks": 2, "limitThroughTicks": 1, "commission": True, "spreadMultiplier": 1}
NO_COSTS = {"slippageTicks": 0, "limitThroughTicks": 0, "commission": False, "spreadMultiplier": 0}

SENSITIVITY = [
    ("spread × 1.5", {"spreadMultiplier": 1.5}, {}),
    ("spread × 2", {"spreadMultiplier": 2}, {}),
    ("slippage 5 ticks", {"slippageTicks": 5}, {}),
    ("limit fills 3 ticks through", {"limitThroughTicks": 3}, {}),
    ("limit fills on touch", {"limitThroughTicks": 0}, {}),
    ("displacement ≥ 0.7 × ATR", {}, {"displacementBodyToAtr": 0.7}),
    ("displacement ≥ 0.9 × ATR", {}, {"displacementBodyToAtr": 0.9}),
    ("displacement window 4 candles", {}, {"displacementWindowCandles": 4}),
    ("displacement window 8 candles", {}, {"displacementWindowCandles": 8}),
    ("entry wait 6 M5 candles", {}, {"entryWaitM5Candles": 6}),
    ("entry wait 18 M5 candles", {}, {"entryWaitM5Candles": 18}),
]
MIN_TRADES_FOR_STATISTICS = 30

# ---------------------------------------------------------------------------------------------
# Number helpers: decimal.js and JavaScript semantics, so results match ASTRA to the cent.
# ---------------------------------------------------------------------------------------------


def D(x):
    """A decimal from a number exactly as decimal.js reads a JS number (shortest round trip)."""
    if isinstance(x, Decimal):
        return x
    if isinstance(x, int):
        return Decimal(x)
    return Decimal(repr(float(x)))


def floor_step(v, step):
    return (v / step).to_integral_value(ROUND_FLOOR) * step


def ceil_step(v, step):
    return (v / step).to_integral_value(ROUND_CEILING) * step


def to_num(v, dp=8):
    return float(v.quantize(Decimal(1).scaleb(-dp), rounding=ROUND_HALF_EVEN)) + 0.0


def money(v):
    return to_num(v, 2)


def js_round(x):
    """Math.round: halves go up (towards +∞)."""
    r = math.floor(x)
    return r + 1 if x - r >= 0.5 else r


def round_dp(x, dp=2):
    f = 10 ** dp
    return js_round(x * f) / f


def js_str(x):
    """A number as JavaScript prints it (integers without '.0')."""
    if isinstance(x, float) and x.is_integer() and abs(x) < 1e21:
        return str(int(x))
    return repr(x)


def iso(ms):
    s = dt.datetime.fromtimestamp(ms // 1000, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    return f"{s}.{ms % 1000:03d}Z"


def parse_iso_ms(s):
    return int(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)


# ---------------------------------------------------------------------------------------------
# New York time (US daylight saving rules since 2007: second Sunday of March 02:00 → first
# Sunday of November 02:00). Built in so no time-zone package is needed.
# ---------------------------------------------------------------------------------------------

_DST_CACHE = {}


def _nth_sunday(year, month, n):
    d = dt.date(year, month, 1)
    d += dt.timedelta(days=(6 - d.weekday()) % 7)
    return d + dt.timedelta(weeks=n - 1)


def _dst(year):
    b = _DST_CACHE.get(year)
    if b is None:
        if year < 2007:
            raise ValueError("New York time is built in for 2007 onwards only")
        s = _nth_sunday(year, 3, 2)
        e = _nth_sunday(year, 11, 1)
        start = int(dt.datetime(s.year, s.month, s.day, 7, tzinfo=dt.timezone.utc).timestamp() * 1000)
        end = int(dt.datetime(e.year, e.month, e.day, 6, tzinfo=dt.timezone.utc).timestamp() * 1000)
        b = _DST_CACHE[year] = (start, end, s, e)
    return b


def ny_offset_ms(utc_ms):
    year = dt.datetime.fromtimestamp(utc_ms // 1000, dt.timezone.utc).year
    start, end, _, _ = _dst(year)
    return -4 * HOUR if start <= utc_ms < end else -5 * HOUR


def ny_local(utc_ms):
    """Local New York wall time as a naive datetime (with milliseconds)."""
    return dt.datetime(1970, 1, 1) + dt.timedelta(milliseconds=utc_ms + ny_offset_ms(utc_ms))


def ny_to_utc(date, hour, minute):
    """UTC ms of a New York wall time (times at or after 02:00; the ones used here)."""
    local = int(dt.datetime(date.year, date.month, date.day, hour, minute, tzinfo=dt.timezone.utc)
                .timestamp() * 1000)
    guess = local + 5 * HOUR
    if ny_offset_ms(guess) == -4 * HOUR:
        guess = local + 4 * HOUR
    return guess


_WINDOW = [None]


def trading_day_window(utc_ms):
    """(key, start_ms, end_ms) of the trading day ending 17:00 New York (ASTRA's tradingDayWindow)."""
    w = _WINDOW[0]
    if w and w[1] <= utc_ms < w[2]:
        return w
    local = ny_local(utc_ms)
    date = local.date()
    if (local.hour, local.minute, local.second, local.microsecond) < (TRADING_DAY_RESET[0], TRADING_DAY_RESET[1], 0, 0):
        date -= dt.timedelta(days=1)
    start = ny_to_utc(date, *TRADING_DAY_RESET)
    nxt = date + dt.timedelta(days=1)
    end = ny_to_utc(nxt, *TRADING_DAY_RESET)
    w = (nxt.isoformat(), start, end)
    _WINDOW[0] = w
    return w


def next_weekly_time(utc_ms, weekday, hour, minute):
    """Next occurrence (at or after the instant) of a weekly New York time (isoweekday)."""
    local = ny_local(utc_ms)
    cand = dt.datetime(local.year, local.month, local.day, hour, minute)
    cand += dt.timedelta(days=(weekday - cand.isoweekday() + 7) % 7)
    if cand < local:
        cand += dt.timedelta(days=7)
    return ny_to_utc(cand.date(), hour, minute)


def last_weekly_time(utc_ms, weekday, hour, minute):
    d = next_weekly_time(utc_ms - 8 * DAY, weekday, hour, minute)
    later = next_weekly_time(d + M1, weekday, hour, minute)
    return later if later <= utc_ms else d


def market_status(utc_ms):
    """(open, next_close_ms, minutes_to_close) of the FX market (ASTRA's marketStatus)."""
    local = ny_local(utc_ms)
    m = ((local.isoweekday() - 1) * 1440 + local.hour * 60 + local.minute) % 10080
    for (od, oh, om), (cd, ch, cm) in MARKET_WEEK:
        o = (od - 1) * 1440 + oh * 60 + om
        c = (cd - 1) * 1440 + ch * 60 + cm
        inside = (o <= m < c) if c > o else (m >= o or m < c)
        if inside:
            close = next_weekly_time(utc_ms, cd, ch, cm)
            return True, close, (close - utc_ms) / 60_000
    return False, None, None


# ---------------------------------------------------------------------------------------------
# Data: ASTRA's parsers (packages/research/src/data.ts). Genuine files only; invalid rows are
# counted and dropped, never repaired; a missing minute is never invented.
# ---------------------------------------------------------------------------------------------


def _num(s):
    s = (s or "").strip()
    if s == "":
        return 0.0  # JavaScript: Number('') is 0
    try:
        v = float(s)
    except ValueError:
        return math.nan
    return v if math.isfinite(v) else math.nan


def _valid(o, h, l, c):
    return o > 0 and h > 0 and l > 0 and c > 0 and l <= min(o, c) and h >= max(o, c)


_NUMERIC = re.compile(r"^\d+(\.\d+)?$")
_ZONE = re.compile(r"([zZ]|[+-]\d\d:?\d\d)$")


def _generic_time(s):
    v = s.strip()
    if _NUMERIC.match(v):
        n = float(v)
        return n if n > 1e12 else n * 1000
    if not _ZONE.search(v):
        v = v.replace(" ", "T", 1) + "Z"
    # ISO-8601 end-of-day `24:00[:00[.000]]` = the NEXT midnight of the (validated) date; Python's
    # fromisoformat rejects it, so it is handled here (mirrors genericTime in data.ts). Any other
    # hour-24 time stays invalid.
    extra = 0
    eod = re.match(r"^(\d{4}-\d{2}-\d{2})[T ]24:00(?::00(?:[.,]0+)?)?(?=$|[zZ]|[+-]\d\d:?\d\d$)", v)
    if eod:
        v = v[:10] + "T00:00:00" + v[eod.end():]
        extra = 86_400_000
    try:
        v2 = v[:-1] + "+00:00" if v[-1] in "zZ" else v
        if re.search(r"[+-]\d\d\d\d$", v2):
            v2 = v2[:-2] + ":" + v2[-2:]
        return dt.datetime.fromisoformat(v2).timestamp() * 1000 + extra
    except ValueError:
        return math.nan


def _utc_ms(y, mo, d, hh=0, mm=0, ss=0):
    """Epoch ms (UTC) of a calendar date/clock, or NaN when ANY component is impossible (never
    shifted or repaired; mirrors `utcMs` in packages/research/src/data.ts)."""
    try:
        return int(dt.datetime(y, mo, d, hh, mm, ss, tzinfo=dt.timezone.utc).timestamp() * 1000)
    except (ValueError, OverflowError):
        return math.nan


_MT5_DATE = re.compile(r"^(\d{4})\.(\d{1,2})\.(\d{1,2})$", re.ASCII)
_MT5_TIME = re.compile(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?$", re.ASCII)


def _mt5_time(date, tm, server):
    if server is None:
        return math.nan
    dm, tmm = _MT5_DATE.match(date.strip()), _MT5_TIME.match(tm.strip())
    if not dm or not tmm:
        return math.nan
    wall = _utc_ms(int(dm[1]), int(dm[2]), int(dm[3]), int(tmm[1]), int(tmm[2]), int(tmm[3] or 0))
    if not math.isfinite(wall):
        return math.nan
    if server == "NY+7":
        # Server clock = New York time + 7 h: read it as New York wall time, then subtract 7 h.
        try:
            guess = wall + 5 * HOUR
            if ny_offset_ms(guess) == -4 * HOUR:
                guess = wall + 4 * HOUR
        except ValueError:
            return math.nan  # outside the built-in New York rules (pre-2007): counted invalid
        return guess - 7 * HOUR
    return wall - server * M1


def parse_bars(path, fmt, server_time=None):
    """One file → (sorted, de-duplicated bars [(t, o, h, l, c, spread|None)], report)."""
    opener = gzip.open if path.endswith(".gz") else open
    out = []
    examples = []
    invalid = 0
    rows = 0
    header = None
    with opener(path, "rt", encoding="utf-8", newline="") as f:
        for raw in f:
            line = raw.rstrip("\r\n")
            if line.strip() == "":
                continue
            sep = "\t" if "\t" in line else (";" if ";" in line else ",")
            fl = [x.strip() for x in line.split(sep)]
            if fmt in ("generic", "dukascopy", "mt5") and header is None and any(
                    re.search(r"[a-zA-Z<]", x) and not re.match(r"^\d", x) for x in fl):
                header = [x.replace("<", "").replace(">", "").lower() for x in fl]
                continue
            rows += 1
            sp = None

            def bad(why):
                nonlocal invalid
                invalid += 1
                if len(examples) < 5:
                    examples.append(f"{why}: {line[:80]}")

            if fmt == "histdata":
                m = re.match(r"^(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})(\d{2})$", fl[0] if fl else "", re.ASCII)
                if not m:
                    bad("unreadable time")
                    continue
                # An impossible calendar date/clock is unreadable (counted invalid), never shifted.
                t = _utc_ms(int(m[1]), int(m[2]), int(m[3]), int(m[4]), int(m[5]), int(m[6])) + 5 * HOUR
                g = lambda k: fl[k] if k < len(fl) else ""  # noqa: E731
                o, h, lo, c = _num(g(1)), _num(g(2)), _num(g(3)), _num(g(4))
            elif fmt == "mt5":
                def idx(name, fb):
                    return header.index(name) if header and name in header else fb
                g = lambda k: fl[k] if k < len(fl) else ""  # noqa: E731
                t = _mt5_time(g(idx("date", 0)), g(idx("time", 1)), server_time)
                o, h, lo, c = (_num(g(idx("open", 2))), _num(g(idx("high", 3))),
                               _num(g(idx("low", 4))), _num(g(idx("close", 5))))
                s = _num(g(idx("spread", 8)))
                if math.isfinite(s):
                    sp = s
                if server_time is None:
                    bad("MT5 server time zone not given")
                    continue
            else:
                def idx(names, fb):
                    for n in names:
                        if header and n in header:
                            return header.index(n)
                    return fb
                g = lambda k: fl[k] if k < len(fl) else ""  # noqa: E731
                t = _generic_time(g(idx(["time", "timestamp", "date", "datetime", "gmt time"], 0)))
                o, h, lo, c = (_num(g(idx(["open"], 1))), _num(g(idx(["high"], 2))),
                               _num(g(idx(["low"], 3))), _num(g(idx(["close"], 4))))
                si = header.index("spread") if header and "spread" in header else -1
                if si >= 0 and math.isfinite(_num(g(si))):
                    sp = _num(g(si))
            if not math.isfinite(t):
                bad("unreadable time")
                continue
            if not _valid(o, h, lo, c):
                bad("invalid OHLC")
                continue
            out.append((int(t), o, h, lo, c, sp))
    out_of_order = sum(1 for i in range(1, len(out)) if out[i][0] < out[i - 1][0])
    if out_of_order:
        out.sort(key=lambda b: b[0])  # stable, like Array.prototype.sort
    bars = []
    dups = 0
    for b in out:
        if bars and bars[-1][0] == b[0]:
            dups += 1
            continue
        bars.append(b)
    return bars, {"rows": rows, "parsed": len(bars), "invalid": invalid, "duplicates": dups,
                  "outOfOrder": out_of_order, "examples": examples}


def detect_minutes(bars):
    counts = {}
    for i in range(1, min(len(bars), 5000)):
        d = (bars[i][0] - bars[i - 1][0]) / M1
        counts[d] = counts.get(d, 0) + 1
    best = None
    for k, v in counts.items():
        if best is None or v > best[1]:
            best = (k, v)
    return best[0] if best else None


def to_m5(bars):
    out = []
    cur = None
    for t0, o, h, lo, c, sp in bars:
        t = (t0 // M5) * M5
        if cur is not None and cur[0] != t:
            out.append(tuple(cur))
            cur = None
        if cur is None:
            cur = [t, o, h, lo, c, sp]
        else:
            cur[2] = max(cur[2], h)
            cur[3] = min(cur[3], lo)
            cur[4] = c
            if sp is not None:
                cur[5] = max(cur[5] if cur[5] is not None else 0, sp)
    if cur is not None:
        out.append(tuple(cur))
    return out


def load_side(files, fmt, server_time, log):
    by_t = {}
    reports = []
    for path in files:
        bars, rep = parse_bars(path, fmt, server_time)
        reports.append(rep)
        minutes = detect_minutes(bars)
        m5 = bars if minutes == 5 else to_m5(bars)
        for b in m5:
            prev = by_t.get(b[0])
            by_t[b[0]] = (b[0], prev[1], max(prev[2], b[2]), min(prev[3], b[3]), b[4], None) if prev else b
        log(f"  {path}: {rep['parsed']} rows ({js_str(minutes) if minutes is not None else '?'} min), {rep['invalid']} invalid")
    return [by_t[k] for k in sorted(by_t)], reports


def pair_sides(side, primary, ask, tick, assumed_ticks):
    """[(t, bid_ohlc, ask_ohlc, spread_source)] — ASTRA's pairSides."""
    ask_at = {b[0]: b for b in (ask or [])}

    def rnd(x):
        return js_round(x / tick) * tick

    out = []
    for p in primary:
        a = ask_at.get(p[0])
        po = (p[1], p[2], p[3], p[4])
        if a is not None and side == "BID":
            out.append((p[0], po, (a[1], a[2], a[3], a[4]), "DATA"))
            continue
        ticks = p[5] if p[5] is not None else assumed_ticks
        src = "DATA" if p[5] is not None else "ASSUMED"
        spread = ticks * tick

        def shift(d):
            return (rnd(po[0] + d), rnd(po[1] + d), rnd(po[2] + d), rnd(po[3] + d))

        if side == "MID":
            out.append((p[0], shift(-spread / 2), shift(spread / 2), src))
        else:
            out.append((p[0], po, shift(spread), src))
    return out


def coverage(symbol, bars):
    gaps = 0
    largest = 0
    for i in range(1, len(bars)):
        gap = (bars[i][0] - bars[i - 1][0]) / M1
        if gap <= 30:
            continue
        day = (dt.datetime.fromtimestamp(bars[i - 1][0] // 1000, dt.timezone.utc).weekday() + 1) % 7
        if gap >= 24 * 60 and day in (5, 6, 0):
            continue
        gaps += 1
        largest = max(largest, gap)
    return {
        "symbol": symbol,
        "from": iso(bars[0][0]) if bars else None,
        "to": iso(bars[-1][0] + M5) if bars else None,
        "bars": len(bars),
        "gaps": gaps,
        "largestGapMinutes": largest,
        "spreadFromData": sum(1 for b in bars if b[3] == "DATA"),
        "spreadAssumed": sum(1 for b in bars if b[3] == "ASSUMED"),
    }


def expand(base, entries):
    out = []
    for e in entries:
        p = os.path.join(base, e)
        if not os.path.exists(p):
            raise SystemExit(f"data file not found: {p}")
        if os.path.isdir(p):
            out.extend(os.path.join(p, f) for f in sorted(os.listdir(p))
                       if re.search(r"\.(csv|txt)(\.gz)?$", f, re.I))
        else:
            out.append(p)
    return out


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------------------------
# The LSFVG v1.0 engine (packages/strategy-lsfvg): closed M5 candles in, setups out.
# ---------------------------------------------------------------------------------------------


class Candle:
    __slots__ = ("open_ms", "close_ms", "o", "h", "l", "c", "i")

    def __init__(self, open_ms, close_ms, o, h, l, c, i=0):
        self.open_ms, self.close_ms, self.o, self.h, self.l, self.c, self.i = open_ms, close_ms, o, h, l, c, i


class Aggregator:
    def __init__(self, period):
        self.period = period
        self.cur = None

    def push(self, m5):
        out = []
        start = (m5.open_ms // self.period) * self.period
        if self.cur is not None and self.cur[0] != start:
            out.append(self._emit())
        if self.cur is None:
            self.cur = [start, m5.o, m5.h, m5.l, m5.c]
        else:
            self.cur[2] = max(self.cur[2], m5.h)
            self.cur[3] = min(self.cur[3], m5.l)
            self.cur[4] = m5.c
        if m5.close_ms >= start + self.period:
            out.append(self._emit())
        return out

    def _emit(self):
        s, o, h, l, c = self.cur
        self.cur = None
        return Candle(s, s + self.period, o, h, l, c)


class Atr:
    def __init__(self, period):
        self.period = period
        self.prev_close = None
        self.seed = []
        self.value = None

    def push(self, c):
        if self.prev_close is not None:
            tr = max(c.h - c.l, abs(c.h - self.prev_close), abs(c.l - self.prev_close))
            if self.value is None:
                self.seed.append(tr)
                if len(self.seed) == self.period:
                    s = 0
                    for x in self.seed:
                        s += x
                    self.value = s / self.period
                    self.seed = []
            else:
                self.value = (self.value * (self.period - 1) + tr) / self.period
        self.prev_close = c.c


class Swing:
    __slots__ = ("kind", "price", "time", "confirmed")

    def __init__(self, kind, price, time_ms, confirmed_ms):
        self.kind, self.price, self.time, self.confirmed = kind, price, time_ms, confirmed_ms


class SwingDetector:
    def __init__(self):
        self.last = []

    def push(self, c):
        self.last.append(c)
        if len(self.last) > 5:
            self.last.pop(0)
        if len(self.last) < 5:
            return []
        a, b, m, d, e = self.last
        out = []
        if m.h > a.h and m.h > b.h and m.h > d.h and m.h > e.h:
            out.append(Swing("HIGH", m.h, m.open_ms, e.close_ms))
        if m.l < a.l and m.l < b.l and m.l < d.l and m.l < e.l:
            out.append(Swing("LOW", m.l, m.open_ms, e.close_ms))
        return out


def _trend(up, extremes, pivots, last_close):
    if len(extremes) < 2:
        return False
    last, previous = extremes[-1], extremes[-2]
    between = [p for p in pivots if previous.time < p.time < last.time]
    before_all = [p for p in pivots if p.time < previous.time]
    if not between or not before_all:
        return False
    pivot = between[0]
    for p in between[1:]:
        if (p.price < pivot.price) if up else (p.price > pivot.price):
            pivot = p
    before = before_all[-1]
    extremes_ok = last.price > previous.price if up else last.price < previous.price
    pivot_ok = pivot.price > before.price if up else pivot.price < before.price
    if not extremes_ok or not pivot_ok:
        return False
    broken = any(p.time > last.time and (p.price < pivot.price if up else p.price > pivot.price)
                 for p in pivots)
    closed_through = last_close < pivot.price if up else last_close > pivot.price
    return not (broken or closed_through)


def assess_bias(highs, lows, last_close):
    if last_close is None:
        return "NEUTRAL"
    bull = _trend(True, highs, lows, last_close)
    bear = _trend(False, lows, highs, last_close)
    if bull and bear:
        return "NEUTRAL"
    return "BULLISH" if bull else ("BEARISH" if bear else "NEUTRAL")


class Level:
    __slots__ = ("type", "side", "price", "formed", "swept")

    def __init__(self, type_, side, price, formed_ms, swept=False):
        self.type, self.side, self.price, self.formed, self.swept = type_, side, price, formed_ms, swept


PRIORITY = {"PREVIOUS_DAY": 0, "ASIAN": 1, "EQUAL": 2, "SWING": 3}
STRONG = {"PREVIOUS_DAY", "ASIAN"}
SCORE = {"h1Bias": 2, "strongLiquidity": 2, "sweep": 3, "structure": 3, "displacement": 2,
         "fvg": 2, "retrace": 2, "rewardToRisk": 2}


def liquidity_name(level):
    low = level.side == "SELL_SIDE"
    return {"PREVIOUS_DAY": ("PDL", "PDH"), "ASIAN": ("ASIAN_LOW", "ASIAN_HIGH"),
            "EQUAL": ("EQUAL_LOWS", "EQUAL_HIGHS"), "SWING": ("SWING_LOW", "SWING_HIGH")}[level.type][0 if low else 1]


class Pattern:
    __slots__ = ("direction", "level", "levels", "sweep_index", "sweep_time", "extreme",
                 "reclaim_index", "reclaim_time", "ref", "displacement")


class LsfvgEngine:
    def __init__(self, symbol, tick_size, model, overrides=None):
        self.symbol = symbol
        self.p = dict(DEFAULT_PARAMS)
        self.p.update(overrides or {})
        self.model = model
        self.tick = D(tick_size)
        self.counters = {k: 0 for k in (
            "m5Candles", "m15Candles", "sweeps", "reclaims", "displacements", "fvgs", "noFvg",
            "setups", "rejectedBias", "rejectedTarget", "rejectedRewardToRisk", "rejectedData",
            "invalidated")}
        self.m15 = Aggregator(M15)
        self.h1 = Aggregator(HOUR)
        self.atr_m5 = Atr(self.p["atrPeriod"])
        self.atr_m15 = Atr(self.p["atrPeriod"])
        self.h1_swings = SwingDetector()
        self.m15_swings = SwingDetector()
        self.h1_highs, self.h1_lows = [], []
        self.last_h1_close = None
        self.m15_highs, self.m15_lows = [], []
        self.history = []
        self.m15_index = 0
        self.swing_levels = []
        self.day = None
        self.prev_day = None
        self.asian = None
        self.patterns = {"LONG": None, "SHORT": None}
        self.active = []
        self.last_open = -math.inf

    # -- M5 ------------------------------------------------------------------------------------
    def on_m5(self, m5):
        if not m5.open_ms > self.last_open:
            raise ValueError(f"M5 candles out of order at {iso(m5.open_ms)}")
        if m5.close_ms - m5.open_ms != M5:
            raise ValueError(f"not an M5 candle: {iso(m5.open_ms)}")
        self.last_open = m5.open_ms
        self.counters["m5Candles"] += 1
        self.atr_m5.push(m5)
        events = []
        still = []
        for a in self.active:
            if m5.open_ms < a["detected"]:
                still.append(a)
                continue
            a["seen"] += 1
            beyond = m5.c < a["invalidation"] if a["direction"] == "LONG" else m5.c > a["invalidation"]
            if beyond:
                self.counters["invalidated"] += 1
                events.append({"kind": "INVALIDATED", "setupId": a["id"], "at": m5.close_ms})
            elif a["seen"] < self.p["entryWaitM5Candles"]:
                still.append(a)
        self.active = still
        for h in self.h1.push(m5):
            self._on_h1(h)
        for c in self.m15.push(m5):
            events.extend(self._on_m15(c))
        return events

    def _on_h1(self, h):
        for s in self.h1_swings.push(h):
            lst = self.h1_highs if s.kind == "HIGH" else self.h1_lows
            lst.append(s)
            if len(lst) > 20:
                lst.pop(0)
        self.last_h1_close = h.c

    # -- M15 -----------------------------------------------------------------------------------
    def _on_m15(self, c):
        self.counters["m15Candles"] += 1
        self.m15_index += 1
        c.i = self.m15_index
        self.history.append(c)
        if len(self.history) > 10:
            self.history.pop(0)
        atr_prev = self.atr_m15.value
        events = []
        self._roll_day(c)
        self._roll_asian(c)
        for d in ("LONG", "SHORT"):
            e = self._advance(d, c, atr_prev)
            if e:
                events.append(e)
        sell = [l for l in self._levels("SELL_SIDE", c.open_ms, atr_prev) if c.l < l.price]
        buy = [l for l in self._levels("BUY_SIDE", c.open_ms, atr_prev) if c.h > l.price]
        if sell:
            self._sweep("LONG", sell, c, atr_prev)
        if buy:
            self._sweep("SHORT", buy, c, atr_prev)
        for l in sell + buy:
            l.swept = True
        for l in self.swing_levels:
            if not l.swept and (c.l < l.price if l.side == "SELL_SIDE" else c.h > l.price):
                l.swept = True
        self._accumulate(c)
        for s in self.m15_swings.push(c):
            lst = self.m15_highs if s.kind == "HIGH" else self.m15_lows
            lst.append(s)
            if len(lst) > 50:
                lst.pop(0)
            self.swing_levels.append(Level("SWING", "BUY_SIDE" if s.kind == "HIGH" else "SELL_SIDE",
                                           s.price, s.confirmed))
        kept = [l for l in self.swing_levels if not l.swept]
        self.swing_levels = kept[-self.p["maxSwingLevels"]:] if kept else []
        self.atr_m15.push(c)
        return events

    def _levels(self, side, as_of, atr):
        low = side == "SELL_SIDE"
        out = []

        def known(l):
            return not l.swept and l.formed <= as_of

        if self.prev_day:
            l = self.prev_day[1] if low else self.prev_day[0]
            if known(l):
                out.append(l)
        a = self.asian["levels"] if self.asian else None
        if a:
            l = a[1] if low else a[0]
            if known(l):
                out.append(l)
        swings = [l for l in self.swing_levels if l.side == side and known(l)]
        out.extend(swings)
        if atr is not None and len(swings) >= 2:
            tol = self.p["equalLevelAtrFraction"] * atr
            srt = sorted(swings, key=lambda x: x.price)
            group = [srt[0]]

            def flush():
                if len(group) >= 2:
                    prices = [g.price for g in group]
                    out.append(Level("EQUAL", side, min(prices) if low else max(prices),
                                     max(g.formed for g in group)))

            for s in srt[1:]:
                if s.price - group[0].price <= tol:
                    group.append(s)
                else:
                    flush()
                    group = [s]
            flush()
        return out

    def _sweep(self, d, taken, c, atr_prev):
        ex = self.patterns[d]
        if ex and (ex.displacement is not None or (
                ex.reclaim_index is None and c.i <= ex.sweep_index + self.p["reclaimCandles"])):
            ex.levels.extend(taken)
            return
        long = d == "LONG"
        ref = self._reference(d, c.open_ms)
        if not ref:
            return
        primary = sorted(taken, key=lambda a: (PRIORITY[a.type], a.price if long else -a.price))[0]
        self.counters["sweeps"] += 1
        p = Pattern()
        p.direction, p.level, p.levels = d, primary, list(taken)
        p.sweep_index, p.sweep_time = c.i, c.open_ms
        p.extreme = c.l if long else c.h
        p.reclaim_index = p.reclaim_time = None
        p.ref, p.displacement = ref, None
        self.patterns[d] = p
        self._step(p, c, atr_prev)

    def _reference(self, d, before):
        lst = [s for s in (self.m15_highs if d == "LONG" else self.m15_lows) if s.confirmed <= before]
        if not lst:
            return None
        last = lst[-1]
        prev = lst[-2] if len(lst) >= 2 else None
        choch = prev is not None and (last.price < prev.price if d == "LONG" else last.price > prev.price)
        return {"price": last.price, "time": last.time, "kind": "CHOCH" if choch else "BOS"}

    def _is_displacement(self, d, c, atr):
        rng = c.h - c.l
        if atr is None or not rng > 0:
            return False
        directional = c.c > c.o if d == "LONG" else c.c < c.o
        body = abs(c.c - c.o)
        return (directional and body >= self.p["displacementBodyToRange"] * rng
                and body >= self.p["displacementBodyToAtr"] * atr)

    def _step(self, p, c, atr_prev):
        long = p.direction == "LONG"
        if p.reclaim_index is None:
            p.extreme = min(p.extreme, c.l) if long else max(p.extreme, c.h)
            if (c.c > p.level.price) if long else (c.c < p.level.price):
                p.reclaim_index = c.i
                p.reclaim_time = c.close_ms
                self.counters["reclaims"] += 1
            else:
                if c.i >= p.sweep_index + self.p["reclaimCandles"]:
                    self.patterns[p.direction] = None
                return
        elif (c.l < p.extreme) if long else (c.h > p.extreme):
            self.patterns[p.direction] = None
            return
        broke = c.c > p.ref["price"] if long else c.c < p.ref["price"]
        if self._is_displacement(p.direction, c, atr_prev) and broke:
            p.displacement = {"index": c.i, "candle": c, "atr": atr_prev}
            self.counters["displacements"] += 1
            return
        if c.i >= p.sweep_index + self.p["displacementWindowCandles"]:
            self.patterns[p.direction] = None

    def _advance(self, d, c, atr_prev):
        p = self.patterns[d]
        if not p:
            return None
        if p.displacement is None:
            self._step(p, c, atr_prev)
            return None
        self.patterns[d] = None
        c1 = next((h for h in self.history if h.i == p.displacement["index"] - 1), None)
        if c1 is None or c.i != p.displacement["index"] + 1:
            return None
        gap = c1.h < c.l if d == "LONG" else c1.l > c.h
        if not gap:
            self.counters["noFvg"] += 1
            return None
        self.counters["fvgs"] += 1
        return self._complete(p, c1, c)

    def _complete(self, p, c1, c3):
        long = p.direction == "LONG"
        disp = p.displacement
        fvg_low = c1.h if long else c3.h
        fvg_high = c3.l if long else c1.l
        bias = assess_bias(self.h1_highs, self.h1_lows, self.last_h1_close)
        base = {"symbol": self.symbol, "direction": p.direction, "model": self.model,
                "detectedAt": c3.close_ms, "liquidity": liquidity_name(p.level),
                "liquidityPrice": p.level.price, "strong": p.level.type in STRONG,
                "structure": p.ref["kind"], "sweepExtreme": p.extreme, "fvgLow": fvg_low,
                "fvgHigh": fvg_high, "bias": bias}

        def reject(stage, key):
            self.counters[key] += 1
            return {"kind": "REJECTED", "stage": stage, **base}

        wanted = "BULLISH" if long else "BEARISH"
        if bias != wanted:
            return reject("BIAS", "rejectedBias")
        atr5 = self.atr_m5.value
        if atr5 is None:
            return reject("DATA", "rejectedData")
        tick = self.tick
        entry = ((D(fvg_low) + D(fvg_high)) / 2 / tick).quantize(Decimal(1), rounding=ROUND_HALF_EVEN) * tick
        buffer = D(atr5) * D(self.p["stopAtrFraction"])
        stop = floor_step(D(p.extreme) - buffer, tick) if long else ceil_step(D(p.extreme) + buffer, tick)
        risk = entry - stop if long else stop - entry
        if risk <= 0:
            return reject("DATA", "rejectedData")
        min_rr = D(self.p["minRewardToRisk"])
        if self.model == "A":
            raw = entry + risk * min_rr if long else entry - risk * min_rr
            target = ceil_step(raw, tick) if long else floor_step(raw, tick)
            target_source = f"FIXED_{js_str(float(self.p['minRewardToRisk']))}R"
        else:
            opposite = [l for l in self._levels("BUY_SIDE" if long else "SELL_SIDE", c3.close_ms,
                                                self.atr_m15.value)
                        if (l.price > c3.h if long else l.price < c3.l)]
            opposite.sort(key=lambda l: l.price if long else -l.price)

            def rr_of(price):
                return abs(D(price) - entry) / risk

            if self.p["modelBTarget"] == "NEAREST_ONLY":
                pick = opposite[0] if opposite else None
            else:
                pick = next((l for l in opposite if rr_of(l.price) >= min_rr), None)
            if pick is None:
                return reject("TARGET", "rejectedTarget")
            target = floor_step(D(pick.price), tick) if long else ceil_step(D(pick.price), tick)
            target_source = f"{liquidity_name(pick)} {js_str(pick.price)}"
        rr = abs(target - entry) / risk
        if rr < min_rr:
            return reject("REWARD_TO_RISK", "rejectedRewardToRisk")
        score = sum(SCORE.values()) - SCORE["retrace"] - (0 if base["strong"] else SCORE["strongLiquidity"])
        sid = f"{self.symbol}-{p.direction}-{iso(c3.close_ms)}"
        self.counters["setups"] += 1
        self.active.append({"id": sid, "direction": p.direction, "invalidation": p.extreme,
                            "detected": c3.close_ms, "seen": 0})
        return {"kind": "SETUP", **base, "id": sid,
                "expiresAt": c3.close_ms + self.p["entryWaitM5Candles"] * M5,
                "entry": to_num(entry, 10), "stop": to_num(stop, 10), "target": to_num(target, 10),
                "targetSource": target_source, "rewardToRisk": to_num(rr, 2),
                "atrM5": round_dp(atr5, 10), "score": score}

    # -- Levels of the previous day and the Asian range ---------------------------------------
    def _roll_day(self, c):
        key, _, end = trading_day_window(c.open_ms)
        if self.day and self.day["key"] != key:
            self.prev_day = (Level("PREVIOUS_DAY", "BUY_SIDE", self.day["high"], self.day["end"]),
                             Level("PREVIOUS_DAY", "SELL_SIDE", self.day["low"], self.day["end"]))
            self.day = None
        if not self.day:
            self.day = {"key": key, "end": end, "high": c.h, "low": c.l}

    def _asian_bounds(self, day_ms):
        (sh, sm), (eh, em) = self.p["asianStartUtc"], self.p["asianEndUtc"]
        return day_ms + sh * HOUR + sm * M1, day_ms + eh * HOUR + em * M1

    def _roll_asian(self, c):
        day_ms = (c.open_ms // DAY) * DAY
        if not self.asian or self.asian["date"] != day_ms:
            self.asian = {"date": day_ms, "high": -math.inf, "low": math.inf, "count": 0, "levels": None}
        _, end = self._asian_bounds(day_ms)
        a = self.asian
        if a["levels"] is None and a["count"] > 0 and c.open_ms >= end:
            a["levels"] = (Level("ASIAN", "BUY_SIDE", a["high"], end), Level("ASIAN", "SELL_SIDE", a["low"], end))

    def _accumulate(self, c):
        if self.day:
            self.day["high"] = max(self.day["high"], c.h)
            self.day["low"] = min(self.day["low"], c.l)
        a = self.asian
        start, end = self._asian_bounds(a["date"])
        if start <= c.open_ms < end and a["levels"] is None:
            a["high"] = max(a["high"], c.h)
            a["low"] = min(a["low"], c.l)
            a["count"] += 1


def engine_events(symbol, bars, model, overrides):
    """Every event of one pair's engine, keyed by the index of the M5 candle that produced it."""
    eng = LsfvgEngine(symbol, INSTRUMENTS[symbol]["tickSize"], model, overrides)
    out = {}
    for i, (t, b, a, _) in enumerate(bars):
        ev = eng.on_m5(Candle(t, t + M5, (b[0] + a[0]) / 2, (b[1] + a[1]) / 2,
                              (b[2] + a[2]) / 2, (b[3] + a[3]) / 2))
        if ev:
            out[i] = ev
    return out, eng.counters


# ---------------------------------------------------------------------------------------------
# The research broker (packages/research/src/broker.ts) — pessimistic by construction.
# ---------------------------------------------------------------------------------------------


class Broker:
    def __init__(self, costs):
        self.costs = costs
        self.balance = D(STARTING_BALANCE)
        self.orders = {}
        self.positions = {}
        self.pending_closes = {}
        self.last = {}
        self.rates = {}  # latest uncrossed quote per symbol: the broker's own conversions use it
        self.fill_bar = set()

    def mark(self, symbol, bid, ask):
        self.last[symbol] = (bid, ask)
        if bid > 0 and ask >= bid:
            self.rates[symbol] = (bid, ask)

    def valued(self, symbol, quotes=None):
        """(tickValue, tickSize, commission) in USD; USD/JPY with its own mid. The broker uses the
        latest uncrossed quote; the gate passes the raw quotes (a crossed one → no valuation)."""
        spec = INSTRUMENTS[symbol]
        if spec["quoteCurrency"] == ACCOUNT_CURRENCY:
            return spec["tickValue"], spec["tickSize"], spec["commission"]
        pair = spec["quoteCurrency"] + ACCOUNT_CURRENCY
        inv = ACCOUNT_CURRENCY + spec["quoteCurrency"]
        if pair in INSTRUMENTS:
            sym, invert = pair, False
        elif inv in INSTRUMENTS:
            sym, invert = inv, True
        else:
            raise ValueError(f"no {spec['quoteCurrency']}→USD pair")
        q = (self.rates if quotes is None else quotes).get(sym)
        if not q or not q[0] > 0 or not q[1] >= q[0]:
            raise ValueError(f"no fresh {spec['quoteCurrency']}→USD rate to value {symbol}")
        mid = (D(q[0]) + D(q[1])) / 2
        rate = to_num(Decimal(1) / mid if invert else mid, 12)
        return to_num(D(spec["tickValue"]) * D(rate), 10), spec["tickSize"], spec["commission"]

    def adjust(self, bid, ask):
        m = self.costs["spreadMultiplier"]
        if m == 1:
            return bid, ask

        def side(k, sign):
            mid = (bid[k] + ask[k]) / 2
            half = ((ask[k] - bid[k]) / 2) * m
            return mid + sign * half

        return (tuple(side(k, -1) for k in range(4)), tuple(side(k, 1) for k in range(4)))

    def has_working(self, symbol):
        return any(o["symbol"] == symbol for o in self.orders.values())

    def cancel(self, signal_id):
        out = [o for o in self.orders.values() if o["signalId"] == signal_id]
        for o in out:
            del self.orders[o["id"]]
        return out

    def queue_close(self, pid):
        if pid in self.positions:
            self.pending_closes[pid] = True

    def on_bar(self, symbol, t, bid, ask):
        bid, ask = self.adjust(bid, ask)
        tick = INSTRUMENTS[symbol]["tickSize"]
        slip = self.costs["slippageTicks"] * tick
        close_ms = t + M5
        filled, closed, missed = [], [], []
        self.fill_bar.clear()
        self.mark(symbol, bid[0], ask[0])
        for pid in list(self.pending_closes):
            p = self.positions.get(pid)
            if not p or p["order"]["symbol"] != symbol:
                continue
            del self.pending_closes[pid]
            long = p["order"]["direction"] == "LONG"
            closed.append(self._settle(p, bid[0] - slip if long else ask[0] + slip, "PROTECTIVE", t))
        through = self.costs["limitThroughTicks"] * tick
        for o in list(self.orders.values()):
            if o["symbol"] != symbol or t < o["activeFrom"]:
                continue
            if t >= o["expiresAt"]:
                del self.orders[o["id"]]
                missed.append(o)
                continue
            long = o["direction"] == "LONG"
            reached = ask[2] <= o["limit"] - through if long else bid[1] >= o["limit"] + through
            if reached and close_ms <= o["expiresAt"]:
                del self.orders[o["id"]]
                p = self._open(o, t)
                self.fill_bar.add(p["id"])
                filled.append(p)
            elif close_ms >= o["expiresAt"]:
                del self.orders[o["id"]]
                missed.append(o)
        for p in list(self.positions.values()):
            if p["order"]["symbol"] != symbol:
                continue
            long = p["order"]["direction"] == "LONG"
            in_fill = p["id"] in self.fill_bar
            stop, target = p["order"]["stop"], p["order"]["target"]
            stop_hit = bid[2] <= stop if long else ask[1] >= stop
            target_hit = (not in_fill) and (bid[1] >= target if long else ask[2] <= target)
            if stop_hit:
                gapped = (not in_fill) and (bid[0] <= stop if long else ask[0] >= stop)
                base = (bid[0] if long else ask[0]) if gapped else stop
                closed.append(self._settle(p, base - slip if long else base + slip, "STOP", close_ms))
            elif target_hit:
                closed.append(self._settle(p, target, "TARGET", close_ms))
        self.mark(symbol, bid[3], ask[3])
        return filled, closed, missed

    def _open(self, o, at):
        tv, ts, comm = self.valued(o["symbol"])
        vpp = D(tv) / D(ts)
        commission = D(comm) * D(o["quantity"]) if self.costs["commission"] else Decimal(0)
        self.balance -= commission
        p = {"id": f"pos-{o['id']}", "order": o, "entry": o["limit"], "openedAt": at,
             "commission": to_num(commission, 2),
             "riskMoney": to_num(abs(D(o["limit"]) - D(o["stop"])) * vpp * D(o["quantity"]), 2)}
        self.positions[p["id"]] = p
        return p

    def _settle(self, p, exit_, reason, at):
        tv, ts, _ = self.valued(p["order"]["symbol"])
        sign = 1 if p["order"]["direction"] == "LONG" else -1
        gross = (D(exit_) - D(p["entry"])) * sign * D(tv) / D(ts) * D(p["order"]["quantity"])
        self.balance += gross
        del self.positions[p["id"]]
        self.pending_closes.pop(p["id"], None)
        return {"position": p, "exit": to_num(D(exit_), 10), "exitReason": reason, "closedAt": at,
                "grossPnl": money(gross), "netPnl": money(gross - D(p["commission"]))}

    def close_all(self, at):
        self.orders.clear()
        out = []
        for p in list(self.positions.values()):
            q = self.last[p["order"]["symbol"]]
            out.append(self._settle(p, q[0] if p["order"]["direction"] == "LONG" else q[1], "END_OF_DATA", at))
        return out

    def snapshot(self):
        """(balance, equity, exposure) — exposure = open positions then working orders."""
        floating = Decimal(0)
        exposure = []
        for p in self.positions.values():
            o = p["order"]
            q = self.last[o["symbol"]]
            long = o["direction"] == "LONG"
            mark = q[0] if long else q[1]
            tv, ts, _ = self.valued(o["symbol"])
            floating += (D(mark) - D(p["entry"])) * (1 if long else -1) * D(tv) / D(ts) * D(o["quantity"])
            exposure.append({"id": p["id"], "symbol": o["symbol"], "direction": o["direction"],
                             "quantity": o["quantity"], "current": to_num(D(mark), 10), "stop": o["stop"]})
        for o in self.orders.values():
            exposure.append({"id": f"working:{o['id']}", "symbol": o["symbol"], "direction": o["direction"],
                             "quantity": o["quantity"], "current": o["limit"], "stop": o["stop"]})
        return money(self.balance), money(self.balance + floating), exposure


# ---------------------------------------------------------------------------------------------
# The replay (packages/research/src/simulate.ts, strategy study): the gate's checks that decide
# a research trade, the account's day, and ASTRA's automatic protection (flat before the
# weekend).
# ---------------------------------------------------------------------------------------------


def _risk_to_stop(e, lookup):
    v = lookup(e["symbol"])
    if v is None:
        return None  # no valuation → open risk unknown
    tv, ts, comm = v
    sign = 1 if e["direction"] == "LONG" else -1
    qty = D(e["quantity"])
    adverse = max(Decimal(0), (D(e["current"]) - D(e["stop"])) * sign)
    slip = D(INSTRUMENTS[e["symbol"]]["slippageAllowanceTicks"]) * D(tv) * qty
    return to_num(adverse * (D(tv) / D(ts)) * qty + slip + D(comm) * qty)


def account_state(balance, equity, exposure, lookup):
    risks = {e["id"]: _risk_to_stop(e, lookup) for e in exposure}
    amount = Decimal(0)
    for r in risks.values():
        amount += D(r if r is not None else 0)
    initial = D(STARTING_BALANCE)
    limit = initial  # study profile: static drawdown of 100 % of the initial balance
    wc_equity = D(equity) - amount
    remaining = D(equity)
    wc_remaining = to_num(wc_equity)

    def used_pct(used):
        return to_num(max(Decimal(0), used) / limit * 100, 4)

    return {"balance": balance, "equity": equity, "risks": risks, "openRisk": to_num(amount),
            "complete": all(r is not None for r in risks.values()),
            "openRiskDec": amount, "wcRemaining": wc_remaining,
            "usedPct": used_pct(limit - remaining), "wcUsedPct": used_pct(limit - D(wc_remaining)),
            "breached": remaining <= 0}


def health_of(state, activity):
    if state["breached"]:
        return False, 0
    if not state["complete"]:
        return False, 0  # UNKNOWN
    wc = state["wcUsedPct"]
    if wc >= RISK_POLICY["breachRiskUsagePct"] or state["wcRemaining"] <= RISK_POLICY["survivalBufferAmount"]:
        return False, 0
    if (wc >= RISK_POLICY["restrictedUsagePct"] or activity["tradesToday"] >= RISK_POLICY["maxTradesPerDay"]
            or activity["consecutiveLosses"] >= RISK_POLICY["maxConsecutiveLosses"]):
        return False, 0
    if wc >= RISK_POLICY["cautionUsagePct"]:
        return True, RISK_POLICY["cautionSizeMultiplier"]
    return True, 1


def position_size(symbol, entry, stop, state, mult, lookup):
    v = lookup(symbol)
    if v is None or not state["complete"]:
        return None  # not valued in USD / open risk unknown
    tv, ts, comm = v
    spec = INSTRUMENTS[symbol]
    tick = D(spec["tickSize"])
    ticks = ceil_step(abs(D(entry) - D(stop)), tick) / tick
    per_unit = (ticks + D(spec["slippageAllowanceTicks"])) * D(tv) + D(comm)
    if mult <= 0:
        return None
    if state["equity"] <= 0:
        return None
    equity_base = min(D(state["equity"]), D(state["balance"]))
    risk_pct = min(D(RISK_POLICY["riskPercentOfEquity"]), D(STRATEGY["maxRiskPercentPerTrade"]))
    survival = D(RISK_POLICY["survivalBufferAmount"])
    amounts = [
        equity_base * risk_pct / 100,
        (D(state["wcRemaining"]) - survival) * D(RISK_POLICY["maxDrawdownBufferUsePct"]) / 100,
        D(state["equity"]) * D(RISK_POLICY["maxOpenRiskPercentOfEquity"]) / 100 - D(state["openRisk"]),
    ]
    binding = amounts[0]
    for a in amounts[1:]:
        if a < binding:
            binding = a
    allowed = binding * D(mult)
    if allowed <= 0:
        return None
    qty = floor_step(allowed / per_unit, D(spec["quantityStep"]))
    if qty < D(spec["minQuantity"]):
        return None
    return to_num(qty), to_num(qty * per_unit)


class Study:
    """One replay: an account trading one model over the merged pairs."""

    def __init__(self, data, events, costs, calendar, from_ms, to_ms):
        self.data, self.events, self.costs, self.calendar = data, events, costs, calendar
        self.from_ms, self.to_ms = from_ms, to_ms
        self.broker = Broker(costs)
        self.entries = {}
        self.setups = {}
        self.trades = []
        self.setup_log = []
        self.blocked = {}
        self.counts = {"setups": 0, "approved": 0, "rejected": 0, "filled": 0, "missed": 0, "invalidated": 0}
        self.tracking = None
        self.equity = []
        self.breach = None
        self.halted = False
        self.protective = 0
        self.closing = set()
        self.seq = 0
        self.now = from_ms

    # -- the day's activity (ASTRA's AccountActivity) --------------------------------------------
    def activity(self, now):
        key, start, end = trading_day_window(now)
        by_symbol = {}
        today = 0
        for e in self.entries.values():
            if not (start <= e["placedAt"] < end) or e["status"] not in ("WORKING", "FILLED"):
                continue
            today += 1
            by_symbol[e["symbol"]] = by_symbol.get(e["symbol"], 0) + 1
        closed = [t for t in self.trades if start <= t["_closedMs"] < end][::-1]
        streak = 0
        for t in closed:
            if t["netPnl"] < 0:
                streak += 1
            else:
                break
        return {"key": key, "tradesToday": today, "consecutiveLosses": streak,
                "entriesBySymbol": by_symbol, "closedTodayR": [t["r"] for t in closed]}

    def record_close(self, c):
        p = c["position"]
        o = p["order"]
        self.closing.discard(p["id"])
        info = self.setups.get(o["id"])
        s = info["setup"] if info else None
        risk = p["riskMoney"]
        self.trades.append({
            "id": p["id"], "symbol": o["symbol"], "direction": o["direction"],
            "setupId": s["id"] if s else "", "decidedAt": iso(info["decidedAt"]) if info else o["placedAt"],
            "openedAt": iso(p["openedAt"]), "closedAt": iso(c["closedAt"]), "_closedMs": c["closedAt"],
            "durationMinutes": js_round((c["closedAt"] - p["openedAt"]) / 60_000),
            "entry": p["entry"], "exit": c["exit"], "stop": o["stop"], "target": o["target"],
            "quantity": o["quantity"], "exitReason": c["exitReason"], "riskMoney": risk,
            "grossPnl": c["grossPnl"], "commission": p["commission"], "netPnl": c["netPnl"],
            "r": js_round(c["netPnl"] / risk * 100) / 100 if risk > 0 else None,
            "liquidity": s["liquidity"] if s else "", "strongLiquidity": s["strong"] if s else False,
            "structure": s["structure"] if s else "BOS", "score": s["score"] if s else 0,
            "entryHourUtc": dt.datetime.fromtimestamp(p["openedAt"] // 1000, dt.timezone.utc).hour,
        })

    # -- the gate -----------------------------------------------------------------------------
    def decide(self, s, now):
        """The research gate for one setup: (approved, quantity, failing check ids)."""
        self.seq += 1
        sym = s["symbol"]
        spec = INSTRUMENTS[sym]
        long = s["direction"] == "LONG"
        fails = []

        def lookup(x):
            try:
                return self.broker.valued(x, self.broker.last)
            except ValueError:
                return None

        balance, equity, exposure = self.broker.snapshot()
        act = self.activity(now)
        q = self.broker.last.get(sym)
        tick = D(spec["tickSize"])

        if self.halted:
            fails.append("system.kill-switches")
        # market.spread
        if (D(q[1]) - D(q[0])) / tick > D(spec["maxSpreadTicks"]):
            fails.append("market.spread")
        # market.entry (LIMIT): not already beyond the stop or the target, on the tick grid, expiry
        px = D(q[1] if long else q[0])
        expires = s["expiresAt"]
        bad_entry = (not expires > now or expires - now > SYSTEM["maxWorkingOrderMinutes"] * M1
                     or not (D(s["entry"]) / tick) == (D(s["entry"]) / tick).to_integral_value()
                     or (px <= D(s["stop"]) if long else px >= D(s["stop"]))
                     or (px >= D(s["target"]) if long else px <= D(s["target"])))
        if bad_entry:
            fails.append("market.entry")
        # market.session
        is_open, close_ms, to_close = market_status(now)
        if not is_open or expires > close_ms - SYSTEM["minMinutesBeforeMarketClose"] * M1 or \
                to_close <= SYSTEM["minMinutesBeforeMarketClose"]:
            fails.append("market.session")
        # calendar.event-blackout (strategy ∪ global rule)
        if self.calendar is not None:
            before = max(SYSTEM["eventBlackout"]["minutesBefore"], STRATEGY["eventBlackout"]["minutesBefore"])
            after = max(SYSTEM["eventBlackout"]["minutesAfter"], STRATEGY["eventBlackout"]["minutesAfter"])
            lo, hi = now - after * M1, max(now, expires) + before * M1
            cal = self.calendar
            if cal["from"] > lo or cal["to"] < hi:
                fails.append("calendar.event-blackout")
            else:
                levels = set(SYSTEM["eventBlackout"]["impactLevels"]) | set(STRATEGY["eventBlackout"]["impactLevels"])
                if any(lo <= ev["at"] <= hi and ("HIGH" if ev["impact"] == "UNKNOWN" else ev["impact"]) in levels
                       and (ev["currency"] is None or ev["currency"] in spec["eventCurrencies"])
                       for ev in cal["events"]):
                    fails.append("calendar.event-blackout")
        # position.duplicates
        if self.broker.has_working(sym):
            fails.append("position.duplicates")

        state = account_state(balance, equity, exposure, lookup)
        allows, mult = health_of(state, act)
        size = position_size(sym, s["entry"], s["stop"], state, mult, lookup)

        # risk.capital-preservation
        risk_fail = not allows
        rr_ok = True
        sign = 1 if long else -1
        r_risk = (D(s["entry"]) - D(s["stop"])) * sign
        r_reward = (D(s["target"]) - D(s["entry"])) * sign
        if r_risk <= 0 or r_reward <= 0:
            rr_ok = False
        else:
            rr_ok = to_num(r_reward / r_risk, 4) >= max(RISK_POLICY["minRewardToRisk"], STRATEGY["minRewardToRisk"])
        max_trades = min(RISK_POLICY["maxTradesPerDay"], STRATEGY["maxTradesPerDay"])
        same = [e for e in exposure if e["symbol"] == sym]
        if (not rr_ok or act["tradesToday"] >= max_trades
                or act["consecutiveLosses"] >= RISK_POLICY["maxConsecutiveLosses"]
                or len(exposure) + 1 > RISK_POLICY["maxOpenPositions"]
                or len(same) + 1 > RISK_POLICY["maxPositionsPerInstrument"]
                or (not RISK_POLICY["allowPyramiding"] and any(e["direction"] == s["direction"] for e in same))
                or size is None):
            risk_fail = True
        if size is not None:
            if D(state["wcRemaining"]) - D(size[1]) < D(RISK_POLICY["survivalBufferAmount"]):
                risk_fail = True
        if risk_fail:
            fails.append("risk.capital-preservation")

        # prop-firm.rules (study profile: the weekend rule, hedging, the account not lost)
        if size is None:
            fails.append("prop-firm.rules")  # no valid size → UNKNOWN
        else:
            weekly = next_weekly_time(now, *WEEKLY_CLOSE)
            entry_end = expires if expires > now else now
            if (state["breached"] or not (D(state["wcRemaining"]) - D(size[1]) > 0)
                    or any(e["symbol"] == sym and e["direction"] != s["direction"] for e in exposure)
                    or not (weekly - entry_end) / 60_000 > RISK_POLICY["noNewTradesMinutesBeforeFlat"]):
                fails.append("prop-firm.rules")

        # strategy.limits (owner rules)
        lim_fail = False
        if act["entriesBySymbol"].get(sym, 0) >= STRATEGY["maxEntriesPerSymbolPerDay"]:
            lim_fail = True
        start_bal = D(self.tracking["dayStartBalance"])
        if D(balance) - start_bal <= -(start_bal * D(STRATEGY["dailyRealizedLossStopPercent"]) / 100):
            lim_fail = True
        f = STRATEGY["fullRiskLosses"]
        streak = 0
        unknown_r = False
        for r in act["closedTodayR"]:
            if r is None:
                unknown_r = True
                break
            if r > f["atOrBelowR"]:
                break
            streak += 1
        if streak >= f["maxConsecutive"] or unknown_r:
            lim_fail = True
        for g in STRATEGY["correlation"]:
            if sym not in g["symbols"]:
                continue
            if size is None:
                lim_fail = True
                continue
            in_group = [e for e in exposure if e["symbol"] in g["symbols"]]
            open_risk = Decimal(0)
            for e in in_group:
                r = state["risks"][e["id"]]
                if r is None:
                    lim_fail = True
                else:
                    open_risk += D(r)
            after_ = open_risk + D(size[1])
            cap = D(state["equity"]) * D(g["maxOpenRiskPercent"]) / 100
            if len(in_group) + 1 > g["maxOpenPositions"] or after_ > cap:
                lim_fail = True
        if lim_fail:
            fails.append("strategy.limits")
        return len(fails) == 0, (size[0] if size else None), fails

    # -- the replay ---------------------------------------------------------------------------
    def run(self, log=None):
        series = [(sym, self.data[sym]) for sym in SYMBOLS if sym in self.data]
        idx = {sym: 0 for sym, _ in series}
        b = self.broker
        n = 0
        while True:
            t = math.inf
            for sym, bars in series:
                i = idx[sym]
                if i < len(bars) and bars[i][0] < t:
                    t = bars[i][0]
            if t == math.inf or t >= self.to_ms:
                break
            sl = []
            for sym, bars in series:
                i = idx[sym]
                if i < len(bars) and bars[i][0] == t:
                    sl.append((sym, i, bars[i]))
                    idx[sym] = i + 1
            live = t >= self.from_ms
            now = t + M5
            n += 1
            if log and n % 100_000 == 0:
                log(f"    … {iso(t)[:10]}")

            # 1. The candle executes what was decided before it opened.
            for sym, _, bar in sl:
                filled, closed, missed = b.on_bar(sym, t, bar[1], bar[2])
                for o in missed:
                    e = self.entries.get(o["id"])
                    if e:
                        e["status"] = "MISSED"
                    self.counts["missed"] += 1
                for p in filled:
                    e = self.entries.get(p["order"]["id"])
                    if e:
                        e["status"] = "FILLED"
                    self.counts["filled"] += 1
                for c in closed:
                    self.record_close(c)
            self.now = now

            # 2. The account's day and protection (trading window only).
            if live:
                self._account(now)

            # 3. The engine's events; setups go through the gate.
            for sym, i, _ in sl:
                evs = self.events[sym].get(i)
                if not evs or not live:
                    continue
                for e in evs:
                    if e["kind"] == "REJECTED":
                        continue
                    if e["kind"] == "INVALIDATED":
                        for o in b.cancel(e["setupId"]):
                            en = self.entries.get(o["id"])
                            if en:
                                en["status"] = "CANCELLED"
                            self.counts["invalidated"] += 1
                        continue
                    self.counts["setups"] += 1
                    ok, qty, fails = self.decide(e, now)
                    self.setup_log.append({**e, "decidedAt": now, "approved": ok, "quantity": qty,
                                           "refusedBy": fails})
                    if ok:
                        self.counts["approved"] += 1
                        oid = f"rs-ord-{self.seq}"
                        b.orders[oid] = {"id": oid, "symbol": sym, "direction": e["direction"],
                                         "quantity": qty, "limit": e["entry"], "stop": e["stop"],
                                         "target": e["target"], "activeFrom": now, "expiresAt": e["expiresAt"],
                                         "signalId": e["id"], "placedAt": iso(now)}
                        self.entries[oid] = {"symbol": sym, "placedAt": now, "status": "WORKING"}
                        self.setups[oid] = {"setup": e, "decidedAt": now}
                    else:
                        self.counts["rejected"] += 1
                        for f in fails:
                            if f not in self.blocked:
                                self.blocked[f] = 0
                            self.blocked[f] += 1
        end = min(self.to_ms, self.now)
        for c in b.close_all(end):
            self.record_close(c)
        return self

    def _broker_lookup(self, symbol):
        try:
            return self.broker.valued(symbol)
        except ValueError:
            return None

    def _account(self, now):
        b = self.broker
        balance, equity, exposure = b.snapshot()
        key, start, _ = trading_day_window(now)
        tr = self.tracking
        if tr is None:
            self.tracking = tr = {"key": key, "dayStartBalance": balance, "lastBalance": balance}
        elif key != tr["key"]:
            tr["key"] = key
            if now - start <= SYSTEM["lateObservationThresholdMs"]:
                tr["dayStartBalance"] = balance
            else:
                tr["dayStartBalance"] = float(max(D(tr["lastBalance"]), D(balance)))
        tr["lastBalance"] = balance
        last = self.equity[-1] if self.equity else None
        if last and last["day"] == key:
            last.update(balance=balance, equity=equity, low=min(last["low"], equity))
        else:
            self.equity.append({"day": key, "balance": balance, "equity": equity, "low": equity})
        if not exposure:
            return
        state = account_state(balance, equity, exposure, self._broker_lookup)
        if state["breached"] and not self.breach:
            self.breach = {"at": iso(now), "detail": f"account lost (equity {equity})"}
            self.halted = True
        if not b.positions:
            return
        # Automatic protection: a hard limit ≥ 90 % used (a lost account in the study), or the
        # weekly close (Fri 16:00 New York; no weekend holding) within 2 minutes / already passed.
        nxt = next_weekly_time(now, *WEEKLY_CLOSE)
        prev = last_weekly_time(now, *WEEKLY_CLOSE)
        limit_hit = state["usedPct"] >= SYSTEM["flattenAtLimitUsagePct"]
        weekly_all = (nxt - now) / 60_000 <= SYSTEM["flattenMinutesBeforeFlat"]
        for pid, p in list(b.positions.items()):
            if pid in self.closing:
                continue
            if limit_hit or weekly_all or p["openedAt"] < prev:
                if limit_hit:
                    self.halted = True
                self.closing.add(pid)
                b.queue_close(pid)
                self.protective += 1


# ---------------------------------------------------------------------------------------------
# §23 metrics and §21/§22/§24 validation (packages/research/src/metrics.ts, validation.ts)
# ---------------------------------------------------------------------------------------------


def _mean(xs):
    if not xs:
        return None
    s = 0
    for x in xs:
        s += x
    return s / len(xs)


def metrics(trades):
    srt = sorted(trades, key=lambda t: t["_closedMs"])
    rs = [t["r"] or 0 for t in srt]
    wins = [t for t in srt if t["netPnl"] > 0]
    losses = [t for t in srt if t["netPnl"] < 0]
    gw = 0
    for t in wins:
        gw += t["netPnl"]
    gl = 0
    for t in losses:
        gl += t["netPnl"]
    gl = -gl
    peak_r = cum_r = dd_r = peak_m = cum_m = dd_m = 0
    streak = max_streak = 0
    for t in srt:
        cum_r += t["r"] or 0
        peak_r = max(peak_r, cum_r)
        dd_r = max(dd_r, peak_r - cum_r)
        cum_m += t["netPnl"]
        peak_m = max(peak_m, cum_m)
        dd_m = max(dd_m, peak_m - cum_m)
        streak = streak + 1 if t["netPnl"] < 0 else 0
        max_streak = max(max_streak, streak)
    win_r = _mean([t["r"] or 0 for t in wins])
    loss_r = _mean([t["r"] or 0 for t in losses])
    exp = _mean(rs)
    dur = _mean([t["durationMinutes"] for t in srt])
    n = len(srt)
    return {
        "trades": n, "wins": len(wins), "losses": len(losses), "breakeven": n - len(wins) - len(losses),
        "winRate": round_dp(len(wins) / n * 100, 1) if n else None,
        "avgWinR": None if win_r is None else round_dp(win_r),
        "avgLossR": None if loss_r is None else round_dp(loss_r),
        "expectancyR": None if exp is None else round_dp(exp, 3),
        "profitFactor": round_dp(gw / gl) if gl > 0 else None,
        "totalR": round_dp(cum_r), "netPnl": round_dp(cum_m), "maxDrawdownR": round_dp(dd_r),
        "maxDrawdownMoney": round_dp(dd_m), "maxConsecutiveLosses": max_streak,
        "avgDurationMinutes": None if dur is None else js_round(dur),
    }


def by_year(t):
    return t["closedAt"][:4]


def by_month(t):
    return t["closedAt"][:7]


def by_pair(t):
    return t["symbol"]


def by_direction(t):
    return t["direction"]


def by_session(t):
    h = t["entryHourUtc"]
    return "ASIA" if h < 7 else "LONDON" if h < 12 else "NEW_YORK" if h < 17 else "LATE"


def breakdown(trades, key):
    groups = {}
    for t in trades:
        groups.setdefault(key(t), []).append(t)
    return [(k, metrics(groups[k])) for k in sorted(groups)]


def split(trades, cut_ms):
    return {"cut": iso(cut_ms), "inSample": metrics([t for t in trades if t["_closedMs"] < cut_ms]),
            "outOfSample": metrics([t for t in trades if t["_closedMs"] >= cut_ms])}


def walk_forward(trades, from_ms, to_ms, months=6):
    out = []
    start = dt.datetime.fromtimestamp(from_ms / 1000, dt.timezone.utc)
    while start.timestamp() * 1000 < to_ms:
        m = start.month - 1 + months
        y = start.year + m // 12
        m = m % 12 + 1
        nxt = dt.datetime(y, m, 1, tzinfo=dt.timezone.utc) + dt.timedelta(days=start.day - 1)
        a, z = start.timestamp() * 1000, nxt.timestamp() * 1000
        w = [t for t in trades if a <= t["_closedMs"] < z]
        out.append({"from": start.date().isoformat(), "to": iso(int(min(z, to_ms)))[:10], "metrics": metrics(w)})
        start = nxt
    return out


def _mulberry32(seed):
    a = seed & 0xFFFFFFFF

    def imul(x, y):
        return ((x & 0xFFFFFFFF) * (y & 0xFFFFFFFF)) & 0xFFFFFFFF

    def nxt():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = imul(t ^ (t >> 15), t | 1)
        t ^= (t + imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return nxt


def monte_carlo(trades, runs=5000, seed=20260928, depths=(4, 8, 12, 20)):
    rs = [t["r"] for t in trades if t["r"] is not None]
    if not rs:
        return None
    nxt = _mulberry32(seed)
    totals, dds = [], []
    n = len(rs)
    for _ in range(runs):
        cum = peak = dd = 0
        for _ in range(n):
            cum += rs[math.floor(nxt() * n)]
            peak = max(peak, cum)
            dd = max(dd, peak - cum)
        totals.append(cum)
        dds.append(dd)
    totals.sort()
    dds.sort()

    def pct(xs, q):
        return xs[min(len(xs) - 1, math.floor(q * len(xs)))] if xs else 0

    def r2(x):
        return js_round(x * 100) / 100

    return {
        "runs": runs, "seed": seed, "tradesPerRun": n,
        "totalR": {"p5": r2(pct(totals, 0.05)), "p50": r2(pct(totals, 0.5)), "p95": r2(pct(totals, 0.95))},
        "maxDrawdownR": {"p50": r2(pct(dds, 0.5)), "p95": r2(pct(dds, 0.95)), "p99": r2(pct(dds, 0.99))},
        "expectancyR": {"p5": js_round(pct(totals, 0.05) / n * 1000) / 1000,
                        "p95": js_round(pct(totals, 0.95) / n * 1000) / 1000},
        "drawdownAtLeast": [{"r": d, "probability": js_round(sum(1 for x in dds if x >= d) / runs * 1000) / 1000}
                            for d in depths],
    }


def robustness(trades):
    def best(key):
        b = sorted(breakdown(trades, key), key=lambda x: -x[1]["totalR"])
        return b[0][0] if b else None

    year, pair, session = best(by_year), best(by_pair), best(by_session)
    top = {t["id"] for t in sorted(trades, key=lambda t: -(t["r"] or 0))[:5]}
    return {
        "all": metrics(trades),
        "withoutBestYear": {"year": year, "metrics": metrics([t for t in trades if by_year(t) != year])},
        "withoutBestPair": {"pair": pair, "metrics": metrics([t for t in trades if by_pair(t) != pair])},
        "withoutBestSession": {"session": session,
                               "metrics": metrics([t for t in trades if by_session(t) != session])},
        "withoutTop5Winners": metrics([t for t in trades if t["id"] not in top]),
    }


# ---------------------------------------------------------------------------------------------
# Running a study and writing the results
# ---------------------------------------------------------------------------------------------

TRADE_FIELDS = ["id", "symbol", "direction", "setupId", "decidedAt", "openedAt", "closedAt",
                "durationMinutes", "entry", "exit", "stop", "target", "quantity", "exitReason",
                "riskMoney", "grossPnl", "commission", "netPnl", "r", "liquidity", "strongLiquidity",
                "structure", "score", "entryHourUtc"]


def public_trade(t):
    return {k: t[k] for k in TRADE_FIELDS}


class EventCache:
    def __init__(self, data, log):
        self.data, self.log, self.cache = data, log, {}

    def get(self, model, overrides):
        key = (model, tuple(sorted(overrides.items())))
        if key not in self.cache:
            self.log(f"  engine: Model {model} {dict(overrides) or ''}")
            evs, counters = {}, {}
            for sym in SYMBOLS:
                if sym in self.data:
                    evs[sym], counters[sym] = engine_events(sym, self.data[sym], model, overrides)
            self.cache[key] = (evs, counters)
        return self.cache[key]


def run_study(data, cache, model, costs, calendar, from_ms, to_ms, overrides=None, log=None):
    evs, counters = cache.get(model, overrides or {})
    return Study(data, evs, costs, calendar, from_ms, to_ms).run(log), counters


def fmt(x, suffix=""):
    return "—" if x is None else f"{js_str(x) if isinstance(x, float) else x}{suffix}"


HEAD = ("| | Trades | Win rate | Avg win R | Avg loss R | Expectancy R | Profit factor | Total R | Net P&L | Max DD R | Max losing streak | Avg minutes |\n"
        "|---|---|---|---|---|---|---|---|---|---|---|---|")


def table(rows):
    lines = [HEAD]
    for k, m in rows:
        lines.append(f"| {k} | {m['trades']} | {fmt(m['winRate'], '%')} | {fmt(m['avgWinR'])} | {fmt(m['avgLossR'])} | "
                     f"{fmt(m['expectancyR'])} | {fmt(m['profitFactor'])} | {fmt(m['totalR'])} | {fmt(m['netPnl'])} | "
                     f"{fmt(m['maxDrawdownR'])} | {m['maxConsecutiveLosses']} | {fmt(m['avgDurationMinutes'])} |")
    return "\n".join(lines)


def insufficient(m):
    if m["trades"] < MIN_TRADES_FOR_STATISTICS:
        return f"INSUFFICIENT DATA — {m['trades']} trade(s); at least {MIN_TRADES_FOR_STATISTICS} are needed for a statement"
    return None


def render(summary):
    out = ["# LSFVG v1.0 — research report (standalone kit)", "",
           f"Kit {summary['kit']}, generated {summary['generatedAt']}. Window {summary['window']['from']} → "
           f"{summary['window']['to']}; out-of-sample from {summary['window']['outOfSampleFrom']}. The rules were "
           "frozen before this run (ADR-0024); nothing below was used to choose them.", "", "## Data", "",
           "| Pair | Candles (M5) | From | To | Gaps > 30 min | Invalid rows | Spread from data / assumed |",
           "|---|---|---|---|---|---|---|"]
    for d in summary["data"]:
        c = d["coverage"]
        out.append(f"| {d['symbol']} | {c['bars']} | {c['from']} | {c['to']} | {c['gaps']} (largest {js_str(float(c['largestGapMinutes']))} min) | "
                   f"{sum(p['invalid'] for p in d['parse'])} | {c['spreadFromData']} / {c['spreadAssumed']} |")
    out += ["", "## Assumptions (read before the numbers)", ""] + [f"- {a}" for a in summary["assumptions"]] + [""]
    for m in summary["models"]:
        allm = m["afterCosts"]["metrics"]
        out += [f"## Model {m['model']}", ""]
        v = insufficient(allm)
        if v:
            out += [f"> **{v}.** The numbers below describe what happened; they support no conclusion.", ""]
        out += [f"Starting balance {STARTING_BALANCE}; ending balance {m['afterCosts']['endingBalance']}.", "",
                "### Result (§23)", "",
                table([("After costs", allm), ("Before costs", m["beforeCosts"]["metrics"])]), "",
                "By pair, direction, session:", "",
                table(m["byPair"] + m["byDirection"] + [(f"session {k}", x) for k, x in m["bySession"]]), "",
                "By year:", "", table(m["byYear"]), "",
                "### In-sample vs out-of-sample (§21)", "",
                table([(f"before {m['split']['cut'][:10]}", m["split"]["inSample"]),
                       (f"from {m['split']['cut'][:10]} (untouched)", m["split"]["outOfSample"])])]
        oos = insufficient(m["split"]["outOfSample"])
        if oos:
            out.append(f"\nOut-of-sample: {oos}.")
        wf = [w for w in m["walkForward"] if w["metrics"]["trades"] > 0]
        pos = sum(1 for w in wf if (w["metrics"]["expectancyR"] or 0) > 0)
        out += ["", "### Walk-forward (§22)", "", table([(f"{w['from']} → {w['to']}", w["metrics"]) for w in m["walkForward"]]),
                "", f"{pos} of {len(wf)} windows with trades had a positive expectancy.", "", "### Monte Carlo (§22)", ""]
        mc = m["monteCarlo"]
        if not mc:
            out.append("No trades to resample.")
        else:
            out.append(f"{mc['runs']} bootstrap resamples of the {mc['tradesPerRun']} trades' R (seed {mc['seed']}). Total R: 5th "
                       f"{fmt(mc['totalR']['p5'])}, median {fmt(mc['totalR']['p50'])}, 95th {fmt(mc['totalR']['p95'])}. Expectancy per trade: "
                       f"{fmt(mc['expectancyR']['p5'])} … {fmt(mc['expectancyR']['p95'])} R (5th–95th). Max drawdown: median "
                       f"{fmt(mc['maxDrawdownR']['p50'])} R, 95th {fmt(mc['maxDrawdownR']['p95'])} R, 99th {fmt(mc['maxDrawdownR']['p99'])} R.")
            out.append("")
            out.append("Chance the drawdown reaches: " + " · ".join(
                f"{d['r']} R → {js_str(js_round(d['probability'] * 1000) / 10)}%" for d in mc["drawdownAtLeast"])
                + " (at 0.25 % risk, 1 R = 0.25 % of the account).")
        r = m["robustness"]
        out += ["", "### Robustness (§24)", "", table([
            ("All trades", r["all"]), (f"Without best year ({r['withoutBestYear']['year'] or '—'})", r["withoutBestYear"]["metrics"]),
            (f"Without best pair ({r['withoutBestPair']['pair'] or '—'})", r["withoutBestPair"]["metrics"]),
            (f"Without best session ({r['withoutBestSession']['session'] or '—'})", r["withoutBestSession"]["metrics"]),
            ("Without the 5 largest winners", r["withoutTop5Winners"])]), ""]
        if m["sensitivity"]:
            out += ["### Sensitivity (§22) — harsher costs and nearby parameters, for stability only", "",
                    table([(x["label"], x["metrics"]) for x in m["sensitivity"]]), ""]
        out += ["### Strategy funnel and gate", "", "| Pair | Sweeps | Reclaims | Displacements | FVGs | Setups | Refused: bias / target / R:R |",
                "|---|---|---|---|---|---|---|"]
        for sym, c in m["funnel"].items():
            out.append(f"| {sym} | {c['sweeps']} | {c['reclaims']} | {c['displacements']} | {c['fvgs']} | {c['setups']} | "
                       f"{c['rejectedBias']} / {c['rejectedTarget']} / {c['rejectedRewardToRisk']} |")
        g = m["afterCosts"]["gate"]
        out += ["", f"Gate: {g['setups']} setups → {g['approved']} approved, {g['rejected']} refused; {g['filled']} filled, "
                f"{g['missed']} missed (limit not reached), {g['invalidated']} cancelled on invalidation. Protective closes: "
                f"{m['afterCosts']['protectiveCloses']}.", ""]
        if g["blockedBy"]:
            out += ["| Check that refused | Count |", "|---|---|"] + [f"| {b['checkId']} | {b['count']} |" for b in g["blockedBy"]]
        out += ["", "### Prop-firm (§25)", "",
                "Strategy study: no prop-firm limits were applied (the firm is not known yet) — no daily loss limit, no drawdown "
                "limit short of a lost account, no position caps, no profit target — so the whole history was traded at 0.25 % risk "
                "per trade with the owner's strategy limits. The trading day (17:00 New York) and flat-before-the-weekend were kept. "
                "ASTRA replays the daily equity in summary.json against the firm's rules once they are known.", ""]
        if m["afterCosts"]["breach"]:
            out.append(f"The account was lost at {m['afterCosts']['breach']['at']}.")
    return "\n".join(out) + "\n"


def load_manifest(path, log):
    base = os.path.dirname(os.path.abspath(path))
    with open(path, encoding="utf-8") as f:
        man = json.load(f)
    server = man.get("serverTime")
    if isinstance(server, dict):
        server = server.get("utcOffsetMinutes")
    data, sources, assumptions, files_seen = {}, [], [], []
    for sym, p in man["pairs"].items():
        if sym not in INSTRUMENTS:
            raise SystemExit(f"{sym} is not one of the strategy's pairs ({', '.join(SYMBOLS)}): the strategy, its "
                             "limits and costs are defined for these three only")
        log(f"{sym}:")
        files = expand(base, p["files"])
        primary, rep1 = load_side(files, p["format"], server, log)
        ask_files = expand(base, p.get("askFiles", []))
        ask, rep2 = load_side(ask_files, p["format"], server, log) if ask_files else (None, [])
        spread_ticks = p.get("assumedSpreadTicks", 8)
        for label, side_bars in (("prices", primary), ("ask prices", ask or [])):
            if side_bars:
                closes = sorted(b[4] for b in side_bars)
                median = closes[len(closes) // 2]
                lo, hi = PLAUSIBLE[sym]
                if not lo <= median <= hi:
                    raise SystemExit(f"{sym}: the {label} in {', '.join(files if label == 'prices' else ask_files)} "
                                     f"have a median of {js_str(median)}, which is not {sym} (expected {lo}–{hi}). "
                                     "Wrong file for this pair?")
        bars = pair_sides(p.get("side", "BID"), primary, ask, INSTRUMENTS[sym]["tickSize"], spread_ticks)
        data[sym] = bars
        cov = coverage(sym, bars)
        sources.append({"symbol": sym, "files": [os.path.relpath(x, base) for x in files + ask_files],
                        "format": p["format"], "side": p.get("side", "BID"), "askFile": bool(ask_files),
                        "parse": rep1 + rep2, "coverage": cov})
        files_seen += files + ask_files
        if cov["spreadAssumed"] > 0:
            assumptions.append(f"{sym}: {cov['spreadAssumed']} of {cov['bars']} candles use an ASSUMED spread of "
                               f"{spread_ticks} ticks ({js_str(spread_ticks / 10)} pip) — no ask data for them.")
    calendar = None
    if man.get("calendar"):
        c = man["calendar"]
        events = []
        with open(os.path.join(base, c["file"]), encoding="utf-8") as f:
            for i, line in enumerate(x for x in f.read().splitlines() if x.strip()):
                if i == 0 and re.search("time", line, re.I):
                    continue
                parts = [x.strip() for x in line.split(",")]
                try:
                    at = parse_iso_ms(parts[0])
                except (ValueError, IndexError):
                    continue
                imp = (parts[2] if len(parts) > 2 else "").upper()
                if imp not in ("HIGH", "MEDIUM", "LOW", "HOLIDAY"):
                    continue
                cur = parts[1].upper() if len(parts) > 1 else None
                events.append({"at": at, "currency": cur, "impact": imp})
        calendar = {"source": c["source"], "from": parse_iso_ms(c["from"]), "to": parse_iso_ms(c["to"]), "events": events}
        files_seen.append(os.path.join(base, c["file"]))
    return data, sources, assumptions, calendar, files_seen


def cmd_run(a):
    t0 = time.time()

    def log(msg):
        print(msg, flush=True)

    data, sources, assumptions, calendar, files = load_manifest(a.manifest, log)
    day = lambda s: parse_iso_ms(f"{s[:10]}T00:00:00Z")  # noqa: E731
    from_ms, to_ms, oos_ms = day(a.start), day(a.end), day(a.oos)
    if calendar is None:
        assumptions.append("NEWS FILTER NOT MODELLED: no historical economic calendar was supplied, so the SPEC’s "
                           "±30-minute event blackout was not applied. Results include trades the live system would "
                           "have refused around events.")
    assumptions += [
        "Costs after costs: spread from the data (or as above), 2 ticks slippage on stops and protective closes, LIMIT "
        "fills only 1 tick through the limit, commission 7 USD per lot round turn (UNVERIFIED template). Before costs: "
        "mid prices, touch fills, no slippage, no commission.",
        "Instrument specs are UNVERIFIED templates (100k lots, 5/3 digits).",
        "Prop-firm: NOT applied (strategy study) — no firm loss limits, position caps or profit target, so the whole "
        "history is traded. Positions are still closed before the weekly close (Fri 16:00 New York; no weekend holding).",
        "Signals are sized and filtered like ASTRA’s gate: 0.25 % of equity per trade (compounding), the owner’s "
        "strategy limits, the risk policy’s exposure and activity limits.",
        f"Standalone kit {KIT_VERSION}: a Python copy of ASTRA's engine and research replay, checked trade-for-trade "
        "against ASTRA by its automated test.",
    ]
    cache = EventCache(data, log)
    models = []
    for model in [m.strip().upper() for m in a.models.split(",")]:
        log(f"Model {model}: after costs …")
        st, counters = run_study(data, cache, model, REALISTIC_COSTS, calendar, from_ms, to_ms, log=log)
        log(f"Model {model}: before costs …")
        before, _ = run_study(data, cache, model, NO_COSTS, calendar, from_ms, to_ms)
        sens = []
        if a.sensitivity:
            for label, cost_over, param_over in SENSITIVITY:
                log(f"Model {model}: sensitivity — {label} …")
                s2, _ = run_study(data, cache, model, {**REALISTIC_COSTS, **cost_over}, calendar, from_ms, to_ms, param_over)
                sens.append({"label": label, "metrics": metrics(s2.trades)})
        tr = st.trades
        models.append({
            "model": model,
            "afterCosts": {"metrics": metrics(tr), "endingBalance": money(st.broker.balance), "gate": {
                **st.counts, "blockedBy": [{"checkId": k, "count": v} for k, v in sorted(st.blocked.items(), key=lambda x: -x[1])]},
                "protectiveCloses": st.protective, "breach": st.breach},
            "beforeCosts": {"metrics": metrics(before.trades), "endingBalance": money(before.broker.balance)},
            "byPair": breakdown(tr, by_pair), "byDirection": breakdown(tr, by_direction),
            "bySession": breakdown(tr, by_session), "byYear": breakdown(tr, by_year), "byMonth": breakdown(tr, by_month),
            "split": split(tr, oos_ms), "walkForward": walk_forward(tr, from_ms, to_ms),
            "monteCarlo": monte_carlo(tr), "robustness": robustness(tr), "sensitivity": sens,
            "funnel": counters, "equity": st.equity, "_trades": tr, "_before": before.trades, "_setups": st.setup_log,
        })
    summary = {
        "kit": KIT_VERSION, "generatedAt": iso(int(time.time() * 1000)),
        "window": {"from": iso(from_ms), "to": iso(to_ms), "outOfSampleFrom": iso(oos_ms)},
        "data": sources, "assumptions": assumptions,
        "calendar": {"kind": "HISTORICAL", "source": calendar["source"]} if calendar else {"kind": "NOT_MODELLED"},
        "inputs": [{"file": os.path.basename(p), "bytes": os.path.getsize(p), "sha256": sha256(p)} for p in files],
        "models": models,
    }
    os.makedirs(a.out, exist_ok=True)
    for m in models:
        for name, rows in ((f"trades-{m['model']}.csv", m.pop("_trades")), (f"trades-{m['model']}-before-costs.csv", m.pop("_before"))):
            write_csv(os.path.join(a.out, name), [public_trade(t) for t in rows], TRADE_FIELDS)
        setups = m.pop("_setups")
        write_csv(os.path.join(a.out, f"setups-{m['model']}.csv"), [
            {**{k: s[k] for k in ("id", "symbol", "direction", "liquidity", "liquidityPrice", "strong", "structure",
                                   "sweepExtreme", "fvgLow", "fvgHigh", "entry", "stop", "target", "targetSource",
                                   "rewardToRisk", "atrM5", "score")},
             "detectedAt": iso(s["detectedAt"]), "expiresAt": iso(s["expiresAt"]), "approved": s["approved"],
             "quantity": s["quantity"], "refusedBy": " ".join(s["refusedBy"])} for s in setups],
            ["id", "symbol", "direction", "detectedAt", "expiresAt", "liquidity", "liquidityPrice", "strong", "structure",
             "sweepExtreme", "fvgLow", "fvgHigh", "entry", "stop", "target", "targetSource", "rewardToRisk", "atrM5",
             "score", "approved", "quantity", "refusedBy"])
    with open(os.path.join(a.out, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=1, ensure_ascii=False)
    with open(os.path.join(a.out, "report.md"), "w", encoding="utf-8") as f:
        f.write(render(summary))
    if a.sample_month:
        write_sample(data, a.sample_month, os.path.join(a.out, f"verify-sample-{a.sample_month}.csv.gz"))
    log(f"done in {round(time.time() - t0)} s — results in {a.out}/ (send the whole folder back)")


def csv_value(v):
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return js_str(v)
    s = str(v)
    return f'"{s}"' if "," in s or '"' in s else s


def write_csv(path, rows, fields):
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(",".join(fields) + "\n")
        for r in rows:
            f.write(",".join(csv_value(r.get(k)) for k in fields) + "\n")


def write_sample(data, month, path):
    """A small slice of the M5 bid/ask data (3 weeks of warm-up + the month) for ASTRA to cross-check."""
    start = parse_iso_ms(f"{month}-01T00:00:00Z")
    y, mth = int(month[:4]), int(month[5:7])
    end = parse_iso_ms(f"{y + (mth // 12)}-{mth % 12 + 1:02d}-01T00:00:00Z")
    lo = start - 21 * DAY
    with gzip.open(path, "wt", encoding="utf-8") as f:
        f.write("symbol,timestamp,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close,spread\n")
        for sym in SYMBOLS:
            for t, b, a, src in data.get(sym, []):
                if lo <= t < end:
                    f.write(",".join([sym, str(t), *(js_str(x) for x in b), *(js_str(x) for x in a), src]) + "\n")


# ---------------------------------------------------------------------------------------------
# Synthetic TEST data (a seeded random walk) — only to check that this file computes exactly
# what ASTRA computes. It is not market data and its results mean nothing about the strategy.
# ---------------------------------------------------------------------------------------------


def synthetic_m1(seed, start_ms, days):
    """M1 bid/ask for the three pairs: {symbol: (bid_rows, ask_rows)}, rows (t, o, h, l, c)."""
    out = {}
    for k, (sym, p0, vol) in enumerate((("EURUSD", 1.1, 0.00012), ("GBPUSD", 1.27, 0.00016), ("USDJPY", 148.0, 0.018))):
        nxt = _mulberry32(seed + k)
        tick = INSTRUMENTS[sym]["tickSize"]
        bid, ask = [], []
        p = p0
        regime = 1.0
        drift = 0.0
        impulse = 0
        push = 0.0
        t = start_ms
        end = start_ms + days * DAY
        while t < end:
            local = ny_local(t)
            wd, hm = local.isoweekday(), local.hour * 60 + local.minute
            weekend = (wd == 5 and hm >= 17 * 60) or wd == 6 or (wd == 7 and hm < 17 * 60)
            if weekend or nxt() < 0.002:  # the weekend close, and now and then a missing minute
                t += M1
                continue
            if nxt() < 0.01:
                regime = 0.5 + 3 * nxt()
            if nxt() < 0.003:  # a trend for a few hours (gives the H1 structure a direction)
                drift = (nxt() - 0.5) * 0.7 * vol
            if impulse == 0 and nxt() < 0.004:  # a burst: displacement candles
                impulse = 5 + math.floor(nxt() * 15)
                push = (1 if nxt() < 0.5 else -1) * (0.8 + nxt()) * vol
            steps = []
            q = p
            for _ in range(4):
                q += (nxt() - 0.5) * 2 * vol * regime + drift / 4 + (push / 2 if impulse > 0 else 0)
                steps.append(q)
            if impulse > 0:
                impulse -= 1
            o, c = p, steps[-1]
            h, l = max([o] + steps), min([o] + steps)
            rnd = lambda x: js_round(x / tick) * tick  # noqa: E731
            o, h, l, c = rnd(o), rnd(h), rnd(l), rnd(c)
            spread = (4 + math.floor(nxt() * 10) + (30 if nxt() < 0.01 else 0)) * tick
            bid.append((t, o, h, l, c))
            if nxt() > 0.003:
                ask.append((t, rnd(o + spread), rnd(h + spread), rnd(l + spread), rnd(c + spread)))
            p = c
            t += M1
        out[sym] = (bid, ask)
    return out


def write_synthetic(dirpath, seed=7, start="2026-01-05", days=70):
    os.makedirs(dirpath, exist_ok=True)
    data = synthetic_m1(seed, parse_iso_ms(f"{start}T00:00:00Z"), days)
    pairs = {}
    for sym, (bid, ask) in data.items():
        for side, rows in (("bid", bid), ("ask", ask)):
            with open(os.path.join(dirpath, f"{sym.lower()}-{side}.csv"), "w", encoding="utf-8") as f:
                f.write("timestamp,open,high,low,close,volume\n")
                for t, o, h, l, c in rows:
                    f.write(f"{t},{js_str(o)},{js_str(h)},{js_str(l)},{js_str(c)},1\n")
        pairs[sym] = {"format": "dukascopy", "side": "BID", "files": [f"{sym.lower()}-bid.csv"],
                      "askFiles": [f"{sym.lower()}-ask.csv"]}
    with open(os.path.join(dirpath, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"pairs": pairs}, f, indent=1)


def fingerprint(trades):
    h = hashlib.sha256()
    for t in trades:
        h.update(json.dumps(public_trade(t), sort_keys=True).encode())
    return h.hexdigest()[:16]


# ASTRA's own result on the synthetic test data — the parity test checks ASTRA produces exactly
# these trades (packages/research/test/kit-parity.test.ts); update both together.
SELFTEST_EXPECTED = {
    "A": {"trades": 14, "setups": 31, "fingerprint": "e70fc6058f2179a6"},
    "B": {"trades": 11, "setups": 24, "fingerprint": "1155c4b3584d7a18"},
}


def cmd_selftest(a):
    import tempfile
    ok = True
    # New York time against the system's time-zone database, when there is one.
    try:
        from zoneinfo import ZoneInfo
        ny = ZoneInfo("America/New_York")
        for y in range(2007, 2031):
            for mo in range(1, 13):
                for d in (1, 7, 8, 14, 15, 28):
                    for h in (1, 3, 6, 7, 12, 21):
                        ms = int(dt.datetime(y, mo, d, h, tzinfo=dt.timezone.utc).timestamp() * 1000)
                        want = dt.datetime.fromtimestamp(ms / 1000, ny).replace(tzinfo=None)
                        if ny_local(ms) != want:
                            print(f"FAIL New York time at {iso(ms)}: {ny_local(ms)} ≠ {want}")
                            ok = False
        print("New York time: checked against the system time-zone database")
    except Exception:  # noqa: BLE001 — no tz database (e.g. Windows without tzdata): skip
        print("New York time: no system time-zone database to compare with (built-in rules used)")
    with tempfile.TemporaryDirectory() as tmp:
        write_synthetic(tmp)
        data, _, _, _, _ = load_manifest(os.path.join(tmp, "manifest.json"), lambda _m: None)
        cache = EventCache(data, lambda _m: None)
        f, z = parse_iso_ms("2026-01-19T00:00:00Z"), parse_iso_ms("2026-03-16T00:00:00Z")
        for model in ("A", "B"):
            st, _ = run_study(data, cache, model, REALISTIC_COSTS, None, f, z)
            got = {"trades": len(st.trades), "setups": st.counts["setups"], "fingerprint": fingerprint(st.trades)}
            want = SELFTEST_EXPECTED[model]
            same = want == got
            ok = ok and same
            print(f"Model {model}: {got}" + ("  = ASTRA ✓" if same else f"  ≠ ASTRA {want}"))
    print("selftest OK — this Python reproduces ASTRA" if ok else "selftest FAILED — do not use these results")
    return 0 if ok else 1


def cmd_parity(a):
    """Machine-readable output for ASTRA's parity test (packages/research/test/kit-parity.test.ts)."""
    data, sources, _, calendar, _ = load_manifest(a.manifest, lambda _m: None)
    f, z = parse_iso_ms(a.start), parse_iso_ms(a.end)
    if a.events:
        # Scripted setups straight into the replay: the gate, the broker and the account's day.
        with open(a.events, encoding="utf-8") as fh:
            script = json.load(fh)
        evs = {sym: {} for sym in data}
        for e in script:
            evs[e["symbol"]].setdefault(e["index"], []).append(e)
        runs = {}
        for label, costs in (("after", REALISTIC_COSTS), ("spread2", {**REALISTIC_COSTS, "spreadMultiplier": 2})):
            st = Study(data, evs, costs, calendar, f, z).run()
            runs[label] = {"trades": [public_trade(t) for t in st.trades], "gate": st.counts,
                           "blockedBy": st.blocked, "endingBalance": money(st.broker.balance),
                           "protectiveCloses": st.protective}
        print(json.dumps({"runs": runs}))
        return 0
    cache = EventCache(data, lambda _m: None)
    out = {"coverage": [d["coverage"] for d in sources], "models": {}}
    for model in ("A", "B"):
        evs, counters = cache.get(model, {})
        runs = {}
        for label, costs, over in (("after", REALISTIC_COSTS, {}), ("before", NO_COSTS, {}),
                                   ("spread2", {**REALISTIC_COSTS, "spreadMultiplier": 2}, {}),
                                   ("wait6", REALISTIC_COSTS, {"entryWaitM5Candles": 6})):
            st, _ = run_study(data, cache, model, costs, calendar, f, z, over)
            runs[label] = {"trades": [public_trade(t) for t in st.trades], "gate": st.counts,
                           "blockedBy": st.blocked, "endingBalance": money(st.broker.balance),
                           "protectiveCloses": st.protective}
        events = []
        for sym in SYMBOLS:
            for i in sorted(evs.get(sym, {})):
                for e in evs[sym][i]:
                    events.append({"symbol": sym, "index": i, **{k: v for k, v in e.items()}})
        out["models"][model] = {"funnel": counters, "events": events, "runs": runs,
                                "metrics": metrics(Study(data, evs, REALISTIC_COSTS, calendar, f, z).run().trades)}
    print(json.dumps(out))
    return 0


def cmd_constants(_a):
    print(json.dumps({"instruments": INSTRUMENTS, "strategy": STRATEGY, "riskPolicy": RISK_POLICY, "system": SYSTEM,
                      "params": {k: v for k, v in DEFAULT_PARAMS.items() if not k.startswith("asian")},
                      "startingBalance": STARTING_BALANCE, "costs": REALISTIC_COSTS, "sensitivity": [
                          {"label": l, "costs": c, "params": p} for l, c, p in SENSITIVITY]}, indent=1))
    return 0


def cmd_compact(a):
    """M1 files → M5 files (gzip, ~15× smaller), same results: for uploading the data elsewhere."""
    base = os.path.dirname(os.path.abspath(a.manifest))
    with open(a.manifest, encoding="utf-8") as f:
        man = json.load(f)
    server = man.get("serverTime")
    if isinstance(server, dict):
        server = server.get("utcOffsetMinutes")
    os.makedirs(a.out, exist_ok=True)
    pairs = {}
    for sym, p in man["pairs"].items():
        print(f"{sym}:")
        entry = {"format": "generic", "side": p.get("side", "BID"), "files": [], "askFiles": []}
        if "assumedSpreadTicks" in p:
            entry["assumedSpreadTicks"] = p["assumedSpreadTicks"]
        for key, name in (("files", "bid"), ("askFiles", "ask")):
            files = expand(base, p.get(key, []))
            if not files:
                continue
            bars, _ = load_side(files, p["format"], server, print)
            out = f"{sym.lower()}-{name}-m5.csv.gz"
            with gzip.open(os.path.join(a.out, out), "wt", encoding="utf-8") as g:
                g.write("time,open,high,low,close,spread\n")
                for t, o, h, lo, c, sp in bars:
                    g.write(f"{t},{js_str(o)},{js_str(h)},{js_str(lo)},{js_str(c)},{'' if sp is None else js_str(sp)}\n")
            entry[key] = [out]
        pairs[sym] = entry
    with open(os.path.join(a.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"pairs": pairs, **({"calendar": man["calendar"]} if man.get("calendar") else {})}, f, indent=1)
    if man.get("calendar"):
        print("note: copy the calendar file next to the new manifest")
    print(f"M5 data and manifest in {a.out}/")
    return 0


def cmd_synthetic(a):
    write_synthetic(a.out, seed=a.seed, start=a.start, days=a.days)
    print(f"synthetic TEST data (not market data) in {a.out}/")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="LSFVG v1.0 research kit (standalone copy of ASTRA's research replay)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="run the study on your price files")
    r.add_argument("--manifest", required=True, help="ASTRA research manifest (see README.md)")
    r.add_argument("--from", dest="start", required=True)
    r.add_argument("--to", dest="end", required=True)
    r.add_argument("--oos", required=True, help="out-of-sample from this date (untouched period)")
    r.add_argument("--out", default="lsfvg-results")
    r.add_argument("--models", default="A,B")
    r.add_argument("--sensitivity", action="store_true", help="also run the 11 sensitivity variants (slower)")
    r.add_argument("--sample-month", default="2024-03",
                   help="write a small data sample of this month for ASTRA to cross-check ('' = none)")
    sub.add_parser("selftest", help="check this Python reproduces ASTRA on synthetic test data")
    sub.add_parser("constants", help="print the built-in configuration")
    co = sub.add_parser("compact", help="M1 files → small M5 files (gzip) with the same results")
    co.add_argument("--manifest", required=True)
    co.add_argument("--out", required=True)
    pa = sub.add_parser("parity", help="JSON output for ASTRA's parity test")
    pa.add_argument("--manifest", required=True)
    pa.add_argument("--from", dest="start", required=True)
    pa.add_argument("--to", dest="end", required=True)
    pa.add_argument("--events", help="scripted setups (JSON) instead of the engine's")
    s = sub.add_parser("synthetic", help="write synthetic TEST data (for the parity test)")
    s.add_argument("--out", required=True)
    s.add_argument("--seed", type=int, default=7)
    s.add_argument("--start", default="2026-01-05")
    s.add_argument("--days", type=int, default=70)
    a = ap.parse_args(argv)
    return {"run": cmd_run, "selftest": cmd_selftest, "constants": cmd_constants, "synthetic": cmd_synthetic,
            "parity": cmd_parity, "compact": cmd_compact}[a.cmd](a) or 0


if __name__ == "__main__":
    sys.exit(main())
