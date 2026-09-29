#!/usr/bin/env python3
"""
Downloads genuine Dukascopy M1 candles (bid and ask) for the research tool — Python standard
library only (urllib honours HTTPS_PROXY; lzma decodes the .bi5 files).

    python3 dukascopy_download.py --from 2020-01-01 --to 2026-09-27 --out research-data

Resumable: every day file is kept in <out>/.cache as soon as it arrives, so an interrupted run —
or one stopped on purpose with --max-minutes, for tools that limit how long a command may run —
continues where it stopped when the same command is run again. When every day is there it writes
<out>/<pair>-<bid|ask>.csv as `timestamp,open,high,low,close,volume` (epoch ms, UTC) — the
research manifest's "dukascopy" format — plus <out>/manifest.json and a download log, then
removes the cache. Exit code 0 = complete, 3 = not complete yet (run it again), 1 = failures that
did not go away. Nothing is filled in or repaired: a day the feed does not have is recorded as
missing, never invented.

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
import shutil
import struct
import sys
import time
import urllib.error
import urllib.request

POINT = {"USDJPY": 1e3}  # other pairs: 1e5
RECORD = struct.Struct(">5I f")
BASE = "https://datafeed.dukascopy.com/datafeed"
PATH = "{pair}/{y:04d}/{m:02d}/{d:02d}/{side}_candles_min_1.bi5"
SIDES = ("BID", "ASK")


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


def fetch(base_url: str, pair: str, side: str, day: dt.date, retries: int) -> tuple:
    """(raw bytes | b'' for no data | None on failure, error text)."""
    url = f"{base_url}/" + PATH.format(pair=pair, y=day.year, m=day.month - 1, d=day.day, side=side)
    delay = 2.0
    err = ""
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return r.read(), ""
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return b"", "404"
            err = f"HTTP {e.code}"
        except Exception as e:  # network error: retried
            err = str(e)
        if attempt < retries:
            time.sleep(delay)
            delay *= 2
    return None, err


def fmt_row(point: float, row: tuple) -> str:
    t, o, h, lo, c, v = row
    f = "{:.3f}" if point == 1e3 else "{:.5f}"
    return f"{t},{f.format(o)},{f.format(h)},{f.format(lo)},{f.format(c)},{v:g}\n"


def cache_file(cache: str, pair: str, side: str, day: dt.date) -> str:
    return os.path.join(cache, f"{pair}-{side}", f"{day.isoformat()}.csv")


def download_day(base_url, cache, pair, side, day, retries):
    """Fetches, decodes and caches one day file. Returns (pair, side, day, error or None)."""
    raw, err = fetch(base_url, pair, side, day, retries)
    if raw is None:
        return pair, side, day, err
    try:
        rows = decode(raw, day, POINT.get(pair, 1e5))
    except (lzma.LZMAError, ValueError) as e:
        return pair, side, day, f"undecodable: {e}"
    path = cache_file(cache, pair, side, day)
    tmp = path + ".part"
    with open(tmp, "w") as f:  # an empty file = no data that day
        f.writelines(fmt_row(POINT.get(pair, 1e5), r) for r in rows)
    os.replace(tmp, path)  # complete files only: an interrupted run leaves no half day
    return pair, side, day, None


def assemble(out, cache, pairs, days, start, end):
    log = {"source": "datafeed.dukascopy.com", "from": start, "to": end, "pairs": {}}
    manifest = {"pairs": {}}
    for pair in pairs:
        entry = {}
        for side in SIDES:
            path = os.path.join(out, f"{pair.lower()}-{side.lower()}.csv")
            candles, missing, invalid = 0, [], 0
            with open(path, "w") as f:
                f.write("timestamp,open,high,low,close,volume\n")
                for day in days:
                    with open(cache_file(cache, pair, side, day)) as g:
                        lines = g.readlines()
                    if not lines:
                        if day.weekday() < 5:
                            missing.append(str(day))
                        continue
                    for line in lines:
                        _, o, h, lo, c, _ = (float(x) for x in line.split(","))
                        if not (lo <= min(o, c) and h >= max(o, c)):
                            invalid += 1  # reported, left as it is (the research tool drops it)
                    candles += len(lines)
                    f.writelines(lines)
            entry[side] = {"file": os.path.basename(path), "candles": candles,
                           "weekdaysMissing": len(missing), "missingWeekdays": missing[:50],
                           "invalidCandles": invalid, "failedCount": 0}
            print(f"{pair} {side}: {candles} M1 candles, {len(missing)} weekdays without data, "
                  f"{invalid} candles with inconsistent OHLC", flush=True)
        log["pairs"][pair] = entry
        manifest["pairs"][pair] = {"format": "dukascopy", "side": "BID",
                                   "files": [entry["BID"]["file"]], "askFiles": [entry["ASK"]["file"]]}
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    with open(os.path.join(out, "download-log.json"), "w") as f:
        json.dump(log, f, indent=2)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Dukascopy M1 bid/ask downloader (resumable)")
    p.add_argument("--pairs", default="EURUSD,GBPUSD,USDJPY")
    p.add_argument("--from", dest="start", required=True)
    p.add_argument("--to", dest="end", required=True, help="exclusive")
    p.add_argument("--out", default="research-data")
    p.add_argument("--workers", type=int, default=12)
    p.add_argument("--retries", type=int, default=4)
    p.add_argument("--max-minutes", type=float, default=None,
                   help="stop cleanly after this long; run the same command again to continue")
    p.add_argument("--keep-cache", action="store_true", help="keep the day files after assembling")
    p.add_argument("--base-url", default=BASE, help=argparse.SUPPRESS)  # tests: a local server
    a = p.parse_args(argv)
    t0 = time.time()
    deadline = t0 + a.max_minutes * 60 if a.max_minutes is not None else None
    start, end = dt.date.fromisoformat(a.start), dt.date.fromisoformat(a.end)
    days = [start + dt.timedelta(n) for n in range((end - start).days)]
    pairs = [x.strip().upper() for x in a.pairs.split(",") if x.strip()]
    cache = os.path.join(a.out, ".cache")
    log_path = os.path.join(a.out, "download-log.json")
    if os.path.exists(log_path) and not os.path.exists(cache):
        with open(log_path) as f:
            prev = json.load(f)
        if prev.get("from") == a.start and prev.get("to") == a.end and sorted(prev.get("pairs", {})) == sorted(pairs):
            print(f"COMPLETE: already downloaded — data and manifest.json in {a.out}/", flush=True)
            return 0
    for pair in pairs:
        for side in SIDES:
            os.makedirs(os.path.join(cache, f"{pair}-{side}"), exist_ok=True)
    todo = [(pair, side, day) for pair in pairs for side in SIDES for day in days
            if not os.path.exists(cache_file(cache, pair, side, day))]
    total = len(pairs) * len(SIDES) * len(days)
    done = total - len(todo)
    print(f"{done} of {total} day files already here; {len(todo)} to download", flush=True)
    failed = []
    stopped = False
    step = max(1, total // 40)
    with concurrent.futures.ThreadPoolExecutor(a.workers) as pool:
        pending = set()
        it = iter(todo)
        while True:
            while len(pending) < a.workers * 2 and not stopped:
                if deadline is not None and time.time() >= deadline:
                    stopped = True
                    break
                task = next(it, None)
                if task is None:
                    break
                pending.add(pool.submit(download_day, a.base_url, cache, *task, a.retries))
            if not pending:
                break
            finished, pending = concurrent.futures.wait(pending, return_when=concurrent.futures.FIRST_COMPLETED)
            for fut in finished:
                pair, side, day, err = fut.result()
                if err:
                    failed.append(f"{pair} {side} {day}: {err}")
                else:
                    done += 1
                    if done % step == 0 or done == total:
                        print(f"  {done}/{total} day files ({100 * done // total} %) — "
                              f"{round(time.time() - t0)} s", flush=True)
    if failed:
        print(f"{len(failed)} day files failed this run (they are retried next run), e.g. {failed[:3]}",
              file=sys.stderr, flush=True)
    if done < total:
        print(f"NOT COMPLETE: {done} of {total} day files. Run the same command again to continue.",
              flush=True)
        return 3 if stopped or not failed else 1
    assemble(a.out, cache, pairs, days, a.start, a.end)
    if not a.keep_cache:
        shutil.rmtree(cache)
    print(f"COMPLETE: data and manifest.json in {a.out}/", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
