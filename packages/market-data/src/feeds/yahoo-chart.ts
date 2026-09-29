/**
 * Backfill from Yahoo Finance's public chart endpoint, so charts start with history instead of
 * an empty screen. Free, no account, no API key. The request and response shape are those the
 * open-source yfinance client uses (Apache-2.0, `yfinance/scrapers/history.py`, `utils.py`):
 *
 *   GET https://query2.finance.yahoo.com/v8/finance/chart/{symbol}?range=5d&interval=1m
 *   → chart.result[0].timestamp[] (epoch s) + indicators.quote[0].{open,high,low,close,volume}[]
 *
 * Only genuine, complete, consistent 1-minute candles are kept: nulls and inconsistent candles
 * are dropped (counted), the minute still in progress is left out, nothing is filled.
 */
import type { DataSourceKind, TradingHours } from '@astra/core';
import type { Bar } from '../bar';
import { rollUp } from '../rollup';
import type { Timeframe } from '../timeframe';

export const YAHOO_CHART_URL = 'https://query2.finance.yahoo.com/v8/finance/chart';

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface YahooBackfillOptions {
  /** ASTRA symbol the bars are for. */
  readonly symbol: string;
  /** Yahoo's symbol (e.g. `EURUSD=X`). */
  readonly providerSymbol: string;
  /** Data source name and kind of the bars (those of the stream that continues them). */
  readonly source: string;
  readonly sourceKind: DataSourceKind;
  readonly nowMs: number;
  /** Timeframes to build from the 1-minute candles (M1 included if listed). */
  readonly timeframes: readonly Timeframe[];
  readonly tradingHours: TradingHours | undefined;
  /** Yahoo range (1-minute history is offered for the last few days only). Default `5d`. */
  readonly range?: string;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  /** Aborts the request (shutdown). */
  readonly signal?: AbortSignal;
}

export interface YahooBackfillResult {
  readonly bars: Bar[];
  /** 1-minute candles received / kept / dropped (null or inconsistent values). */
  readonly received: number;
  readonly kept: number;
  readonly dropped: number;
}

interface ChartJson {
  chart?: {
    result?: {
      timestamp?: (number | null)[];
      indicators?: {
        quote?: {
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }[];
      };
    }[];
    error?: { code?: string; description?: string } | null;
  };
}

const MINUTE = 60_000;

/** Parses a chart response into complete 1-minute bars (pure; exported for tests). */
export function parseYahooChart(
  json: unknown,
  o: Pick<YahooBackfillOptions, 'symbol' | 'source' | 'sourceKind' | 'nowMs'>,
): { bars: Bar[]; received: number; dropped: number } {
  const chart = (json as ChartJson | null)?.chart;
  if (!chart) throw new Error('not a chart response');
  if (chart.error) throw new Error(`chart error: ${chart.error.description ?? chart.error.code}`);
  const r = chart.result?.[0];
  const ts = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0];
  if (!r || !q) throw new Error('chart response without candles');
  const bars: Bar[] = [];
  let dropped = 0;
  const seen = new Set<number>();
  ts.forEach((t, i) => {
    const o1 = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    const v = q.volume?.[i];
    const openMs = typeof t === 'number' ? t * 1000 : NaN;
    const ok =
      Number.isFinite(openMs) &&
      openMs % MINUTE === 0 &&
      [o1, h, l, c].every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0) &&
      l! <= Math.min(o1!, c!) &&
      h! >= Math.max(o1!, c!);
    if (!ok || seen.has(openMs)) {
      dropped++;
      return;
    }
    if (openMs + MINUTE > o.nowMs) return; // the minute still in progress
    seen.add(openMs);
    bars.push({
      symbol: o.symbol,
      timeframe: 'M1',
      openTime: new Date(openMs).toISOString(),
      closeTime: new Date(openMs + MINUTE).toISOString(),
      open: o1!,
      high: h!,
      low: l!,
      close: c!,
      // FX "volume" on Yahoo is 0: no volume information, so null (never 0).
      volume: typeof v === 'number' && v > 0 ? v : null,
      tickCount: 0,
      complete: true,
      source: o.source,
      sourceKind: o.sourceKind,
    });
  });
  bars.sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime));
  return { bars, received: ts.length, dropped };
}

/** Fetches recent 1-minute history and builds the requested timeframes from it. */
export async function yahooBackfill(o: YahooBackfillOptions): Promise<YahooBackfillResult> {
  const fetchFn = o.fetch ?? (globalThis as unknown as { fetch?: FetchLike }).fetch ?? missingFetch;
  const url = `${o.baseUrl ?? YAHOO_CHART_URL}/${encodeURIComponent(o.providerSymbol)}?range=${encodeURIComponent(o.range ?? '5d')}&interval=1m&includePrePost=true`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 15_000);
  const abort = () => controller.abort();
  o.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (o.signal?.aborted) throw new Error('aborted');
    const res = await fetchFn(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (ASTRA market-data backfill)' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { bars: m1, received, dropped } = parseYahooChart(await res.json(), o);
    const out: Bar[] = [];
    for (const tf of o.timeframes) {
      out.push(...(tf === 'M1' ? m1 : rollUp(m1, tf, o.tradingHours, o.nowMs)));
    }
    return { bars: out, received, kept: m1.length, dropped };
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', abort);
  }
}

const missingFetch: FetchLike = () => Promise.reject(new Error('no fetch in this runtime'));
