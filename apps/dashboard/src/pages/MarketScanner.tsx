/**
 * Market scanner (spec §12): per instrument, the DATA the strategy layer will use — price,
 * spread, market status, sessions, day and previous-day levels, volatility — derived from real
 * bars only. Structure detection (BOS, CHoCH, liquidity) is Phase 5.
 */
import { Fragment, useState } from 'react';
import { ApiError } from '../api/client';
import { useBars, useQuotes, useScanner, useStructure } from '../api/hooks';
import type { MarketSnapshot, MarketStructure, Timeframe } from '../api/types';
import { StructureChart } from '../components/StructureChart';
import { Card, Empty, ErrorBox, Loading, PageHeader, Pill } from '../components/ui';
import { ago, num, pct } from '../lib/format';

const COLUMNS = 11;

const QUALITY_TONE: Record<MarketSnapshot['quality']['status'], string> = {
  OK: 'ONLINE',
  STALE: 'UNKNOWN',
  SUSPECT: 'CRITICAL',
  NO_DATA: 'UNAVAILABLE',
};

/**
 * Where price sits against today's range and the previous day's high/low, drawn to one scale.
 * Returns null unless every input is real data.
 */
function RangeBar({ s }: { s: MarketSnapshot }) {
  if (s.mid === null || !s.today || !s.previousDay) return <span className="muted">—</span>;
  const lo = Math.min(s.today.low, s.previousDay.low, s.mid);
  const hi = Math.max(s.today.high, s.previousDay.high, s.mid);
  if (hi <= lo) return <span className="muted">—</span>;
  const x = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  return (
    <div
      className="range"
      title={`PDL ${s.previousDay.low} · PDH ${s.previousDay.high} · today ${s.today.low}–${s.today.high} · price ${s.mid}`}
    >
      <div className="range-track" />
      <div
        className="range-today"
        style={{ left: x(s.today.low), width: `calc(${x(s.today.high)} - ${x(s.today.low)})` }}
      />
      <div className="range-level" style={{ left: x(s.previousDay.low) }} data-label="PDL" />
      <div className="range-level" style={{ left: x(s.previousDay.high) }} data-label="PDH" />
      <div className="range-price" style={{ left: x(s.mid) }} />
    </div>
  );
}

