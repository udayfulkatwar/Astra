/**
 * Market scanner (spec §12): per instrument, the DATA the strategy layer will use — price,
 * spread, market status, sessions, day and previous-day levels, volatility — derived from real
 * bars only. Structure detection (BOS, CHoCH, liquidity) is Phase 5.
 */
import { Fragment } from 'react';
import { ApiError } from '../api/client';
import { useQuotes, useScanner } from '../api/hooks';
import type { MarketSnapshot } from '../api/types';
import { Card, Empty, ErrorBox, Loading, NotBuilt, PageHeader, Pill } from '../components/ui';
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
      <Card title="Market structure">
        <NotBuilt
          phase="Phase 5"
          what="Market-structure detection (swings, BOS, CHoCH, liquidity)"
        />
      </Card>
    </div>
  );
}
