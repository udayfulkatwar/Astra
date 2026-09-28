/**
 * Historical price data for research (SPEC §20). Genuine files only — nothing here generates or
 * fills prices. Parses common export formats into UTC candles, validates them (order, OHLC
 * consistency, gaps), aggregates M1 to M5 and pairs bid with ask.
 *
 * Formats:
 * - `generic`   — header row with time,open,high,low,close[,spread]; time ISO-8601 or epoch
 *                 (s or ms), UTC.
 * - `histdata`  — HistData.com Generic ASCII M1: `20200102 170000;o;h;l;c;v`, bid prices, times
 *                 in EST WITHOUT daylight saving (UTC−5 all year).
 * - `mt5`       — MetaTrader 5 export: <DATE> <TIME> <OPEN> <HIGH> <LOW> <CLOSE> <TICKVOL> <VOL>
 *                 <SPREAD> (tab or comma), bid prices, SPREAD in points; broker server time, so
 *                 its offset must be given (fixed minutes, or `NY+7` for the common UTC+2/+3
 *                 server that follows US daylight saving).
 * - `dukascopy` — dukascopy-node CSV: timestamp(ms UTC),open,high,low,close[,volume]; one file
 *                 per side (bid / ask).
 */
import { DateTime } from 'luxon';

export type DataFormat = 'generic' | 'histdata' | 'mt5' | 'dukascopy';
export type ServerTime = { readonly utcOffsetMinutes: number } | 'NY+7';

