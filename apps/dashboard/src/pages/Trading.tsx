/** Strategies, prop-firm rules, paper trading and configuration views. */
import { Link } from 'react-router';
import { useConfigSummary, useOrders } from '../api/hooks';
import type { ConfigSummary } from '../api/types';
import { Card, Empty, ErrorBox, KV, Loading, PageHeader, Pill } from '../components/ui';
import { money, num, shortHash, utcTime } from '../lib/format';

type Profile = ConfigSummary['profiles'][number];

function limitText(l: { kind: string; value: number } | null | undefined): string {
  if (!l) return 'none';
  return l.kind === 'AMOUNT'
    ? money(l.value)
    : `${l.value}% of ${l.kind === 'PERCENT_OF_INITIAL' ? 'initial' : 'day start'}`;
}

export function Strategies() {
  const { data, error } = useConfigSummary();
  return (
    <div className="page">
      <PageHeader
        title="Strategy Manager"
        subtitle="Strategies are configuration (config/strategies). ASTRA never invents or silently changes your rules."
      />
      {error ? (
        <ErrorBox error={error} />
      ) : !data ? (
        <Loading />
      ) : (
        data.strategies.map((s) => (
          <Card
            key={s.id}
            title={
              <>
                {s.name} <span className="muted small">v{s.version}</span>
              </>
            }
            actions={
              <>
                <Pill status={s.status === 'ACTIVE' ? 'ONLINE' : 'DISABLED'} label={s.status} />{' '}
                <Pill status={s.ownership} />
              </>
            }
          >
            {s.ownership === 'TEMPLATE' && (
              <div className="warn-box">
                TEMPLATE — not the owner's strategy. It is refused in LIVE mode. The owner's
                entry/confirmation/stop/target rules are required for Phase 5.
              </div>
            )}
            <KV
              rows={[
                ['Description', s.description || '—'],
                ['Instruments', s.instruments.join(', ')],
                ['Direction', s.direction],
                ['Min R:R', num(s.minRewardToRisk)],
                [
                  'Max risk / trade',
                  s.maxRiskPercentPerTrade ? `${s.maxRiskPercentPerTrade}%` : 'policy default',
                ],
                ['Max trades / day', s.maxTradesPerDay ?? 'policy default'],
                ['Signal TTL', `${s.signalTtlSeconds}s`],
                ['Requires AI analysis', s.requiresAiAnalysis ? 'yes' : 'no'],
                [
                  'Event blackout',
                  s.eventBlackout
                    ? `${s.eventBlackout.impactLevels.join('/')} −${s.eventBlackout.minutesAfter}/+${s.eventBlackout.minutesBefore} min`
                    : 'global default',
                ],
              ]}
            />
          </Card>
        ))
      )}
    </div>
  );
}

