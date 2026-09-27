/**
 * Position Monitor (Phase 8): every open position marked at a fresh exit-side price, its distance
 * to stop and target, and the account's worst-case distance to its hard limits — including the
 * trailing-drawdown path (run up to the targets, then reverse to the stops). It warns; it never
 * closes a position.
 */
import { ApiError } from '../api/client';
import { usePositionMonitor } from '../api/hooks';
import type { AccountMonitorView, MonitorAlert, PositionView } from '../api/types';
import { Card, Empty, ErrorBox, Loading, PageHeader, Pill, UsageBar } from '../components/ui';
import { ago, money, num } from '../lib/format';

const LEVEL_TONE = { CRITICAL: 'bad', WARN: 'warn', INFO: 'info' } as const;

const FLAG_TEXT: Record<PositionView['flags'][number], string> = {
  UNPROTECTED: 'NO STOP',
  NO_PRICE: 'NO PRICE',
  NO_SPEC: 'NO SPEC',
  NEAR_STOP: 'NEAR STOP',
  NEAR_TARGET: 'NEAR TARGET',
};
const FLAG_TONE: Record<PositionView['flags'][number], 'bad' | 'warn' | 'info' | 'unknown'> = {
  UNPROTECTED: 'bad',
  NO_PRICE: 'unknown',
  NO_SPEC: 'unknown',
  NEAR_STOP: 'warn',
  NEAR_TARGET: 'info',
};

/**
 * Where the mark sits on the path stop → entry → target (works for both directions). Loss zone
 * and profit zone use the diverging pair; the ends are labelled, so colour is never the only cue.
 */
function PathGauge({ p }: { p: PositionView }) {
  if (p.stopPrice === null || p.targetPrice === null) return <span className="muted">—</span>;
  const span = p.targetPrice - p.stopPrice;
  const at = (v: number) => Math.max(0, Math.min(1, (v - p.stopPrice!) / span));
  const entry = at(p.entryPrice) * 100;
  const mark = p.mark === null ? null : at(p.mark) * 100;
  return (
    <div
      className="path-gauge"
      role="img"
      aria-label={`stop ${p.stopPrice}, entry ${p.entryPrice}, target ${p.targetPrice}, mark ${p.mark ?? 'unknown'}`}
    >
      <div className="pg-track">
        <div className="pg-loss" style={{ width: `${entry}%` }} />
        <div className="pg-profit" style={{ left: `${entry}%`, right: 0 }} />
        <div className="pg-entry" style={{ left: `${entry}%` }} />
        {mark !== null && <div className="pg-mark" style={{ left: `${mark}%` }} />}
      </div>
      <div className="pg-labels">
        <span>stop</span>
        <span>target</span>
      </div>
    </div>
  );
}

function Alerts({ alerts }: { alerts: MonitorAlert[] }) {
  if (alerts.length === 0) return <Empty>No active alerts.</Empty>;
  return (
    <ul className="alert-list">
      {alerts.map((a) => (
        <li key={a.key}>
          <Pill status={a.level} tone={LEVEL_TONE[a.level]} label={a.level} />{' '}
          <span className="tag">{a.kind.replace('_', ' ')}</span> {a.message}{' '}
          <span className="muted small">· since {ago(a.since)}</span>
        </li>
      ))}
    </ul>
  );
}

function Buffers({ v, warn, critical }: { v: AccountMonitorView; warn: number; critical: number }) {
  const rows: [string, number | null | undefined, string][] = [
    [
      'Daily loss (worst case)',
      v.dailyLoss?.worstCaseUsedPct,
      v.dailyLoss
        ? `${money(v.dailyLoss.worstCaseRemaining, v.currency ?? 'USD')} left`
        : 'no rule',
    ],
    [
      'Max drawdown (worst case)',
      v.drawdown?.worstCaseUsedPct,
      v.drawdown ? `${money(v.drawdown.worstCaseRemaining, v.currency ?? 'USD')} left` : '—',
    ],
  ];
  if (v.trailing)
    rows.push([
      'Trailing path (run-up, then stop)',
      v.trailing.pathUsedPct,
      v.trailing.pathRemaining === null
        ? v.trailing.note
        : `${money(v.trailing.pathRemaining, v.currency ?? 'USD')} left · threshold ${money(v.trailing.threshold)} → ${money(v.trailing.pathThreshold)}`,
    ]);
  return (
    <div className="buffers">
      {rows
        .filter(([, , detail]) => detail !== 'no rule')
        .map(([label, pct, detail]) => (
          <div key={label} className="buffer-row">
            <div className="small">{label}</div>
            <UsageBar pct={pct} caution={warn} restricted={critical} label={label} />
            <div className="muted small">{detail}</div>
          </div>
        ))}
    </div>
  );
}

