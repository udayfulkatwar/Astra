/**
 * Interactive candlestick chart (TradingView Lightweight Charts™, Apache-2.0 — see
 * THIRD_PARTY_NOTICES.md). Draws exactly the bars it is given: gaps stay gaps, the in-progress
 * candle is drawn muted, times are UTC. The TradingView attribution logo stays on (licence).
 */
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import type { Bar } from '../api/types';
import { toCandles } from '../lib/candles';

/** The browser's locale when Intl accepts it (some report tags like `en-US@posix`), else en-US. */
function safeLocale(): string {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([navigator.language])[0] ?? 'en-US';
  } catch {
    return 'en-US';
  }
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function CandleChart({
  bars,
  precision,
  viewKey,
  label,
}: {
  bars: readonly Bar[];
  /** Price decimals (from the instrument's tick size). */
  precision: number;
  /** Changing it (symbol / timeframe) scrolls back to the latest candle. */
  viewKey: string;
  /** Accessible summary of what is drawn. */
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const colors = useRef({ up: '#22c55e', down: '#ef4444' });
  const shownKey = useRef<string | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const up = cssVar('--ok', '#22c55e');
    const down = cssVar('--bad', '#ef4444');
    colors.current = { up, down };
    const c = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: cssVar('--panel', '#0c111a') },
        textColor: cssVar('--muted', '#7d8ba1'),
        fontFamily: cssVar('--mono', 'monospace'),
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: cssVar('--viz-grid', '#1a2332') },
        horzLines: { color: cssVar('--viz-grid', '#1a2332') },
      },
      localization: { locale: safeLocale() },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: cssVar('--border', '#1c2636') },
      timeScale: {
        borderColor: cssVar('--border', '#1c2636'),
        timeVisible: true,
        secondsVisible: false,
      },
    });
    series.current = c.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      wickUpColor: up,
      wickDownColor: down,
      borderVisible: false,
    });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
      shownKey.current = null;
    };
  }, []);

  useEffect(() => {
    series.current?.applyOptions({
      priceFormat: { type: 'price', precision, minMove: 10 ** -precision },
    });
  }, [precision]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const { up, down } = colors.current;
    const data: CandlestickData<UTCTimestamp>[] = toCandles(bars, {
      up: `${up}66`,
      down: `${down}66`,
    }).map((c) => ({ ...c, time: c.time as UTCTimestamp }));
    s.setData(data);
    if (shownKey.current !== viewKey && data.length > 0) {
      shownKey.current = viewKey;
      chart.current?.timeScale().scrollToRealTime();
    }
  }, [bars, viewKey]);

  return <div ref={host} className="candle-chart" role="img" aria-label={label} />;
}