export interface Ohlc {
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

export interface RawBar extends Ohlc {
  /** Period start, epoch ms UTC. */
  readonly t: number;
  /** Spread in points (ticks) when the file reports it (MT5). */
  readonly spreadPoints?: number;
}

export interface ParseReport {
  readonly rows: number;
  readonly parsed: number;
  /** Rows that could not be read or failed OHLC consistency (dropped, never repaired). */
  readonly invalid: number;
  readonly duplicates: number;
  /** Rows that were out of time order (sorted, counted). */
  readonly outOfOrder: number;
  readonly examples: readonly string[];
}

export interface ParseOptions {
  readonly format: DataFormat;
  /** MT5 only: the broker server's time zone. */
  readonly serverTime?: ServerTime;
}

const MINUTE = 60_000;

function num(s: string | undefined): number {
  const n = Number((s ?? '').trim());
  return Number.isFinite(n) ? n : NaN;
}

function valid(b: Ohlc): boolean {
  return (
    b.o > 0 &&
    b.h > 0 &&
    b.l > 0 &&
    b.c > 0 &&
    b.l <= Math.min(b.o, b.c) &&
    b.h >= Math.max(b.o, b.c)
  );
}

function genericTime(s: string): number {
  const v = s.trim();
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return n > 1e12 ? n : n * 1000; // ms or s
  }
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

function mt5Time(date: string, time: string, server: ServerTime | undefined): number {
  if (!server) return NaN;
  const [y, mo, d] = date.trim().split('.').map(Number);
  const [hh, mm, ss] = `${time.trim()}:00`.split(':').map(Number);
  if ([y, mo, d, hh, mm].some((x) => !Number.isFinite(x))) return NaN;
  if (server === 'NY+7') {
    // Server clock = New York time + 7 h (UTC+2 in US winter, UTC+3 in US summer).
    const ny = DateTime.fromObject(
      { year: y, month: mo, day: d, hour: hh, minute: mm, second: ss ?? 0 },
      { zone: 'America/New_York' },
    ).minus({ hours: 7 });
    return ny.toMillis();
  }
  return Date.UTC(y!, mo! - 1, d, hh, mm, ss ?? 0) - server.utcOffsetMinutes * MINUTE;
}

/** Parses one file's text into UTC candles (sorted, de-duplicated) and a report of what was dropped. */
export function parseBars(
  text: string,
  opts: ParseOptions,
): { bars: RawBar[]; report: ParseReport } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const out: RawBar[] = [];
  const examples: string[] = [];
  let invalid = 0;
  const bad = (line: string, why: string) => {
    invalid++;
    if (examples.length < 5) examples.push(`${why}: ${line.slice(0, 80)}`);
  };
  let header: string[] | null = null;
  for (const line of lines) {
    const sep = line.includes('\t') ? '\t' : line.includes(';') ? ';' : ',';
    const f = line.split(sep).map((x) => x.trim());
    if (opts.format === 'generic' || opts.format === 'dukascopy' || opts.format === 'mt5') {
      if (header === null && f.some((x) => /[a-zA-Z<]/.test(x) && !/^\d/.test(x))) {
        header = f.map((x) => x.replace(/[<>]/g, '').toLowerCase());
        continue;
      }
    }
    let t: number;
    let bar: Ohlc;
    let spreadPoints: number | undefined;
    if (opts.format === 'histdata') {
      // 20200102 170000;o;h;l;c;v — EST (UTC−5), no daylight saving.
      const m = /^(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})(\d{2})$/.exec(f[0] ?? '');
      if (!m) {
        bad(line, 'unreadable time');
        continue;
      }
      t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) + 5 * 60 * MINUTE;
      bar = { o: num(f[1]), h: num(f[2]), l: num(f[3]), c: num(f[4]) };
    } else if (opts.format === 'mt5') {
      const idx = (name: string, fallback: number) => {
        const i = header?.indexOf(name) ?? -1;
        return i >= 0 ? i : fallback;
      };
      t = mt5Time(f[idx('date', 0)] ?? '', f[idx('time', 1)] ?? '', opts.serverTime);
      bar = {
        o: num(f[idx('open', 2)]),
        h: num(f[idx('high', 3)]),
        l: num(f[idx('low', 4)]),
        c: num(f[idx('close', 5)]),
      };
      const sp = num(f[idx('spread', 8)]);
      if (Number.isFinite(sp)) spreadPoints = sp;
      if (!opts.serverTime) {
        bad(line, 'MT5 server time zone not given');
        continue;
      }
    } else {
      const idx = (names: string[], fallback: number) => {
        for (const n of names) {
          const i = header?.indexOf(n) ?? -1;
          if (i >= 0) return i;
        }
        return fallback;
      };
      t = genericTime(f[idx(['time', 'timestamp', 'date', 'datetime', 'gmt time'], 0)] ?? '');
      bar = {
        o: num(f[idx(['open'], 1)]),
        h: num(f[idx(['high'], 2)]),
        l: num(f[idx(['low'], 3)]),
        c: num(f[idx(['close'], 4)]),
      };
      const si = header?.indexOf('spread') ?? -1;
      if (si >= 0 && Number.isFinite(num(f[si]))) spreadPoints = num(f[si]);
    }
    if (!Number.isFinite(t)) {
      bad(line, 'unreadable time');
      continue;
    }
    if (!valid(bar)) {
      bad(line, 'invalid OHLC');
      continue;
    }
    out.push({ t, ...bar, ...(spreadPoints !== undefined ? { spreadPoints } : {}) });
  }
  let outOfOrder = 0;
  for (let i = 1; i < out.length; i++) if (out[i]!.t < out[i - 1]!.t) outOfOrder++;
  out.sort((a, b) => a.t - b.t);
  const bars: RawBar[] = [];
  let duplicates = 0;
  for (const b of out) {
    if (bars.length > 0 && bars.at(-1)!.t === b.t) {
      duplicates++;
      continue;
    }
    bars.push(b);
  }
  return {
    bars,
    report: {
      rows: lines.length - (header ? 1 : 0),
      parsed: bars.length,
      invalid,
      duplicates,
      outOfOrder,
      examples,
    },
  };
}

/** Candle spacing (minutes) most common in the series. */
export function detectMinutes(bars: readonly RawBar[]): number | null {
  const counts = new Map<number, number>();
  for (let i = 1; i < Math.min(bars.length, 5_000); i++) {
    const d = (bars[i]!.t - bars[i - 1]!.t) / MINUTE;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best: [number, number] | null = null;
  for (const e of counts) if (!best || e[1] > best[1]) best = e;
  return best ? best[0] : null;
}

/** M1 (or M5) → M5 aligned to UTC multiples of 5 minutes. A missing minute is never invented. */
export function toM5(bars: readonly RawBar[]): RawBar[] {
  const out: RawBar[] = [];
  let cur: {
    t: number;
    o: number;
    h: number;
    l: number;
    c: number;
    sp: number | undefined;
  } | null = null;
  for (const b of bars) {
    const t = Math.floor(b.t / (5 * MINUTE)) * 5 * MINUTE;
    if (cur && cur.t !== t) {
      out.push(finish(cur));
      cur = null;
    }
    if (!cur) cur = { t, o: b.o, h: b.h, l: b.l, c: b.c, sp: b.spreadPoints };
    else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      // The widest spread reported in the period (conservative).
      if (b.spreadPoints !== undefined) cur.sp = Math.max(cur.sp ?? 0, b.spreadPoints);
    }
  }
  if (cur) out.push(finish(cur));
  return out;
}

