/**
 * Cumulative R by trade (one series: the title names it, so no legend box). A solid zero line is
 * the reference; the deepest R drawdown is marked. Hover or arrow keys show the trade under the
 * crosshair; the same points are available as a table below the chart.
 */
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { LearningReport } from '../api/types';
import { niceTicks, useWidth } from '../lib/chart';
import { money, num } from '../lib/format';

const HEIGHT = 220;
const PAD = { top: 12, right: 56, bottom: 24, left: 12 };

export function RCurveChart({ report }: { report: LearningReport }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const points = report.curve;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  const geo = useMemo(() => {
    if (points.length === 0) return null;
    let min = Math.min(0, ...points.map((p) => p.cumR));
    let max = Math.max(0, ...points.map((p) => p.cumR));
    const pad = (max - min) * 0.1 || 1;
    min -= pad;
    max += pad;
    const x = (i: number) =>
      PAD.left + (points.length === 1 ? plotW / 2 : (plotW * i) / (points.length - 1));
    const y = (v: number) => PAD.top + ((max - v) / (max - min)) * plotH;
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.cumR).toFixed(1)}`);
    // Deepest drawdown: the lowest point after the running peak.
    let peak = 0;
    let worst = { dd: 0, i: -1 };
    points.forEach((p, i) => {
      peak = Math.max(peak, p.cumR);
      if (peak - p.cumR > worst.dd) worst = { dd: peak - p.cumR, i };
    });
    const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(plotW / 70))));
    return { min, max, x, y, line: line.join(''), ddIndex: worst.i, every };
  }, [points, plotW, plotH]);

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    if (!geo) return;
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
  const h = hover === null ? null : points[hover];
  const last = points.at(-1);

  return (
    <div className="chart-wrap" ref={ref}>
      {geo && width > 0 && (
        <svg
          className="equity-chart"
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`Cumulative R over ${report.trades} trades: ${num(last?.cumR ?? 0, 2)} R at the end; deepest drawdown ${num(report.drawdown.maxR, 2)} R.`}
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
                {num(v, 1)} R
              </text>
            </g>
          ))}
          {points.map((p, i) =>
            i % geo.every === 0 || i === points.length - 1 ? (
              <text
                key={p.n}
                className="axis"
                x={geo.x(i)}
                y={HEIGHT - 6}
                textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
              >
                #{p.n}
              </text>
            ) : null,
          )}
          <line
            className="r-zero"
            x1={PAD.left}
            x2={PAD.left + plotW}
            y1={geo.y(0)}
            y2={geo.y(0)}
          />
          <path className="eq-line" d={geo.line} fill="none" />
          {geo.ddIndex >= 0 && (
            <circle
              className="eq-dd"
              cx={geo.x(geo.ddIndex)}
              cy={geo.y(points[geo.ddIndex]!.cumR)}
              r={4}
            />
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
              <circle className="eq-hover" cx={geo.x(hover)} cy={geo.y(h.cumR)} r={3.5} />
            </g>
          )}
        </svg>
      )}
      {h && hover !== null && geo && (
        <div
          className="chart-tip"
          style={{
            left: Math.min(Math.max(0, geo.x(hover) - 110), Math.max(0, width - 220)),
            top: 8,
          }}
        >
          <div className="tip-time">
            trade #{h.n} · {h.t.slice(0, 10)} {h.t.slice(11, 16)} UTC
          </div>
          <div className="tip-ohlc">
            cumulative <b>{num(h.cumR, 2)} R</b> · <b>{money(h.cumPnl)}</b>
          </div>
        </div>
      )}
      <details className="chart-table">
        <summary className="muted small">Show as a table</summary>
        <div className="table-scroll">
          <table className="table compact">
            <thead>
              <tr>
                <th className="num">Trade</th>
                <th>Closed (UTC)</th>
                <th className="num">Cumulative R</th>
                <th className="num">Cumulative P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.n}>
                  <td className="num">#{p.n}</td>
                  <td className="mono small">
                    {p.t.slice(0, 10)} {p.t.slice(11, 16)}
                  </td>
                  <td className="num">{num(p.cumR, 2)}</td>
                  <td className="num">{money(p.cumPnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
