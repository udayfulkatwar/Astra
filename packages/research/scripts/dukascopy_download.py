#!/usr/bin/env python3
"""
Downloads genuine Dukascopy M1 candles (bid and ask) for the research tool — Python standard
library only (urllib honours HTTPS_PROXY; lzma decodes the .bi5 files).

    python3 packages/research/scripts/dukascopy_download.py \
        --pairs EURUSD,GBPUSD,USDJPY --from 2020-01-01 --to 2026-09-01 --out research-data

Writes <out>/<pair>-<bid|ask>.csv as `timestamp,open,high,low,close,volume` (epoch ms, UTC)
— the research manifest's "dukascopy" format — plus <out>/manifest.json and a download log.
Nothing is filled in: a day the feed does not have is recorded as missing, never invented.

Dukascopy day file: https://datafeed.dukascopy.com/datafeed/{PAIR}/{YYYY}/{MM0}/{DD}/{SIDE}_candles_min_1.bi5
(MM0 = month − 1). Content: LZMA ("alone" format) of 24-byte big-endian records
(seconds from 00:00 UTC, open, close, low, high as integers in points, volume as float32).
"""
import argparse
import concurrent.futures
import datetime as dt
import json
import lzma
import os
import struct
import sys
import time
import urllib.error
import urllib.request

POINT = {"USDJPY": 1e3}  # other pairs: 1e5
RECORD = struct.Struct(">5I f")
URL = "https://datafeed.dukascopy.com/datafeed/{pair}/{y:04d}/{m:02d}/{d:02d}/{side}_candles_min_1.bi5"


def decode(raw: bytes, day: dt.date, point: float) -> list:
    """Candle records of one day file (empty for a day without trading)."""
    if not raw:
        return []
    data = lzma.decompress(raw, format=lzma.FORMAT_ALONE)
    if len(data) % RECORD.size:
        raise ValueError(f"{day}: {len(data)} bytes is not a whole number of candles")
    base = int(dt.datetime(day.year, day.month, day.day, tzinfo=dt.timezone.utc).timestamp() * 1000)
    out = []
    for off in range(0, len(data), RECORD.size):
        secs, o, c, lo, hi, vol = RECORD.unpack_from(data, off)
        out.append((base + secs * 1000, o / point, hi / point, lo / point, c / point, vol))
    return out


def fetch(pair: str, side: str, day: dt.date, retries: int = 4) -> tuple:
    url = URL.format(pair=pair, y=day.year, m=day.month - 1, d=day.day, side=side)
    delay = 2.0
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return day, r.read(), None
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return day, b"", "404"
            err = f"HTTP {e.code}"
        except Exception as e:  # network error: retried
            err = str(e)
        if attempt < retries:
            time.sleep(delay)
            delay *= 2
    return day, None, err


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--pairs", default="EURUSD,GBPUSD,USDJPY")
    p.add_argument("--from", dest="start", required=True)
    p.add_argument("--to", dest="end", required=True)
    p.add_argument("--out", default="research-data")
    p.add_argument("--workers", type=int, default=12)
    a = p.parse_args()
    start = dt.date.fromisoformat(a.start)
    end = dt.date.fromisoformat(a.end)
    days = [start + dt.timedelta(n) for n in range((end - start).days)]
    os.makedirs(a.out, exist_ok=True)
    log = {"source": "datafeed.dukascopy.com", "from": a.start, "to": a.end, "pairs": {}}
    manifest = {"pairs": {}}
    for pair in [x.strip().upper() for x in a.pairs.split(",") if x.strip()]:
        point = POINT.get(pair, 1e5)
        entry = {}
        for side in ("BID", "ASK"):
            rows, missing, failed = [], [], []
            with concurrent.futures.ThreadPoolExecutor(a.workers) as pool:
                for day, raw, err in pool.map(lambda d: fetch(pair, side, d), days):
                    if raw is None:
                        failed.append(f"{day}: {err}")
                        continue
                    if err == "404" or not raw:
                        if day.weekday() < 5:
                            missing.append(str(day))
                        continue
                    rows.extend(decode(raw, day, point))
            rows.sort()
            path = os.path.join(a.out, f"{pair.lower()}-{side.lower()}.csv")
            with open(path, "w") as f:
                f.write("timestamp,open,high,low,close,volume\n")
                fmt = "{:.3f}" if point == 1e3 else "{:.5f}"
                for t, o, h, lo, c, v in rows:
                    f.write(f"{t},{fmt.format(o)},{fmt.format(h)},{fmt.format(lo)},{fmt.format(c)},{v:g}\n")
            entry[side] = {"file": os.path.basename(path), "candles": len(rows),
                           "weekdaysMissing": len(missing), "failed": failed[:20], "failedCount": len(failed)}
            print(f"{pair} {side}: {len(rows)} M1 candles, {len(missing)} weekdays without data, {len(failed)} failed downloads", flush=True)
            if failed:
                print(f"  first failures: {failed[:3]}", file=sys.stderr, flush=True)
        log["pairs"][pair] = entry
        manifest["pairs"][pair] = {"format": "dukascopy", "side": "BID",
                                   "files": [entry["BID"]["file"]], "askFiles": [entry["ASK"]["file"]]}
    with open(os.path.join(a.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    with open(os.path.join(a.out, "download-log.json"), "w") as f:
        json.dump(log, f, indent=2)
    total_failed = sum(s["failedCount"] for e in log["pairs"].values() for s in e.values())
    return 1 if total_failed else 0


if __name__ == "__main__":
    sys.exit(main())
