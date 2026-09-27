/**
 * Candles with the market structure drawn on them: swing points, structure breaks (BOS/CHoCH),
 * intact liquidity levels, sweeps and unfilled fair value gaps. Candles stay neutral (hollow =
 * up, filled = down) so the structure reads first; only the three overlay roles carry color
 * (palette validated all-pairs on the panel surface). Times are UTC.
 */
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Bar, MarketStructure } from '../api/types';
import { niceTicks, useWidth } from '../lib/chart';
import { num } from '../lib/format';

const HEIGHT = 300;
const PAD = { top: 16, right: 80, bottom: 24, left: 12 };
/** Tick labels closer than this to a price tag in the gutter are skipped. */
const TAG_CLEARANCE = 14;
const TAG_H = 16;

function timeLabel(iso: string, daily: boolean): string {
  return daily ? iso.slice(5, 10) : iso.slice(11, 16);
}

export function StructureChart({ bars, structure }: { bars: Bar[]; structure: MarketStructure }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const maxBars = Math.max(20, Math.min(120, Math.floor(plotW / 9)));
  const shown = useMemo(() => bars.slice(-maxBars), [bars, maxBars]);
  const daily = structure.timeframe === 'D1';

  const geo = useMemo(() => {
    if (shown.length === 0) return null;
    const lo = Math.min(...shown.map((b) => b.low));
    const hi = Math.max(...shown.map((b) => b.high));
    const range = hi - lo || Math.abs(hi) * 0.001 || 1;
    // Nearby liquidity joins the scale; far levels get an edge marker instead of squashing candles.
    let min = lo;
    let max = hi;
    const above = structure.nearestAbove?.level;
    const below = structure.nearestBelow?.level;
    if (above !== undefined && above - hi <= range * 0.6) max = Math.max(max, above);
    if (below !== undefined && lo - below <= range * 0.6) min = Math.min(min, below);
    const pad = (max - min) * 0.06 || 1;
    min -= pad;
    max += pad;
    const slot = plotW / shown.length;
    const index = new Map(shown.map((b, i) => [b.openTime, i]));
    const x = (i: number) => PAD.left + slot * (i + 0.5);
    const y = (p: number) => PAD.top + ((max - p) / (max - min)) * plotH;
    /** Index of the bar that closed at `iso` (events are stamped with the close time). */
    const closedAt = (iso: string) => shown.findIndex((b) => b.closeTime === iso);
    return { min, max, slot, x, y, closedAt, index };
  }, [shown, structure, plotW, plotH]);

  if (!geo || plotW <= 0) {
    return (
      <div ref={ref} className="chart-wrap">
        <p className="muted small">No bars to draw yet.</p>
      </div>
    );
  }
  const { x, y, slot, index, closedAt, min, max } = geo;
  const body = Math.max(1, Math.min(24, slot * 0.6));
  const right = PAD.left + plotW;
  const xEvery = Math.max(1, Math.ceil(shown.length / Math.max(2, Math.floor(plotW / 90))));

  const swings = structure.swings.filter((s) => index.has(s.time));
  const labelled = new Set(
    [
      ...swings.filter((s) => s.kind === 'HIGH').slice(-2),
      ...swings.filter((s) => s.kind === 'LOW').slice(-2),
    ].map((s) => `${s.kind}${s.time}`),
  );
  const breaks = structure.breaks
    .map((b) => ({ b, from: index.get(b.swingTime) ?? -1, to: closedAt(b.at) }))
    .filter((v) => v.to >= 0);
  const labelledBreaks = new Set(breaks.slice(-2).map((v) => v.b.at + v.b.direction));
  // Gaps formed inside the window are drawn; older open ones are counted below the chart.
  const gaps = structure.fvgs.map((g) => ({ g, i: closedAt(g.at) - 1 })).filter((v) => v.i >= 0);
  const olderGaps = structure.fvgs.length - gaps.length;
  const sweeps = structure.sweeps.map((s) => ({ s, i: closedAt(s.at) })).filter((v) => v.i >= 0);
  const levels = [structure.nearestAbove, structure.nearestBelow].filter((l) => l !== null);
  const poolLevels = structure.pools.filter((p) => !levels.some((l) => l.level === p.level));
  const lastClose = shown.at(-1)!.close;
  const tags = [
    ...levels
      .filter((l) => l.level <= max && l.level >= min)
      .map((l) => ({ key: l.side, price: l.level, className: 'level-tag' })),
    { key: 'last', price: lastClose, className: 'last-tag' },
  ];
  // Gutter tags never overlap: pushed apart (with a leader to their level) and kept in the plot.
  const placed = tags.map((t) => ({ ...t, ty: y(t.price) })).sort((a, b) => a.ty - b.ty);
  for (let k = 1; k < placed.length; k++)
    placed[k]!.ty = Math.max(placed[k]!.ty, placed[k - 1]!.ty + TAG_H + 2);
  const bottomLimit = PAD.top + plotH;
  for (let k = placed.length - 1; k >= 0; k--) {
    const limit = k === placed.length - 1 ? bottomLimit : placed[k + 1]!.ty - TAG_H - 2;
    placed[k]!.ty = Math.min(placed[k]!.ty, limit);
  }
  const yTicks = niceTicks(min, max, 5).filter((t) =>
    placed.every((tag) => Math.abs(y(t) - tag.ty) >= TAG_CLEARANCE),
  );

  const events = (i: number): string[] => {
    const b = shown[i]!;
    const out: string[] = [];
    for (const s of structure.swings)
      if (s.time === b.openTime)
        out.push(
          `Swing ${s.kind === 'HIGH' ? 'high' : 'low'} ${num(s.price, 5)}${s.label ? ` (${s.label})` : ''}`,
        );
    for (const e of structure.breaks)
      if (e.at === b.closeTime)
        out.push(
          `${e.type === 'CHOCH' ? 'CHoCH' : 'BOS'} ${e.direction === 'BULLISH' ? '▲' : '▼'} through ${num(e.level, 5)}`,
        );
    for (const s of structure.sweeps)
      if (s.at === b.closeTime)
        out.push(`Swept ${s.side === 'BUY_SIDE' ? 'high' : 'low'} ${num(s.level, 5)}`);
    for (const g of structure.fvgs)
      if (g.at === b.closeTime)
        out.push(
          `${g.direction === 'BULLISH' ? 'Bullish' : 'Bearish'} gap ${num(g.bottom, 5)}–${num(g.top, 5)}`,
        );
    return out;
  };

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - PAD.left) / slot);
    setHover(i >= 0 && i < shown.length ? i : null);
  };
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const d = e.key === 'ArrowLeft' ? -1 : 1;
    setHover((h) =>
      Math.max(0, Math.min(shown.length - 1, (h ?? shown.length - 1) + (h === null ? 0 : d))),
    );
  };
  const hb = hover === null ? null : shown[hover];
  const tipLeft =
    hover === null ? 0 : x(hover) > PAD.left + plotW / 2 ? x(hover) - 12 - 220 : x(hover) + 12;

  return (
    <div ref={ref} className="chart-wrap">
      <ul className="chart-legend" aria-label="Legend">
        <li>
          <svg width="12" height="12" aria-hidden>
            <rect x="3" y="1" width="6" height="10" className="k-candle-up" />
          </svg>
          Up candle
        </li>
        <li>
          <svg width="12" height="12" aria-hidden>
            <rect x="3" y="1" width="6" height="10" className="k-candle-down" />
          </svg>
          Down candle
        </li>
        <li>
          <svg width="14" height="12" aria-hidden>
            <circle cx="7" cy="6" r="4" className="m-swing" />
          </svg>
          Swing point
        </li>
        <li>
          <svg width="16" height="12" aria-hidden>
            <line x1="1" y1="6" x2="15" y2="6" className="m-break" />
          </svg>
          Structure break (BOS / CHoCH)
        </li>
        <li>
          <svg width="16" height="12" aria-hidden>
            <line x1="1" y1="6" x2="15" y2="6" className="m-liq" />
          </svg>
          Liquidity level
        </li>
        <li>
          <svg width="14" height="12" aria-hidden>
            <circle cx="7" cy="6" r="4" className="m-sweep" />
          </svg>
          Liquidity sweep
        </li>
        <li>
          <svg width="14" height="12" aria-hidden>
            <rect x="1" y="2" width="12" height="8" className="m-fvg" />
          </svg>
          Fair value gap
        </li>
      </ul>
      <svg
        width={width}
        height={HEIGHT}
        className="structure-chart"
        role="img"
        aria-label={`${structure.symbol ?? ''} ${structure.timeframe ?? ''} candles with market structure; arrow keys step through bars`}
        tabIndex={0}
        onPointerMove={pick}
        onPointerLeave={() => setHover(null)}
        onKeyDown={key}
        onBlur={() => setHover(null)}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={right} y1={y(t)} y2={y(t)} className="grid" />
            <text x={right + 6} y={y(t) + 4} className="axis">
              {num(t, 5)}
            </text>
          </g>
        ))}
        {shown.map((b, i) =>
          i % xEvery === 0 && x(i) >= 18 && x(i) <= right - 18 ? (
            <text key={b.openTime} x={x(i)} y={HEIGHT - 6} className="axis" textAnchor="middle">
              {timeLabel(b.openTime, daily)}
            </text>
          ) : null,
        )}

        {gaps.map(({ g, i }) => {
          // The gap sits at the middle bar of the three.
          const x0 = x(i) - slot / 2;
          const top = Math.min(
            max,
            g.status === 'PARTIAL' && g.direction === 'BULLISH' ? (g.mitigatedTo ?? g.top) : g.top,
          );
          const bottom = Math.max(
            min,
            g.status === 'PARTIAL' && g.direction === 'BEARISH'
              ? (g.mitigatedTo ?? g.bottom)
              : g.bottom,
          );
          if (top <= bottom) return null;
          return (
            <rect
              key={`fvg${g.at}`}
              x={x0}
              width={right - x0}
              y={y(top)}
              height={Math.max(1, y(bottom) - y(top))}
              className="m-fvg"
            />
          );
        })}

        {poolLevels.map((p) => (
          <line
            key={`pool${p.side}${p.level}`}
            x1={PAD.left}
            x2={right}
            y1={y(p.level)}
            y2={y(p.level)}
            className="m-liq faint"
          />
        ))}
        {levels.map((l) => {
          const i = index.get(l.swingTime);
          const inRange = l.level <= max && l.level >= min;
          if (!inRange) {
            const up = l.level > max;
            return (
              <text
                key={`edge${l.side}`}
                x={right - 4}
                y={up ? PAD.top + 10 : PAD.top + plotH - 4}
                className="label"
                textAnchor="end"
              >
                {up ? '↑' : '↓'} liquidity {num(l.level, 5)} (off chart)
              </text>
            );
          }
          const x0 = i === undefined ? PAD.left : x(i);
          return (
            <line
              key={`lvl${l.side}`}
              x1={x0}
              x2={right}
              y1={y(l.level)}
              y2={y(l.level)}
              className="m-liq"
            />
          );
        })}

        {shown.map((b, i) => {
          const up = b.close >= b.open;
          const top = y(Math.max(b.open, b.close));
          const h = Math.max(1, y(Math.min(b.open, b.close)) - top);
          return (
            <g key={b.openTime} className={b.complete ? undefined : 'live-bar'}>
              <line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} className="wick" />
              <rect
                x={x(i) - body / 2 + 0.5}
                width={Math.max(1, body - 1)}
                y={top}
                height={h}
                className={up ? 'k-candle-up' : 'k-candle-down'}
              />
            </g>
          );
        })}

        {breaks.map(({ b, from, to }) => {
          const x0 = from >= 0 ? x(from) : PAD.left;
          return (
            <g key={`brk${b.at}${b.direction}`}>
              <line x1={x0} x2={x(to)} y1={y(b.level)} y2={y(b.level)} className="m-break" />
              {labelledBreaks.has(b.at + b.direction) && (
                <text
                  x={x(to) - 4}
                  y={y(b.level) + (b.direction === 'BULLISH' ? 13 : -5)}
                  className="label"
                  textAnchor="end"
                >
                  {b.type === 'CHOCH' ? 'CHoCH' : 'BOS'}
                </text>
              )}
            </g>
          );
        })}

        {sweeps.map(({ s, i }) => (
          <circle
            key={`swp${s.at}${s.side}`}
            cx={x(i)}
            cy={y(s.extreme)}
            r={4}
            className="m-sweep"
          />
        ))}
        {swings.map((s) => {
          const i = index.get(s.time)!;
          const cy = y(s.price) + (s.kind === 'HIGH' ? -8 : 8);
          return (
            <g key={`sw${s.kind}${s.time}`}>
              <circle cx={x(i)} cy={cy} r={4} className="m-swing" />
              {labelled.has(`${s.kind}${s.time}`) && s.label && (
                <text
                  x={x(i)}
                  y={cy + (s.kind === 'HIGH' ? -8 : 15)}
                  className="label"
                  textAnchor="middle"
                >
                  {s.label}
                </text>
              )}
            </g>
          );
        })}

        <line x1={PAD.left} x2={right} y1={y(lastClose)} y2={y(lastClose)} className="last-line" />
        {placed.map((t) => (
          <g key={t.key}>
            {Math.abs(t.ty - y(t.price)) > 1 && (
              <line x1={right - 6} y1={y(t.price)} x2={right + 2} y2={t.ty} className="leader" />
            )}
            <rect
              x={right + 2}
              y={t.ty - TAG_H / 2}
              width={PAD.right - 4}
              height={TAG_H}
              rx={3}
              className={t.className}
            />
            <text x={right + 7} y={t.ty + 4} className="last-text">
              {num(t.price, 5)}
            </text>
          </g>
        ))}

        {hover !== null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={PAD.top}
            y2={PAD.top + plotH}
            className="crosshair"
          />
        )}
      </svg>
      {hb && hover !== null && (
        <div className="chart-tip" style={{ left: tipLeft, top: PAD.top + 28 }} role="status">
          <div className="tip-time">
            {hb.openTime.slice(0, 16).replace('T', ' ')} UTC{hb.complete ? '' : ' · in progress'}
          </div>
          <div className="tip-ohlc mono">
            O <b>{num(hb.open, 5)}</b> H <b>{num(hb.high, 5)}</b> L <b>{num(hb.low, 5)}</b> C{' '}
            <b>{num(hb.close, 5)}</b>
          </div>
          {events(hover).map((e) => (
            <div key={e} className="tip-event">
              {e}
            </div>
          ))}
        </div>
      )}
      {olderGaps > 0 && (
        <p className="muted small chart-note">
          {olderGaps} older open fair value gap{olderGaps === 1 ? '' : 's'} formed before this
          window {olderGaps === 1 ? 'is' : 'are'} not drawn.
        </p>
      )}
    </div>
  );
}
