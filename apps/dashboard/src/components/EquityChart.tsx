/**
 * Backtest equity curve: equity marked at each minute close (downsampled — each point keeps its
 * interval's last mark, and the shaded band reaches down to the interval's lowest mark), the
 * starting balance as a dashed baseline, and the deepest drawdown marked. The x axis steps
 * through recorded points, so closed-market hours take no space. Times are UTC.
 */
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { BacktestResult } from '../api/types';
import { niceTicks, useWidth } from '../lib/chart';
import { money } from '../lib/format';

const HEIGHT = 240;
const PAD = { top: 14, right: 78, bottom: 24, left: 12 };

const compact = (v: number, currency: string) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    notation: Math.abs(v) >= 100_000 ? 'compact' : 'standard',
    maximumFractionDigits: 0,
  }).format(v);

export function EquityChart({ result }: { result: BacktestResult }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const points = result.equity;
  const start = result.performance.startingBalance;
  const currency = result.account.currency;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  const geo = useMemo(() => {
    if (points.length === 0) return null;
    let min = Math.min(start, ...points.map((p) => p.low));
    let max = Math.max(start, ...points.map((p) => p.equity));
    const pad = (max - min) * 0.08 || Math.max(1, start * 0.001);
    min -= pad;
    max += pad;
    const x = (i: number) =>
      PAD.left + (points.length === 1 ? plotW / 2 : (plotW * i) / (points.length - 1));
    const y = (v: number) => PAD.top + ((max - v) / (max - min)) * plotH;
    const line = points.map(
      (p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`,
    );
    const band =
      points
        .map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`)
        .join('') +
      points
        .map((p, i) => [i, p] as const)
        .reverse()
        .map(([i, p]) => `L${x(i).toFixed(1)},${y(p.low).toFixed(1)}`)
        .join('') +
      'Z';
    const ddAt = result.performance.maxDrawdownAt;
    const ddIndex = ddAt === null ? -1 : points.findIndex((p) => p.t >= ddAt);
    // One date label per day at most, spaced at least ~90px apart.
    const minGap = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(plotW / 90))));
    const labels: number[] = [];
    points.forEach((pt, i) => {
      const prev = labels.at(-1);
      if (
        prev === undefined ||
        (i - prev >= minGap && pt.t.slice(0, 10) !== points[prev]!.t.slice(0, 10))
      )
        labels.push(i);
    });
    return { min, max, x, y, line: line.join(''), band, ddIndex, labels };
  }, [points, start, plotW, plotH, result.performance.maxDrawdownAt]);

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    if (!geo || points.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left - PAD.left) / Math.max(1, plotW);
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(rel * (points.length - 1)))));
  };
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.key === 'ArrowLeft' ? -1 : 1;
    setHover((h) => Math.max(0, Math.min(points.length - 1, (h ?? points.length - 1) + step)));
  };

  const p = result.performance;
  const summary = `Equity from ${money(start, currency)} to ${money(p.endingEquity, currency)}; deepest drawdown ${money(p.maxDrawdown, currency)}.`;
  const h = hover === null ? null : points[hover];

  return (
    <div className="chart-wrap" ref={ref}>
      <ul className="chart-legend" aria-hidden="true">
        <li>
          <svg width="18" height="8">
            <line x1="0" y1="4" x2="18" y2="4" className="eq-line" />
          </svg>
          Equity (marked each minute)
        </li>
        <li>
          <svg width="14" height="10">
            <rect width="14" height="10" className="eq-band" />
          </svg>
          Lowest mark in each interval
        </li>
        <li>
          <svg width="18" height="8">
            <line x1="0" y1="4" x2="18" y2="4" className="eq-base" />
          </svg>
          Starting balance
        </li>
        <li>
          <svg width="10" height="10">
            <circle cx="5" cy="5" r="4" className="eq-dd" />
          </svg>
          Deepest drawdown
        </li>
      </ul>
      {geo && width > 0 && (
        <svg
          className="equity-chart"
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={summary}
          tabIndex={0}
          onPointerMove={pick}
          onPointerLeave={() => setHover(null)}
          onKeyDown={key}
          onBlur={() => setHover(null)}
        >
          {niceTicks(geo.min, geo.max, 4).map((v) => (
            <g key={v}>
              <line
                className="grid"
                x1={PAD.left}
                x2={PAD.left + plotW}
                y1={geo.y(v)}
                y2={geo.y(v)}
              />
              <text className="axis" x={PAD.left + plotW + 6} y={geo.y(v) + 4}>
                {compact(v, currency)}
              </text>
            </g>
          ))}
          {geo.labels.map((i) => (
            <text
              key={points[i]!.t}
              className="axis"
              x={geo.x(i)}
              y={HEIGHT - 6}
              textAnchor={i === 0 ? 'start' : 'middle'}
            >
              {points[i]!.t.slice(5, 10)}
            </text>
          ))}
          <path className="eq-band" d={geo.band} />
          <line
            className="eq-base"
            x1={PAD.left}
            x2={PAD.left + plotW}
            y1={geo.y(start)}
            y2={geo.y(start)}
          />
          <path className="eq-line" d={geo.line} fill="none" />
          {geo.ddIndex >= 0 && p.maxDrawdown > 0 && (
            <g>
              <circle
                className="eq-dd"
                cx={geo.x(geo.ddIndex)}
                cy={geo.y(points[geo.ddIndex]!.low)}
                r={4}
              />
              <text
                className="label"
                x={geo.x(geo.ddIndex)}
                y={geo.y(points[geo.ddIndex]!.low) + 16}
                textAnchor={geo.ddIndex > points.length * 0.8 ? 'end' : 'middle'}
              >
                max drawdown −{money(p.maxDrawdown, currency)}
              </text>
            </g>
          )}
          {hover !== null && h && (
            <g>
              <line
                className="crosshair"
                x1={geo.x(hover)}
                x2={geo.x(hover)}
                y1={PAD.top}
                y2={PAD.top + plotH}
              />
              <circle className="eq-hover" cx={geo.x(hover)} cy={geo.y(h.equity)} r={3.5} />
            </g>
          )}
        </svg>
      )}
      {h && hover !== null && geo && (
        <div
          className="chart-tip"
          style={{
            left: Math.min(Math.max(0, geo.x(hover) - 110), Math.max(0, width - 220)),
            top: 28,
          }}
        >
          <div className="tip-time">
            {h.t.slice(0, 10)} {h.t.slice(11, 16)} UTC
          </div>
          <div className="tip-ohlc">
            equity <b>{money(h.equity, currency)}</b> · balance <b>{money(h.balance, currency)}</b>
          </div>
          {h.low < h.equity && (
            <div className="tip-ohlc">
              lowest in interval <b>{money(h.low, currency)}</b>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