function finish(c: {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  sp: number | undefined;
}): RawBar {
  return {
    t: c.t,
    o: c.o,
    h: c.h,
    l: c.l,
    c: c.c,
    ...(c.sp !== undefined ? { spreadPoints: c.sp } : {}),
  };
}

/** A research candle: both sides of the market for one M5 period. */
export interface ResearchBar {
  readonly t: number;
  readonly bid: Ohlc;
  readonly ask: Ohlc;
  /** DATA: ask from the file (ask series or reported spread); ASSUMED: bid + the assumed spread. */
  readonly spread: 'DATA' | 'ASSUMED';
}

export interface SideInput {
  /** BID (most exports) or MID (then half the assumed spread is added / subtracted). */
  readonly side: 'BID' | 'MID';
  readonly bars: readonly RawBar[];
}

/**
 * Pairs a bid (or mid) series with an ask series when there is one. Without ask data the ask is
 * the bid plus `assumedSpreadTicks` (stated as ASSUMED in every result), or the spread the file
 * reported for that candle.
 */
export function pairSides(
  primary: SideInput,
  ask: readonly RawBar[] | null,
  tickSize: number,
  assumedSpreadTicks: number,
): ResearchBar[] {
  const askAt = new Map((ask ?? []).map((b) => [b.t, b]));
  const round = (x: number) => Math.round(x / tickSize) * tickSize;
  return primary.bars.map((p) => {
    const a = askAt.get(p.t);
    if (a && primary.side === 'BID') return { t: p.t, bid: p, ask: a, spread: 'DATA' as const };
    const ticks = p.spreadPoints ?? assumedSpreadTicks;
    const source = p.spreadPoints !== undefined ? ('DATA' as const) : ('ASSUMED' as const);
    const spread = ticks * tickSize;
    const shift = (b: Ohlc, d: number): Ohlc => ({
      o: round(b.o + d),
      h: round(b.h + d),
      l: round(b.l + d),
      c: round(b.c + d),
    });
    return primary.side === 'MID'
      ? { t: p.t, bid: shift(p, -spread / 2), ask: shift(p, spread / 2), spread: source }
      : { t: p.t, bid: p, ask: shift(p, spread), spread: source };
  });
}

export interface Coverage {
  readonly symbol: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly bars: number;
  /** Weekday gaps longer than 30 minutes (outside the weekend close). */
  readonly gaps: number;
  readonly largestGapMinutes: number;
  readonly spreadFromData: number;
  readonly spreadAssumed: number;
}

export function coverage(symbol: string, bars: readonly ResearchBar[]): Coverage {
  let gaps = 0;
  let largest = 0;
  for (let i = 1; i < bars.length; i++) {
    const gap = (bars[i]!.t - bars[i - 1]!.t) / MINUTE;
    if (gap <= 30) continue;
    // Friday close → Sunday open is the market's weekend, not a data gap.
    const day = new Date(bars[i - 1]!.t).getUTCDay();
    const weekend = gap >= 24 * 60 && (day === 5 || day === 6 || day === 0);
    if (weekend) continue;
    gaps++;
    largest = Math.max(largest, gap);
  }
  return {
    symbol,
    from: bars.length ? new Date(bars[0]!.t).toISOString() : null,
    to: bars.length ? new Date(bars.at(-1)!.t + 5 * MINUTE).toISOString() : null,
    bars: bars.length,
    gaps,
    largestGapMinutes: largest,
    spreadFromData: bars.filter((b) => b.spread === 'DATA').length,
    spreadAssumed: bars.filter((b) => b.spread === 'ASSUMED').length,
  };
}

export const mid = (b: ResearchBar): Ohlc => ({
  o: (b.bid.o + b.ask.o) / 2,
  h: (b.bid.h + b.ask.h) / 2,
  l: (b.bid.l + b.ask.l) / 2,
  c: (b.bid.c + b.ask.c) / 2,
});
