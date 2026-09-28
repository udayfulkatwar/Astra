/**
 * Learning Metrics (spec §32, ADR-0018): what recorded trades say, by strategy, instrument,
 * long/short, session, hour, weekday, setup, event context and exit — from the trade journal or
 * from a backtest run. Every group shows its sample size and a 95 % range for its average R;
 * small samples are marked. Observations only: nothing here changes any setting.
 */
import { useMemo, useState } from 'react';
import { ApiError } from '../api/client';
import { useBacktests, useConfigSummary, useLearning } from '../api/hooks';
import type { GroupStats, LearningResponse } from '../api/types';
import { duration } from '../components/JournalViews';
import { RCurveChart } from '../components/RCurveChart';
import { Card, Empty, ErrorBox, KV, Loading, PageHeader, Pill, Stat } from '../components/ui';
import { money, num } from '../lib/format';

const MODES = ['PAPER', 'SHADOW', 'LIVE'] as const;
const r = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${num(v, 2)} R`;
const tone = (v: number | null | undefined) =>
  v === null || v === undefined ? '' : v < 0 ? 'tone-text-bad' : v > 0 ? 'tone-text-ok' : '';

/** Average R as a bar from zero (profit / loss hue) with its 95 % range as a thin whisker. */
function RBar({ g, scale }: { g: GroupStats; scale: number }) {
  if (g.avgR === null) return null;
  const W = 120;
  const mid = W / 2;
  const x = (v: number) => mid + (Math.max(-scale, Math.min(scale, v)) / scale) * (mid - 3);
  const x0 = Math.min(mid, x(g.avgR));
  const w = Math.max(1, Math.abs(x(g.avgR) - mid));
  return (
    <svg className="rbar" width={W} height={14} aria-hidden="true">
      <title>
        {`avg ${num(g.avgR, 2)} R${g.avgRLow !== null ? ` (95% range ${num(g.avgRLow, 2)} to ${num(g.avgRHigh, 2)})` : ''}, ${g.rTrades} trades`}
      </title>
      <rect
        className={g.avgR >= 0 ? 'rbar-pos' : 'rbar-neg'}
        x={x0}
        y={3}
        width={w}
        height={8}
        rx={2}
      />
      {g.avgRLow !== null && g.avgRHigh !== null && (
        <g className="rbar-ci">
          <line x1={x(g.avgRLow)} x2={x(g.avgRHigh)} y1={7} y2={7} />
          <line x1={x(g.avgRLow)} x2={x(g.avgRLow)} y1={4} y2={10} />
          <line x1={x(g.avgRHigh)} x2={x(g.avgRHigh)} y1={4} y2={10} />
        </g>
      )}
      <line className="rbar-zero" x1={mid} x2={mid} y1={0} y2={14} />
    </svg>
  );
}

function DimensionTable({ d }: { d: LearningResponse['dimensions'][number] }) {
  const scale = Math.max(
    0.5,
    ...d.groups.flatMap((g) =>
      g.avgR === null
        ? []
        : [Math.abs(g.avgR), Math.abs(g.avgRLow ?? 0), Math.abs(g.avgRHigh ?? 0)],
    ),
  );
  return (
    <div className="learn-dim">
      <h3 className="chart-title">{d.label}</h3>
      <table className="table compact learn">
        <thead>
          <tr>
            <th />
            <th className="num">Trades</th>
            <th className="num">Win</th>
            <th>Average R (95% range)</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {d.groups.map((g) => (
            <tr
              key={g.key}
              className={g.smallSample ? 'small-sample' : undefined}
              title={g.smallSample ? 'small sample: too few trades to judge' : undefined}
            >
              <td className="strong">{g.key}</td>
              <td className="num">{g.trades}</td>
              <td className="num">{g.winRatePct === null ? '—' : `${num(g.winRatePct, 0)}%`}</td>
              <td className="rcell">
                <div className="rline">
                  <RBar g={g} scale={scale} />
                  <span className={`small ${tone(g.avgR)}`}>{r(g.avgR)}</span>
                </div>
                {g.avgRLow !== null && (
                  <div className="muted small">
                    {num(g.avgRLow, 2)} to {num(g.avgRHigh, 2)}
                  </div>
                )}
              </td>
              <td className={`num ${tone(g.totalR)}`}>{r(g.totalR)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Report({ data }: { data: LearningResponse }) {
  const o = data.overall;
  const x = data.execution;
  if (data.trades === 0)
    return (
      <Card>
        <Empty>
          No recorded trades for this selection yet. Trades appear here once they close (paper or
          live), or run a backtest and choose it above.
        </Empty>
      </Card>
    );
  return (
    <>
      <Card title="Overall">
        <div className="grid cols-4">
          <Stat
            label="Trades"
            value={o.trades}
            sub={`${o.wins} W · ${o.losses} L · ${o.breakeven} BE${o.smallSample ? ' · small sample' : ''}`}
          />
          <Stat
            label="Expectancy"
            value={r(o.avgR)}
            sub={
              o.avgRLow === null
                ? `average R over ${o.rTrades} trade(s)`
                : `95% range ${num(o.avgRLow, 2)} to ${num(o.avgRHigh, 2)} R`
            }
            tone={o.avgR === null ? undefined : o.avgR >= 0 ? 'ok' : 'bad'}
          />
          <Stat
            label="Win rate"
            value={o.winRatePct === null ? '—' : `${num(o.winRatePct, 1)}%`}
            sub={`profit factor ${o.profitFactor === null ? '—' : num(o.profitFactor, 2)}`}
          />
          <Stat
            label="Net P&L"
            value={money(o.netPnl ?? o.grossPnl)}
            sub={`total ${r(o.totalR)}`}
            tone={(o.netPnl ?? o.grossPnl) >= 0 ? 'ok' : 'bad'}
          />
          <Stat
            label="Max drawdown"
            value={r(data.drawdown.maxR)}
            sub={`${money(data.drawdown.maxMoney)} of closed-trade P&L`}
          />
          <Stat
            label="Longest losing streak"
            value={o.maxConsecutiveLosses}
            sub={
              data.drawdown.losingStreaks.length
                ? data.drawdown.losingStreaks.map((s) => `${s.count}× ${s.length}`).join(' · ')
                : 'no losses'
            }
          />
          <Stat
            label="Sharpe-like"
            value={o.sharpeLike === null ? '—' : num(o.sharpeLike, 2)}
            sub="mean R ÷ SD of R, per trade"
          />
          <Stat label="Average hold" value={duration(o.avgDurationSec)} sub="entry to exit" />
        </div>
        <h3 className="chart-title">Cumulative R by trade</h3>
        <RCurveChart report={data} />
      </Card>

      <Card title="Observations">
        {data.observations.length === 0 ? (
          <Empty>
            No differences to report. A group is compared with the rest only when both have at least{' '}
            {data.minSample} trades with a known R.
          </Empty>
        ) : (
          <ul className="plain-list">
            {data.observations.map((ob) => (
              <li key={`${ob.dimension}:${ob.group}`}>
                <Pill
                  status={ob.direction}
                  label={`${ob.strength === 'STRONG' ? 'Strong' : 'Moderate'} · ${ob.direction === 'BETTER' ? 'better' : 'worse'}`}
                  tone={ob.direction === 'BETTER' ? 'ok' : 'bad'}
                />{' '}
                {ob.text}
              </li>
            ))}
          </ul>
        )}
        <ul className="plain-list small muted">
          {data.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </Card>

      <Card title="Breakdown">
        <p className="muted small">
          Grey rows have fewer than {data.minSample} trades with a known R — too few to judge. The
          bar is the average R per trade; the thin line and the second figure are its 95% range.
        </p>
        <div className="learn-grid">
          {data.dimensions.map((d) => (
            <DimensionTable key={d.dimension} d={d} />
          ))}
        </div>
      </Card>

      <Card title="Execution quality">
        <KV
          rows={[
            [
              'Entry slippage',
              x.entrySlippage.trades
                ? `${num(x.entrySlippage.avgTicks, 2)} ticks on average (worse than planned on ${num(x.entrySlippage.adversePct, 1)}% of ${x.entrySlippage.trades} entries)`
                : 'not recorded',
            ],
            [
              'Stop slippage',
              x.stopSlippage.trades
                ? `${num(x.stopSlippage.avgTicks, 2)} ticks beyond the stop on average (${x.stopSlippage.trades} stop exits)`
                : 'no stop exits',
            ],
            [
              'Exited as planned',
              x.exitedAsPlannedPct === null
                ? '—'
                : `${num(x.exitedAsPlannedPct, 1)}% at their own stop or target`,
            ],
            ['Automatic protective closes', String(x.protectiveExits)],
            [
              'Best / worst while open',
              x.excursion.trades
                ? `${r(x.excursion.avgMfeR)} / ${r(x.excursion.avgMaeR)} on average (${x.excursion.trades} fully observed trades)`
                : 'not observed',
            ],
            [
              'Winners kept',
              x.excursion.winnersCapturePct === null
                ? '—'
                : `${num(x.excursion.winnersCapturePct, 1)}% of their best open profit`,
            ],
            [
              'Losers that were +1 R first',
              x.excursion.losers
                ? `${x.excursion.losersAfterPlusOneR} of ${x.excursion.losers}`
                : '—',
            ],
          ]}
        />
      </Card>
    </>
  );
}

export function Learning() {
  const runs = useBacktests();
  const cfg = useConfigSummary();
  const [source, setSource] = useState<'journal' | 'backtest'>('journal');
  const [runId, setRunId] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [timeZone, setTimeZone] = useState('UTC');
  const zones = useMemo(() => {
    const set = new Set(['UTC', local]);
    for (const i of cfg.data?.instruments ?? [])
      if (i.tradingHours) set.add(i.tradingHours.timeZone);
    return [...set];
  }, [cfg.data, local]);
  const run = runId ?? runs.data?.runs[0]?.runId ?? null;
  const report = useLearning({ source, runId: run, mode, timeZone });
  const notAvailable =
    report.error instanceof ApiError && report.error.status === 404 && source === 'journal';

  return (
    <div className="page">
      <PageHeader
        title="Learning Metrics"
        subtitle="What the recorded trades say — by strategy, instrument, session, time, setup and news context. Observations only: ASTRA never changes risk settings or strategy rules by itself."
      />
      <div className="filter-row">
        <div className="segmented" role="group" aria-label="Source">
          {(['journal', 'backtest'] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={s === source ? 'active' : undefined}
              aria-pressed={s === source}
              onClick={() => setSource(s)}
            >
              {s === 'journal' ? 'Trade journal' : 'Backtest run'}
            </button>
          ))}
        </div>
        {source === 'journal' ? (
          <label className="field inline">
            <span>Mode</span>
            <select
              id="lm-mode"
              value={mode ?? ''}
              onChange={(e) => setMode(e.target.value || null)}
            >
              <option value="">All modes</option>
              {MODES.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
        ) : (
          <label className="field inline">
            <span>Run</span>
            <select
              id="lm-run"
              value={run ?? ''}
              onChange={(e) => setRunId(e.target.value || null)}
            >
              {(runs.data?.runs ?? []).length === 0 && <option value="">no backtests yet</option>}
              {(runs.data?.runs ?? []).map((b) => (
                <option key={b.runId} value={b.runId}>
                  {b.createdAt.slice(0, 16).replace('T', ' ')} · {b.symbol} · {b.from.slice(0, 10)}→
                  {b.to.slice(0, 10)} · {b.summary.trades} trades
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field inline">
          <span>Time zone</span>
          <select id="lm-tz" value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z === local && z !== 'UTC' ? `${z} (this device)` : z}
              </option>
            ))}
          </select>
        </label>
      </div>
      {report.data && <p className="muted small learn-source">{report.data.source.label}</p>}

      {notAvailable ? (
        <Card>
          <Empty>Learning metrics are not available from this ASTRA server yet.</Empty>
        </Card>
      ) : source === 'backtest' && run === null ? (
        <Card>
          <Empty>No backtest runs yet — run one on the Backtesting page.</Empty>
        </Card>
      ) : report.error ? (
        <Card>
          <ErrorBox error={report.error} />
        </Card>
      ) : !report.data ? (
        <Card>
          <Loading />
        </Card>
      ) : (
        <div className={report.isPlaceholderData ? 'refetching' : undefined}>
          <Report data={report.data} />
        </div>
      )}
    </div>
  );
}
