/** Journal views shared by the Trade Journal and Backtesting pages (statistics and trade rows). */
import type { JournalEntry, JournalStats } from '../api/types';
import { money, num, utcTime } from '../lib/format';
import { Empty, Pill, Stat } from './ui';

export function duration(sec: number | null): string {
  if (sec === null) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3_600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3_600)}h ${Math.floor((sec % 3_600) / 60)}m`;
}

const r = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${num(v, 2)} R`;
const tone = (v: number | null | undefined) =>
  v === null || v === undefined ? '' : v < 0 ? 'tone-text-bad' : v > 0 ? 'tone-text-ok' : '';

export function JournalTiles({ s }: { s: JournalStats }) {
  return (
    <div className="grid cols-4 journal-stats">
      <Stat
        label="Trades"
        value={s.trades}
        sub={`${s.wins} W · ${s.losses} L · ${s.breakeven} BE`}
      />
      <Stat
        label="Win rate"
        value={s.winRatePct === null ? '—' : `${num(s.winRatePct, 1)}%`}
        sub="wins / (wins + losses)"
      />
      <Stat
        label="Expectancy"
        value={r(s.avgR)}
        sub={`average R over ${s.rTrades} trade${s.rTrades === 1 ? '' : 's'}`}
        tone={s.avgR === null ? undefined : s.avgR >= 0 ? 'ok' : 'bad'}
      />
      <Stat
        label="Net P&L"
        value={s.netPnl === null ? '—' : money(s.netPnl)}
        sub={`gross ${money(s.grossPnl)}`}
        tone={s.netPnl === null ? undefined : s.netPnl >= 0 ? 'ok' : 'bad'}
      />
      <Stat
        label="Profit factor"
        value={s.profitFactor === null ? '—' : num(s.profitFactor, 2)}
        sub="gross wins / gross losses"
      />
      <Stat
        label="Max losing streak"
        value={s.maxConsecutiveLosses}
        sub={`avg hold ${duration(s.avgDurationSec)}`}
      />
      <Stat
        label="Exited as planned"
        value={s.exitedAsPlannedPct === null ? '—' : `${num(s.exitedAsPlannedPct, 0)}%`}
        sub="at its own stop or target"
      />
    </div>
  );
}

export function JournalBreakdown({
  title,
  groups,
}: {
  title: string;
  groups: { key: string; stats: JournalStats }[];
}) {
  return (
    <div>
      <h3 className="chart-title">{title}</h3>
      <table className="table compact">
        <thead>
          <tr>
            <th />
            <th className="num">Trades</th>
            <th className="num">Win rate</th>
            <th className="num">Avg R</th>
            <th className="num">Net P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key}>
              <td className="strong">{g.key}</td>
              <td className="num">{g.stats.trades}</td>
              <td className="num">
                {g.stats.winRatePct === null ? '—' : `${num(g.stats.winRatePct, 0)}%`}
              </td>
              <td className={`num ${tone(g.stats.avgR)}`}>{r(g.stats.avgR)}</td>
              <td className={`num ${tone(g.stats.netPnl)}`}>
                {g.stats.netPnl === null ? '—' : money(g.stats.netPnl)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const OUTCOME_TONE = { WIN: 'ok', LOSS: 'bad', BREAKEVEN: 'unknown' } as const;

export function JournalEntries({
  entries,
  empty = 'No closed trades recorded yet.',
}: {
  entries: JournalEntry[];
  empty?: string;
}) {
  if (entries.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div className="table-scroll">
      <table className="table journal">
        <thead>
          <tr>
            <th>Closed (UTC)</th>
            <th>Trade</th>
            <th className="num">Plan</th>
            <th className="num">Entry</th>
            <th className="num">Exit</th>
            <th className="num">Net P&amp;L</th>
            <th className="num">R</th>
            <th className="num">Best / worst</th>
            <th className="num">Held</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.tradeId}>
              <td className="mono small">
                {e.exit.at.slice(5, 10)} {utcTime(e.exit.at)}
              </td>
              <td>
                <div className="strong">
                  {e.symbol} {e.direction} {num(e.quantity, 2)}
                </div>
                <div className="muted small">
                  {e.strategyId ?? 'external (not placed by ASTRA)'}
                </div>
              </td>
              <td className="num stack small">
                {e.plan ? (
                  <>
                    <div>
                      {num(e.plan.entry, 5)} · SL {num(e.plan.stop, 5)} · TP {num(e.plan.target, 5)}
                    </div>
                    <div className="muted">
                      R:R {e.plan.rewardToRisk === null ? '—' : num(e.plan.rewardToRisk, 2)}
                    </div>
                  </>
                ) : (
                  <span className="muted">no plan</span>
                )}
              </td>
              <td className="num stack">
                <div>{num(e.entry.price, 5)}</div>
                {e.entry.slippageTicks !== null && (
                  <div className="muted small">{num(e.entry.slippageTicks, 1)} ticks slip</div>
                )}
              </td>
              <td className="num stack">
                <div>{num(e.exit.price, 5)}</div>
                <div className="small">
                  <span className="tag">{e.exit.reason}</span>
                  {e.exit.slippageTicks !== null && e.exit.slippageTicks !== 0 && (
                    <span className="muted"> {num(e.exit.slippageTicks, 1)} ticks slip</span>
                  )}
                </div>
              </td>
              <td className={`num ${tone(e.result.netPnl ?? e.result.grossPnl)}`}>
                <div>{money(e.result.netPnl ?? e.result.grossPnl)}</div>
                <Pill
                  status={e.result.outcome}
                  tone={OUTCOME_TONE[e.result.outcome]}
                  label={e.result.outcome}
                />
              </td>
              <td className={`num ${tone(e.result.rMultiple)}`}>{r(e.result.rMultiple)}</td>
              <td className="num stack small">
                {e.excursion ? (
                  <>
                    <div className="tone-text-ok">{r(e.excursion.mfe.r)}</div>
                    <div className="tone-text-bad">{r(e.excursion.mae.r)}</div>
                    {e.excursion.coverage === 'PARTIAL' && <div className="muted">partial</div>}
                  </>
                ) : (
                  <span className="muted">not observed</span>
                )}
              </td>
              <td className="num small">{duration(e.durationSec)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
