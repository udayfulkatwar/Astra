/**
 * Command-center overview. Answers the fifteen questions of spec §66 at a glance, using only
 * real backend state; anything not available is shown as such.
 */
import { Link } from 'react-router';
import {
  useAccounts,
  useCalendar,
  useConfigSummary,
  useDecisions,
  useKillSwitches,
  useQuotes,
  useStatus,
} from '../api/hooks';
import type { AccountView } from '../api/types';
import {
  Card,
  Empty,
  ErrorBox,
  Loading,
  NotBuilt,
  PageHeader,
  Pill,
  Stat,
  UsageBar,
} from '../components/ui';
import { ago, money, num, utcTime } from '../lib/format';

export function Overview() {
  const status = useStatus();
  const accounts = useAccounts();
  if (status.error) return <ErrorBox error={status.error} />;
  if (!status.data) return <Loading />;
  const s = status.data;

  return (
    <div className="page">
      <PageHeader
        title="Command Center"
        subtitle={
          <>
            Every figure below comes from the ASTRA core. Default state is <strong>NO TRADE</strong>
            .
          </>
        }
      />

      <div className="grid cols-4">
        <Stat
          label="Is ASTRA online?"
          value={<Pill status={s.system} />}
          sub={s.initialized ? 'core initialized' : 'core NOT initialized'}
        />
        <Stat
          label="Is trading permitted?"
          value={<Pill status={s.trading.enabled ? 'ENABLED' : 'DISABLED'} />}
          sub={s.trading.enabled ? `mode ${s.mode}` : s.trading.reasons.slice(0, 2).join(' · ')}
        />
        <Stat
          label="Mode"
          value={<Pill status={s.mode} />}
          sub={s.simulation ? 'simulated feeds active (paper only)' : 'no simulation'}
        />
        <Stat
          label="Is automation healthy?"
          value={<Pill status={s.automation.status} />}
          sub={s.automation.detail}
        />
      </div>

      {!s.trading.enabled && (
        <Card title="Why trading is disabled">
          <ul className="reasons">
            {s.trading.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid cols-2">
        <Card title="Accounts" actions={<Link to="/accounts">All accounts →</Link>}>
          {accounts.error ? (
            <ErrorBox error={accounts.error} />
          ) : !accounts.data ? (
            <Loading />
          ) : (
            accounts.data.accounts.map((a) => <AccountSummary key={a.account.id} view={a} />)
          )}
        </Card>
        <RejectionReasons />
      </div>

      <div className="grid cols-3">
        <Market />
        <Calendar />
        <Card title="News sentiment">
          <NotBuilt phase="Phase 4" what="The news intelligence engine" />
        </Card>
      </div>

      <div className="grid cols-2">
        <PendingApprovals />
        <Strategies />
      </div>
    </div>
  );
}

function AccountSummary({ view }: { view: AccountView }) {
  const st = view.state;
  const snap = view.snapshot;
  const positions = snap.status === 'OK' ? snap.value.openPositions : [];
  return (
    <div className="account-summary">
      <div className="row-between">
        <Link to={`/accounts/${view.account.id}`} className="strong">
          {view.account.name}
        </Link>
        <Pill status={view.health?.health ?? 'UNKNOWN'} />
      </div>
      {!st ? (
        <Empty>
          Account state{' '}
          {snap.status === 'OK' ? 'not computed yet' : `${snap.status}: ${snap.reason}`}
        </Empty>
      ) : (
        <>
          <div className="grid cols-4 tight">
            <Stat label="Equity" value={money(st.equity, st.currency)} />
            <Stat
              label="Today's P&L"
              value={money(st.realizedPnlToday + st.floatingPnl, st.currency)}
              tone={st.realizedPnlToday + st.floatingPnl < 0 ? 'bad' : 'ok'}
              sub={`realized ${money(st.realizedPnlToday)} · floating ${money(st.floatingPnl)}`}
            />
            <Stat
              label="Daily loss remaining"
              value={st.dailyLoss ? money(st.dailyLoss.remaining) : 'no rule'}
              sub={
                st.dailyLoss ? `worst case ${money(st.dailyLoss.worstCaseRemaining)}` : undefined
              }
            />
            <Stat
              label="Drawdown remaining"
              value={money(st.drawdown.remaining)}
              sub={`threshold ${money(st.drawdown.threshold)}`}
            />
          </div>
          <div className="usage-pair">
            <span className="muted small">Daily loss used (worst case)</span>
            <UsageBar pct={st.dailyLoss?.worstCaseUsedPct ?? null} />
            <span className="muted small">Drawdown used (worst case)</span>
            <UsageBar pct={st.drawdown.worstCaseUsedPct} />
          </div>
          <div className="muted small">
            {positions.length} open position{positions.length === 1 ? '' : 's'}
            {positions.map(
              (p) =>
                ` · ${p.direction} ${p.quantity} ${p.symbol} @ ${p.entryPrice} (${money(p.unrealizedPnl)})`,
            )}
          </div>
        </>
      )}
    </div>
  );
}

function RejectionReasons() {
  const { data, error } = useDecisions({ status: 'REJECTED' });
  const counts = new Map<string, number>();
  for (const d of data?.decisions ?? []) {
    for (const r of d.reasons) {
      const key = r.replace(/\s*\(.*?\)/g, '').slice(0, 140);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  return (
    <Card
      title="Why are trades being rejected?"
      actions={<Link to="/approvals">Trade Approval Center →</Link>}
    >
      {error ? (
        <ErrorBox error={error} />
      ) : top.length === 0 ? (
        <Empty>No rejected decisions yet.</Empty>
      ) : (
        <table className="table">
          <tbody>
            {top.map(([reason, n]) => (
              <tr key={reason}>
                <td className="num">{n}×</td>
                <td>{reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Market() {
  const { data, error } = useQuotes();
  return (
    <Card title="Current market">
      {error ? (
        <ErrorBox error={error} />
      ) : !data || data.quotes.length === 0 ? (
        <Empty>No quotes received. Market data: UNAVAILABLE.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th className="num">Bid</th>
              <th className="num">Ask</th>
              <th>Source</th>
              <th>As of</th>
            </tr>
          </thead>
          <tbody>
            {data.quotes.map((q) => (
              <tr key={q.value.symbol}>
                <td className="strong">{q.value.symbol}</td>
                <td className="num">{num(q.value.bid, 5)}</td>
                <td className="num">{num(q.value.ask, 5)}</td>
                <td>
                  <Pill
                    status={q.sourceKind === 'SIMULATED' ? 'SHADOW' : 'INFO'}
                    label={q.sourceKind}
                  />
                </td>
                <td className="muted">{ago(q.asOf)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Calendar() {
  const { data, error } = useCalendar(24);
  return (
    <Card title="Upcoming high-impact events" actions={<Link to="/calendar">Calendar →</Link>}>
      {error ? (
        <ErrorBox error={error} />
      ) : !data ? (
        <Loading />
      ) : data.status !== 'OK' || !data.value ? (
        <Empty>
          Economic calendar {data.status}. New trades are blocked while it is unavailable.
        </Empty>
      ) : data.value.events.filter((e) => e.impact === 'HIGH' || e.impact === 'UNKNOWN').length ===
        0 ? (
        <Empty>No high-impact events in the next 24h ({data.sourceKind} source).</Empty>
      ) : (
        <ul className="reasons">
          {data.value.events
            .filter((e) => e.impact === 'HIGH' || e.impact === 'UNKNOWN')
            .map((e) => (
              <li key={e.id}>
                <span className="mono">{utcTime(e.scheduledAt)}</span> {e.title}{' '}
                {e.currency && <span className="muted">({e.currency})</span>}
              </li>
            ))}
        </ul>
      )}
    </Card>
  );
}

function PendingApprovals() {
  const { data, error } = useDecisions({ status: 'APPROVED' });
  const pending = (data?.decisions ?? []).filter((d) => d.approvalState === 'PENDING');
  const recent = (data?.decisions ?? []).slice(0, 5);
  return (
    <Card title="Pending trade candidates">
      {error ? (
        <ErrorBox error={error} />
      ) : pending.length === 0 ? (
        <Empty>No approvals awaiting execution.</Empty>
      ) : (
        <ul className="reasons">
          {pending.map((d) => (
            <li key={d.decisionId}>
              <Link to={`/approvals/${d.decisionId}`}>
                {d.direction} {d.symbol}
              </Link>{' '}
              — expires {utcTime(d.approvalExpiresAt)}
            </li>
          ))}
        </ul>
      )}
      {recent.length > 0 && (
        <>
          <div className="muted small section-gap">Recent approvals</div>
          <ul className="reasons">
            {recent.map((d) => (
              <li key={d.decisionId}>
                <Link to={`/approvals/${d.decisionId}`}>
                  {d.direction} {d.symbol}
                </Link>{' '}
                <Pill status={d.approvalState} /> <span className="muted">{ago(d.decidedAt)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function Strategies() {
  const { data } = useConfigSummary();
  const ks = useKillSwitches();
  const blocked = new Set(
    (ks.data?.switches ?? [])
      .filter((s) => s.active && s.scope === 'STRATEGY')
      .map((s) => s.target),
  );
  return (
    <Card title="Strategy status" actions={<Link to="/strategies">Strategies →</Link>}>
      {!data ? (
        <Loading />
      ) : (
        <table className="table">
          <tbody>
            {data.strategies.map((s) => (
              <tr key={s.id}>
                <td className="strong">{s.name}</td>
                <td>
                  <Pill
                    status={
                      blocked.has(s.id) ? 'HALTED' : s.status === 'ACTIVE' ? 'ONLINE' : 'DISABLED'
                    }
                    label={blocked.has(s.id) ? 'KILL SWITCH' : s.status}
                  />
                </td>
                <td>
                  <Pill status={s.ownership} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