function ProfileCard({ p }: { p: Profile }) {
  return (
    <Card title={p.name} actions={<Pill status={p.verification.status} />}>
      {p.verification.status !== 'USER_VERIFIED' && (
        <div className="warn-box">
          UNVERIFIED — example values only. Verify against the firm's current terms before LIVE.
        </div>
      )}
      <KV
        rows={[
          ['Firm / program', `${p.firm} · ${p.program} · ${p.phase}`],
          ['Account size', money(p.accountSize, p.currency)],
          ['Trading day reset', `${p.tradingDayReset.time} ${p.tradingDayReset.timeZone}`],
          [
            'Daily loss',
            p.dailyLoss
              ? `${limitText(p.dailyLoss.limit)} from ${p.dailyLoss.reference.replaceAll('_', ' ').toLowerCase()}, measured on ${p.dailyLoss.measure.toLowerCase()} (${p.dailyLoss.breachConsequence})`
              : 'none',
          ],
          [
            'Max drawdown',
            `${p.maxDrawdown.type.replaceAll('_', ' ').toLowerCase()} ${limitText(p.maxDrawdown.limit)}${p.maxDrawdown.trailingStopsAt.kind !== 'NEVER' ? `, trailing stops at ${p.maxDrawdown.trailingStopsAt.kind.replaceAll('_', ' ').toLowerCase()}` : ''}`,
          ],
          [
            'Max contracts / lots',
            `${p.positionLimits.maxContracts ?? '—'} / ${p.positionLimits.maxLots ?? '—'}`,
          ],
          ['Max open positions', p.positionLimits.maxOpenPositions ?? '—'],
          ['Max leverage', p.positionLimits.maxLeverage ?? '—'],
          [
            'Scaling plan',
            p.scaling
              ? p.scaling.tiers
                  .map((t) => `≥${money(t.minProfit)}: ${t.maxWeightedQuantity}`)
                  .join(' · ')
              : 'none',
          ],
          [
            'Consistency',
            p.consistency
              ? `max ${p.consistency.maxDayProfitSharePct}% of profit in one day (${p.consistency.enforcement})`
              : 'none',
          ],
          [
            'News restriction',
            p.news
              ? `${p.news.impactLevels.join('/')} −${p.news.minutesBefore}/+${p.news.minutesAfter} min`
              : 'none',
          ],
          ['Overnight / weekend', `${p.holding.overnight} / ${p.holding.weekend}`],
          [
            'Flat by',
            p.holding.flatBy ? `${p.holding.flatBy.time} ${p.holding.flatBy.timeZone}` : '—',
          ],
          ['Stop loss required', p.trading.stopLossRequired ? 'yes' : 'no'],
          ['Max risk per trade', limitText(p.trading.maxRiskPerTrade)],
          ['Hedging', p.trading.hedgingAllowed ? 'allowed' : 'prohibited'],
          ['Profit target', limitText(p.objectives.profitTarget)],
          ['Min trading days', p.objectives.minTradingDays ?? '—'],
        ]}
      />
    </Card>
  );
}