function PositionsTable({ v }: { v: AccountMonitorView }) {
  if (v.positions.length === 0) return <Empty>No open positions.</Empty>;
  const cur = v.currency ?? 'USD';
  return (
    <div className="table-scroll">
      <table className="table positions">
        <thead>
          <tr>
            <th>Instrument</th>
            <th className="num">Entry</th>
            <th className="num">Mark</th>
            <th className="num">P&amp;L</th>
            <th className="num">R</th>
            <th className="num">Stop</th>
            <th className="num">Target</th>
            <th>Stop → target</th>
            <th>Flags</th>
          </tr>
        </thead>
        <tbody>
          {v.positions.map((p) => (
            <tr key={p.positionId}>
              <td className="strong">
                {p.symbol}
                <div className="muted small">
                  {p.direction} {num(p.quantity, 2)} · {ago(p.openedAt)}
                </div>
              </td>
              <td className="num">{num(p.entryPrice, 5)}</td>
              <td className="num">
                {p.mark === null ? <span className="muted">—</span> : num(p.mark, 5)}
              </td>
              <td
                className={`num ${p.unrealizedPnl === null ? '' : p.unrealizedPnl < 0 ? 'tone-text-bad' : 'tone-text-ok'}`}
              >
                {p.unrealizedPnl === null ? (
                  <span className="muted" title="broker figure">
                    ({money(p.brokerUnrealizedPnl, cur)})
                  </span>
                ) : (
                  money(p.unrealizedPnl, cur)
                )}
              </td>
              <td className="num">{p.rMultiple === null ? '—' : `${num(p.rMultiple, 2)} R`}</td>
              <td className="num stack">
                <div>{p.stopPrice === null ? 'NONE' : num(p.stopPrice, 5)}</div>
                {p.stopRemainingPct !== null && (
                  <div className="muted small">
                    {num(p.stopDistanceTicks, 1)} ticks · {num(p.stopRemainingPct, 0)}% left
                  </div>
                )}
              </td>
              <td className="num stack">
                <div>{p.targetPrice === null ? '—' : num(p.targetPrice, 5)}</div>
                {p.targetProgressPct !== null && (
                  <div className="muted small">{num(p.targetProgressPct, 0)}% of the way</div>
                )}
              </td>
              <td>
                <PathGauge p={p} />
              </td>
              <td>
                {p.flags.length === 0 ? (
                  <span className="muted">—</span>
                ) : (
                  p.flags.map((f) => (
                    <Pill key={f} status={f} tone={FLAG_TONE[f]} label={FLAG_TEXT[f]} />
                  ))
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Positions() {
  const { data, error } = usePositionMonitor();
  return (
    <div className="page">
      <PageHeader
        title="Position Monitor"
        subtitle="Every open position at a fresh exit-side price, and each account's worst-case distance to its limits. ASTRA warns here — it never closes a position on its own."
      />
      {error instanceof ApiError && error.status === 404 ? (
        <Card>
          <Empty>The position monitor is not available from this ASTRA server yet.</Empty>
        </Card>
      ) : error ? (
        <Card>
          <ErrorBox error={error} />
        </Card>
      ) : !data ? (
        <Card>
          <Loading />
        </Card>
      ) : (
        <>
          <Card title={`Active alerts (${data.alerts.length})`}>
            <Alerts alerts={data.alerts} />
          </Card>
          {data.accounts.length === 0 && (
            <Card>
              <Empty>No active accounts.</Empty>
            </Card>
          )}
          {data.accounts.map((v) => (
            <Card
              key={v.accountId}
              title={v.accountId}
              actions={
                v.status === 'OK' ? (
                  <span className="muted small">
                    equity {money(v.equity, v.currency ?? 'USD')} · evaluated {ago(v.asOf)}
                  </span>
                ) : (
                  <Pill status="UNKNOWN" label="CANNOT MONITOR" />
                )
              }
            >
              {v.status !== 'OK' ? (
                <Empty>{v.reason}</Empty>
              ) : (
                <>
                  <Buffers
                    v={v}
                    warn={data.policy.bufferWarnPct}
                    critical={data.policy.bufferCriticalPct}
                  />
                  <PositionsTable v={v} />
                </>
              )}
            </Card>
          ))}
          <p className="muted small">
            Alerts: stop near at ≤ {data.policy.stopProximityPct}% of the stop distance left, target
            near at ≥ {data.policy.targetProximityPct}% of the way, account buffer at ≥{' '}
            {data.policy.bufferWarnPct}% / {data.policy.bufferCriticalPct}% of a hard limit in the
            worst case; each clears {data.policy.hysteresisPct} points back on the safe side.
            Missing prices never clear an alert.
          </p>
        </>
      )}
    </div>
  );
}