function Scanner() {
  const { data, error } = useScanner();
  if (error instanceof ApiError && error.status === 404) {
    return (
      <Empty>
        Scanner data is not available from this ASTRA server yet (market-data engine, Phase 2).
      </Empty>
    );
  }
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  if (data.snapshots.length === 0) return <Empty>No instruments configured.</Empty>;
  return (
    <div className="table-scroll">
      <table className="table scanner">
        <thead>
          <tr>
            <th>Instrument</th>
            <th className="num">Price</th>
            <th className="num">Spread</th>
            <th>Market</th>
            <th>Sessions</th>
            <th className="num">Today</th>
            <th className="num">Prev day</th>
            <th className="num">Chg</th>
            <th>Range (PDL → PDH)</th>
            <th className="num">ATR(14)</th>
            <th>Data</th>
          </tr>
        </thead>
        <tbody>
          {data.snapshots.map((s) => (
            <Fragment key={s.symbol}>
              <tr className={s.quality.reason ? 'has-note' : undefined}>
                <td className="strong">{s.symbol}</td>
                <td className="num">{num(s.mid, 5)}</td>
                <td className="num">
                  {s.spreadTicks === null ? '—' : `${num(s.spreadTicks, 1)} t`}
                </td>
                <td>
                  {s.market === null ? (
                    <Pill status="UNKNOWN" label="HOURS UNKNOWN" />
                  ) : s.market.open ? (
                    <>
                      <Pill status="ONLINE" label="OPEN" />
                      <div className="muted small">
                        {Math.floor(s.market.minutesToClose ?? 0)} min to close
                      </div>
                    </>
                  ) : (
                    <Pill status="DISABLED" label="CLOSED" />
                  )}
                </td>
                <td className="small stack">
                  {s.activeSessions.length ? (
                    s.activeSessions.map((id) => <div key={id}>{id}</div>)
                  ) : (
                    <span className="muted">none</span>
                  )}
                </td>
                <td className="num stack">
                  {s.today ? (
                    <>
                      <div>O {num(s.today.open, 5)}</div>
                      <div>H {num(s.today.high, 5)}</div>
                      <div>L {num(s.today.low, 5)}</div>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="num stack">
                  {s.previousDay ? (
                    <>
                      <div>H {num(s.previousDay.high, 5)}</div>
                      <div>L {num(s.previousDay.low, 5)}</div>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td
                  className={`num ${s.changeFromPrevClosePct === null ? '' : s.changeFromPrevClosePct < 0 ? 'tone-text-bad' : 'tone-text-ok'}`}
                >
                  {s.changeFromPrevClosePct === null ? '—' : pct(s.changeFromPrevClosePct, 2)}
                </td>
                <td>
                  <RangeBar s={s} />
                </td>
                <td className="num stack">
                  <div>H1 {num(s.atr.H1, 2)}</div>
                  <div>D1 {num(s.atr.D1, 2)}</div>
                </td>
                <td>
                  <Pill status={QUALITY_TONE[s.quality.status]} label={s.quality.status} />
                </td>
              </tr>
              {s.quality.reason && (
                <tr className="scanner-note">
                  <td colSpan={COLUMNS}>
                    <span className="muted small">
                      {s.symbol} data {s.quality.status}: {s.quality.reason}
                    </span>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STRUCTURE_TIMEFRAMES: Timeframe[] = ['M5', 'M15', 'H1', 'H4', 'D1'];
const TF_KEY = 'astra.structure.timeframe';

function savedTimeframe(): Timeframe {
  try {
    const v = window.localStorage.getItem(TF_KEY);
    return STRUCTURE_TIMEFRAMES.find((t) => t === v) ?? 'H1';
  } catch {
    return 'H1';
  }
}

type Structure = MarketStructure;
type Level = NonNullable<Structure['nearestAbove']>;
type Swing = NonNullable<Structure['lastSwingHigh']>;

function LevelCell({ level, close }: { level: Level | null; close: number | null }) {
  if (!level) return <span className="muted">none</span>;
  const kind =
    level.kind === 'EQUAL_LEVELS'
      ? level.side === 'BUY_SIDE'
        ? 'equal highs'
        : 'equal lows'
      : level.side === 'BUY_SIDE'
        ? 'swing high'
        : 'swing low';
  return (
    <>
      <div>{num(level.level, 5)}</div>
      <div className="muted small">
        {kind}
        {close !== null && ` · ${num(Math.abs(level.level - close), 5)} away`}
      </div>
    </>
  );
}

function SwingCell({ swing }: { swing: Swing | null }) {
  if (!swing) return <span className="muted">—</span>;
  return (
    <>
      <div>
        {num(swing.price, 5)} {swing.label && <span className="tag">{swing.label}</span>}
      </div>
      <div className="muted small">
        {swing.status === 'INTACT' ? 'intact' : swing.status.toLowerCase()} ·{' '}
        {ago(swing.confirmedAt)}
      </div>
    </>
  );
}

function BreakCell({ s }: { s: Structure }) {
  const b = s.lastBreak;
  if (!b) return <span className="muted">none yet</span>;
  return (
    <>
      <div>
        <span className="tag">{b.type === 'CHOCH' ? 'CHoCH' : 'BOS'}</span>{' '}
        {b.direction === 'BULLISH' ? '▲' : '▼'} {num(b.level, 5)}
      </div>
      <div className="muted small">{ago(b.at)}</div>
    </>
  );
}

function TrendPill({ trend }: { trend: Structure['trend'] }) {
  if (trend === 'UP') return <Pill status="INFO" tone="info" label="▲ UP" />;
  if (trend === 'DOWN') return <Pill status="INFO" tone="info" label="▼ DOWN" />;
  return <Pill status="UNKNOWN" label="UNKNOWN" />;
}

function StructureCard() {
  const [tf, setTf] = useState<Timeframe>(savedTimeframe);
  const [selected, setSelected] = useState<string | null>(null);
  const { data, error, isPlaceholderData } = useStructure(tf);
  const structures = data?.structures ?? [];
  const current =
    structures.find((s) => s.symbol === selected) ?? structures.find((s) => s.sufficient) ?? null;
  const bars = useBars(current?.symbol ?? null, tf, 150);
  const choose = (t: Timeframe) => {
    setTf(t);
    try {
      window.localStorage.setItem(TF_KEY, t);
    } catch {
      /* per-viewer convenience only */
    }
  };

  return (
    <Card
      title="Market structure"
      actions={
        <div className="segmented" role="group" aria-label="Timeframe">
          {STRUCTURE_TIMEFRAMES.map((t) => (
            <button
              key={t}
              type="button"
              className={t === tf ? 'active' : undefined}
              aria-pressed={t === tf}
              onClick={() => choose(t)}
            >
              {t}
            </button>
          ))}
        </div>
      }
    >
      {error instanceof ApiError && error.status === 404 ? (
        <Empty>Structure data is not available from this ASTRA server yet.</Empty>
      ) : error ? (
        <ErrorBox error={error} />
      ) : !data ? (
        <Loading />
      ) : (
        <div className={isPlaceholderData ? 'refetching' : undefined}>
          <div className="table-scroll">
            <table className="table scanner structure">
              <thead>
                <tr>
                  <th>Instrument</th>
                  <th>Trend</th>
                  <th>Last break</th>
                  <th className="num">Swing high</th>
                  <th className="num">Swing low</th>
                  <th className="num">Liquidity above</th>
                  <th className="num">Liquidity below</th>
                  <th className="num">Open gaps</th>
                </tr>
              </thead>
              <tbody>
                {structures.map((s) => (
                  <tr
                    key={s.symbol ?? ''}
                    className={s.symbol === current?.symbol ? 'selected' : undefined}
                  >
                    <td className="strong">
                      <button
                        type="button"
                        className="linklike"
                        onClick={() => setSelected(s.symbol)}
                        aria-pressed={s.symbol === current?.symbol}
                      >
                        {s.symbol}
                      </button>
                    </td>
                    {s.sufficient ? (
                      <>
                        <td>
                          <TrendPill trend={s.trend} />
                        </td>
                        <td className="stack">
                          <BreakCell s={s} />
                        </td>
                        <td className="num stack">
                          <SwingCell swing={s.lastSwingHigh} />
                        </td>
                        <td className="num stack">
                          <SwingCell swing={s.lastSwingLow} />
                        </td>
                        <td className="num stack">
                          <LevelCell level={s.nearestAbove} close={s.lastClose} />
                        </td>
                        <td className="num stack">
                          <LevelCell level={s.nearestBelow} close={s.lastClose} />
                        </td>
                        <td className="num">{s.fvgs.length}</td>
                      </>
                    ) : (
                      <td colSpan={7} className="muted">
                        Not enough complete {tf} bars yet ({s.barsAnalysed} of{' '}
                        {2 * s.params.swingStrength + 1} needed) — nothing is inferred.
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {current && bars.data && (
            <div className="structure-chart-block">
              <h3 className="chart-title">
                {current.symbol} · {tf} · last {Math.min(bars.data.bars.length, 150)} bars (UTC)
              </h3>
              <StructureChart bars={bars.data.bars} structure={current} />
            </div>
          )}
          <p className="muted small">
            From complete bars only — nothing repaints. Swing strength{' '}
            {data.structures[0]?.params.swingStrength ?? '—'}, equal-level tolerance per instrument
            (ADR-0010). These are ASTRA&apos;s default definitions, not strategy rules — review them
            with your strategy (Phase 5).
          </p>
        </div>
      )}
    </Card>
  );
}

export function MarketScanner() {
  const quotes = useQuotes();
  return (
    <div className="page">
      <PageHeader
        title="Market Scanner"
        subtitle="Market DATA per instrument, derived from real bars only — missing values show as —, never estimated."
      />
      <Card title="Instruments">
        <Scanner />
      </Card>
      <Card title="Latest quotes">
        {quotes.error ? (
          <ErrorBox error={quotes.error} />
        ) : !quotes.data ? (
          <Loading />
        ) : quotes.data.quotes.length === 0 ? (
          <Empty>No quotes received — market data UNAVAILABLE.</Empty>
        ) : (
          <table className="table compact">
            <thead>
              <tr>
                <th>Symbol</th>
                <th className="num">Bid</th>
                <th className="num">Ask</th>
                <th>Source</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {quotes.data.quotes.map((q) => (
                <tr key={q.value.symbol}>
                  <td className="strong">{q.value.symbol}</td>
                  <td className="num">{num(q.value.bid, 5)}</td>
                  <td className="num">{num(q.value.ask, 5)}</td>
                  <td>
                    <Pill
                      status={q.sourceKind === 'SIMULATED' ? 'SHADOW' : 'INFO'}
                      label={`${q.source} · ${q.sourceKind}`}
                    />
                  </td>
                  <td className="muted">{ago(q.asOf)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <StructureCard />
    </div>
  );
}