export function Rules() {
  const { data, error } = useConfigSummary();
  return (
    <div className="page">
      <PageHeader
        title="Prop-Firm Rules"
        subtitle="Configurable rule profiles (config/prop-firm-profiles). No firm is hard-coded into the engine."
      />
      {error ? (
        <ErrorBox error={error} />
      ) : !data ? (
        <Loading />
      ) : (
        <div className="grid cols-2">
          {data.profiles.map((p) => (
            <ProfileCard key={p.id} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Paper() {
  const { data, error } = useOrders();
  return (
    <div className="page">
      <PageHeader
        title="Paper Trading"
        subtitle="Simulated execution through the same gateway and safety checks as live."
      />
      <Card title="Orders">
        {error ? (
          <ErrorBox error={error} />
        ) : !data ? (
          <Loading />
        ) : data.orders.length === 0 ? (
          <Empty>No orders yet.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Account</th>
                <th>Order</th>
                <th>Mode</th>
                <th>Status</th>
                <th className="num">Filled</th>
                <th className="num">Avg price</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {data.orders.map((o) => (
                <tr key={o.clientOrderId}>
                  <td className="mono">
                    <Link to={`/approvals/${o.decisionId}`}>{utcTime(o.createdAt)}</Link>
                  </td>
                  <td>{o.accountId}</td>
                  <td className="strong">
                    {o.direction} {num(o.quantity, 4)} {o.symbol}{' '}
                    <span className="muted">
                      SL {num(o.stopLoss, 5)} TP {num(o.takeProfit, 5)}
                    </span>
                  </td>
                  <td>
                    <Pill status={o.mode} />
                  </td>
                  <td>
                    <Pill status={o.status} />
                  </td>
                  <td className="num">{num(o.filledQuantity, 4)}</td>
                  <td className="num">{num(o.averageFillPrice, 5)}</td>
                  <td className="truncate">{o.rejectReason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

export function Configuration() {
  const { data, error } = useConfigSummary();
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const d = data.decisionPolicy;
  return (
    <div className="page">
      <PageHeader
        title="Configuration"
        subtitle={
          <>
            Active configuration <span className="mono">{shortHash(data.hash)}</span> — every
            decision records this hash. Edit via version-controlled files in config/.
          </>
        }
      />
      {data.warnings.length > 0 && (
        <Card title={`Warnings (${data.warnings.length})`}>
          <ul className="reasons">
            {data.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Card>
      )}
      <div className="grid cols-2">
        <Card title="Decision gate policy">
          <KV
            rows={[
              ['Approval TTL', `${d.approvalTtlSeconds}s`],
              ['Quote max age', `${d.freshness.quoteMaxAgeMs} ms`],
              ['Account snapshot max age', `${d.freshness.accountSnapshotMaxAgeMs} ms`],
              ['Max entry deviation', `${d.maxEntryDeviationTicks} ticks`],
              ['Required components', d.requiredComponents.join(', ')],
              ['Degraded acceptable', d.allowDegradedComponents ? 'yes' : 'no'],
              [
                'Global event blackout',
                `${d.eventBlackout.impactLevels.join('/')} −${d.eventBlackout.minutesAfter}/+${d.eventBlackout.minutesBefore} min`,
              ],
              ['News required', d.news.required ? 'yes' : 'no (engine not built)'],
              ['AI min confidence', String(d.ai.minConfidence)],
            ]}
          />
        </Card>
        {data.riskPolicies.map((r) => (
          <Card key={r.id} title={r.name} actions={<Pill status={r.ownership} />}>
            <KV
              rows={[
                [
                  'Risk per trade',
                  `${r.perTrade.riskPercentOfEquity}% of equity${r.perTrade.maxRiskAmount ? `, max ${money(r.perTrade.maxRiskAmount)}` : ''}`,
                ],
                ['Min R:R', num(r.perTrade.minRewardToRisk)],
                [
                  'Buffer use per trade',
                  `daily ${r.buffers.maxDailyBufferUsePct}% · drawdown ${r.buffers.maxDrawdownBufferUsePct}%`,
                ],
                ['Survival buffer', money(r.buffers.survivalBufferAmount)],
                ['Max open risk', `${r.exposure.maxOpenRiskPercentOfEquity}% of equity`],
                [
                  'Positions',
                  `max ${r.exposure.maxOpenPositions}, ${r.exposure.maxPositionsPerInstrument}/instrument, pyramiding ${r.exposure.allowPyramiding ? 'on' : 'off'}`,
                ],
                [
                  'Activity',
                  `max ${r.activity.maxTradesPerDay} trades/day, stop after ${r.activity.maxConsecutiveLosses} losses`,
                ],
                [
                  'Health thresholds',
                  `caution ${r.health.cautionUsagePct}% · restricted ${r.health.restrictedUsagePct}% · breach risk ${r.health.breachRiskUsagePct}%`,
                ],
                ['Caution size', `×${r.health.cautionSizeMultiplier}`],
              ]}
            />
          </Card>
        ))}
      </div>
      <Card title="Instruments">
        <table className="table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Class</th>
              <th>Unit</th>
              <th className="num">Tick size</th>
              <th className="num">Tick value</th>
              <th className="num">Step / min</th>
              <th className="num">Max spread</th>
              <th>Cost assumptions</th>
              <th>Verification</th>
            </tr>
          </thead>
          <tbody>
            {data.instruments.map((i) => (
              <tr key={i.symbol}>
                <td className="strong">{i.symbol}</td>
                <td>{i.assetClass}</td>
                <td>{i.quantityUnit}</td>
                <td className="num">{i.tickSize}</td>
                <td className="num">{money(i.tickValue, i.quoteCurrency)}</td>
                <td className="num">
                  {i.quantityStep} / {i.minQuantity}
                </td>
                <td className="num">{i.maxSpreadTicks} ticks</td>
                <td>
                  {money(i.costs.commissionPerUnitRoundTurn)} RT · {i.costs.slippageAllowanceTicks}{' '}
                  ticks slippage
                </td>
                <td>
                  <Pill status={i.verification.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
