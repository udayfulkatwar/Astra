/** Prop-firm accounts (spec §8, §9, §45): each account's state is computed independently. */
import { Link, useParams } from 'react-router';
import { useAccount, useAccounts, useConfigSummary } from '../api/hooks';
import {
  Card,
  Empty,
  ErrorBox,
  KV,
  Loading,
  PageHeader,
  Pill,
  Stat,
  UsageBar,
} from '../components/ui';
import { ago, dateTime, money, num, pct, utcTime } from '../lib/format';

export function Accounts() {
  const { data, error } = useAccounts();
  return (
    <div className="page">
      <PageHeader
        title="Accounts"
        subtitle="Independent risk, rules, positions, P&L, drawdown and kill switches per account."
      />
      <Card>
        {error ? (
          <ErrorBox error={error} />
        ) : !data ? (
          <Loading />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Firm / profile</th>
                <th>Health</th>
                <th className="num">Equity</th>
                <th className="num">Daily loss left</th>
                <th className="num">Drawdown left</th>
                <th className="num">Worst-case usage</th>
                <th>Synced</th>
              </tr>
            </thead>
            <tbody>
              {data.accounts.map((a) => (
                <tr key={a.account.id}>
                  <td className="strong">
                    <Link to={`/accounts/${a.account.id}`}>{a.account.name}</Link>
                  </td>
                  <td>
                    {a.account.firm} · <span className="mono">{a.account.propFirmProfileId}</span>
                  </td>
                  <td>
                    <Pill status={a.health?.health ?? 'UNKNOWN'} />
                  </td>
                  <td className="num">{money(a.state?.equity)}</td>
                  <td className="num">
                    {a.state?.dailyLoss
                      ? money(a.state.dailyLoss.remaining)
                      : a.state
                        ? 'no rule'
                        : '—'}
                  </td>
                  <td className="num">{money(a.state?.drawdown.remaining)}</td>
                  <td className="num">{pct(a.health?.worstCaseUsagePct)}</td>
                  <td className="muted">
                    {a.error ? <span className="tone-text-bad">{a.error}</span> : ago(a.syncedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

export function AccountDetailPage() {
  const { id = '' } = useParams();
  const { data, error } = useAccount(id);
  const cfg = useConfigSummary();
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const st = data.state;
  const policy = cfg.data?.riskPolicies.find((p) => p.id === data.account.riskPolicyId);
  const caution = policy?.health.cautionUsagePct;
  const restricted = policy?.health.restrictedUsagePct;
  const positions = data.snapshot.status === 'OK' ? data.snapshot.value.openPositions : [];

  return (
    <div className="page">
      <PageHeader
        title={data.account.name}
        subtitle={
          <>
            {data.account.firm} · profile{' '}
            <span className="mono">{data.account.propFirmProfileId}</span> · policy{' '}
            <span className="mono">{data.account.riskPolicyId}</span> · broker{' '}
            <span className="mono">{data.account.broker.adapterId}</span>
          </>
        }
        actions={<Pill status={data.health?.health ?? 'UNKNOWN'} />}
      />
      {data.health && data.health.reasons.length > 0 && (
        <Card title="Health reasons">
          <ul className="reasons">
            {data.health.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Card>
      )}
      {!st ? (
        <Card>
          <Empty>
            Account state unavailable:{' '}
            {data.snapshot.status !== 'OK'
              ? `${data.snapshot.status} — ${data.snapshot.reason}`
              : (data.error ?? 'not computed yet')}
          </Empty>
        </Card>
      ) : (
        <>
          <div className="grid cols-4">
            <Stat
              label="Balance"
              value={money(st.balance)}
              sub={`initial ${money(st.initialBalance)}`}
            />
            <Stat
              label="Equity"
              value={money(st.equity)}
              sub={`floating ${money(st.floatingPnl)}`}
            />
            <Stat
              label="Realized today"
              value={money(st.realizedPnlToday)}
              tone={st.realizedPnlToday < 0 ? 'bad' : 'ok'}
              sub={`trading day ${st.tradingDayKey} (${st.dayStartSource})`}
            />
            <Stat
              label="Distance to breach"
              value={money(st.distanceToBreach)}
              sub={`worst case ${money(st.worstCaseDistanceToBreach)} · binding ${st.bindingLimit}`}
              tone={
                st.worstCaseDistanceToBreach !== null && st.worstCaseDistanceToBreach < 250
                  ? 'bad'
                  : undefined
              }
            />
          </div>
          <div className="grid cols-2">
            <Card title="Daily loss">
              {st.dailyLoss ? (
                <>
                  <UsageBar
                    pct={st.dailyLoss.worstCaseUsedPct}
                    caution={caution}
                    restricted={restricted}
                    label="worst-case usage"
                  />
                  <KV
                    rows={[
                      ['Limit', money(st.dailyLoss.limit)],
                      ['Reference (day start)', money(st.dailyLoss.reference)],
                      ['Floor', `${money(st.dailyLoss.floor)} (${st.dailyLoss.floorSource})`],
                      ['Remaining now', money(st.dailyLoss.remaining)],
                      ['Remaining if all stops hit', money(st.dailyLoss.worstCaseRemaining)],
                      ['Used now', pct(st.dailyLoss.usedPct)],
                    ]}
                  />
                </>
              ) : (
                <Empty>This profile has no daily loss rule.</Empty>
              )}
            </Card>
            <Card title={`Max drawdown (${st.drawdown.type.replaceAll('_', ' ').toLowerCase()})`}>
              <UsageBar
                pct={st.drawdown.worstCaseUsedPct}
                caution={caution}
                restricted={restricted}
                label="worst-case usage"
              />
              <KV
                rows={[
                  ['Limit', money(st.drawdown.limit)],
                  ['Peak', money(st.drawdown.peak)],
                  [
                    'Threshold',
                    `${money(st.drawdown.threshold)} (${st.drawdown.thresholdSource}${st.drawdown.thresholdLocked ? ', locked' : ''})`,
                  ],
                  ['Remaining now', money(st.drawdown.remaining)],
                  ['Remaining if all stops hit', money(st.drawdown.worstCaseRemaining)],
                  ['Used now', pct(st.drawdown.usedPct)],
                ]}
              />
            </Card>
          </div>
          <div className="grid cols-3">
            <Card title="Profit target">
              {st.profitTarget ? (
                <>
                  <UsageBar pct={st.profitTarget.progressPct} caution={101} restricted={101} />
                  <KV
                    rows={[
                      ['Target', money(st.profitTarget.target)],
                      ['Progress', money(st.profitTarget.progress)],
                      ['Remaining', money(st.profitTarget.remaining)],
                      ['Reached', st.profitTarget.reached ? 'yes' : 'no'],
                    ]}
                  />
                </>
              ) : (
                <Empty>No profit target.</Empty>
              )}
            </Card>
            <Card title="Consistency">
              {st.consistency ? (
                <KV
                  rows={[
                    ['Max day share', pct(st.consistency.maxDayProfitSharePct)],
                    ['Today share', pct(st.consistency.todaySharePct)],
                    ['Best day share', pct(st.consistency.bestDaySharePct)],
                    ['Total profit', money(st.consistency.totalProfit)],
                  ]}
                />
              ) : (
                <Empty>No consistency rule.</Empty>
              )}
            </Card>
            <Card title="Activity">
              <KV
                rows={[
                  ['Trades today', data.activity ? String(data.activity.tradesToday) : '—'],
                  [
                    'Consecutive losses',
                    data.activity ? String(data.activity.consecutiveLosses) : '—',
                  ],
                  [
                    'Trading days',
                    `${st.tradingDays.count}${st.tradingDays.required !== null ? ` / ${st.tradingDays.required} required` : ''}`,
                  ],
                  [
                    'Open risk',
                    `${money(st.openRisk.amount)}${st.openRisk.complete ? '' : ' (INCOMPLETE — a position has no stop)'}`,
                  ],
                ]}
              />
            </Card>
          </div>
        </>
      )}

      <Card title={`Open positions (${positions.length})`}>
        {positions.length === 0 ? (
          <Empty>No open positions.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Side</th>
                <th className="num">Qty</th>
                <th className="num">Entry</th>
                <th className="num">Mark</th>
                <th className="num">Stop</th>
                <th className="num">Target</th>
                <th className="num">Unrealized</th>
                <th className="num">Risk to stop</th>
                <th>Opened</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.positionId}>
                  <td className="strong">{p.symbol}</td>
                  <td>{p.direction}</td>
                  <td className="num">{num(p.quantity, 4)}</td>
                  <td className="num">{num(p.entryPrice, 5)}</td>
                  <td className="num">{num(p.currentPrice, 5)}</td>
                  <td className="num">
                    {p.stopPrice === null ? (
                      <Pill status="CRITICAL" label="NO STOP" />
                    ) : (
                      num(p.stopPrice, 5)
                    )}
                  </td>
                  <td className="num">{num(p.targetPrice, 5)}</td>
                  <td className={`num ${p.unrealizedPnl < 0 ? 'tone-text-bad' : 'tone-text-ok'}`}>
                    {money(p.unrealizedPnl)}
                  </td>
                  <td className="num">
                    {money(
                      st?.openRisk.positions.find((r) => r.positionId === p.positionId)?.riskToStop,
                    )}
                  </td>
                  <td className="muted">{ago(p.openedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="grid cols-2">
        <Card title="Recent orders">
          {data.orders.length === 0 ? (
            <Empty>No orders.</Empty>
          ) : (
            <table className="table compact">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Order</th>
                  <th>Status</th>
                  <th className="num">Fill</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => (
                  <tr key={o.clientOrderId}>
                    <td className="mono">{utcTime(o.createdAt)}</td>
                    <td>
                      {o.direction} {num(o.quantity, 4)} {o.symbol}{' '}
                      <Link to={`/approvals/${o.decisionId}`} className="muted">
                        decision
                      </Link>
                    </td>
                    <td>
                      <Pill status={o.status} />
                    </td>
                    <td className="num">
                      {o.averageFillPrice !== null
                        ? `${num(o.filledQuantity, 4)} @ ${num(o.averageFillPrice, 5)}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Closed trades">
          {data.closedTrades.length === 0 ? (
            <Empty>No closed trades.</Empty>
          ) : (
            <table className="table compact">
              <thead>
                <tr>
                  <th>Closed</th>
                  <th>Trade</th>
                  <th>Exit</th>
                  <th className="num">P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {data.closedTrades.map((t) => (
                  <tr key={t.id}>
                    <td className="mono" title={dateTime(t.closedAt)}>
                      {utcTime(t.closedAt)}
                    </td>
                    <td>
                      {t.direction} {num(t.quantity, 4)} {t.symbol} {num(t.entryPrice, 5)} →{' '}
                      {num(t.exitPrice, 5)}
                    </td>
                    <td>{t.exitReason}</td>
                    <td className={`num ${t.realizedPnl < 0 ? 'tone-text-bad' : 'tone-text-ok'}`}>
                      {money(t.realizedPnl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}
