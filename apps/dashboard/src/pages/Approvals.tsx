/** Trade Approval Center (spec §44): every candidate and exactly why it was approved or rejected. */
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError } from '../api/client';
import { useDecision, useDecisions, useExecute, useStatus } from '../api/hooks';
import type { TradeDecision } from '../api/types';
import { CandidateForm } from '../components/CandidateForm';
import { ConfirmButton } from '../components/ConfirmButton';
import { Card, Empty, ErrorBox, KV, Loading, PageHeader, Pill } from '../components/ui';
import { ago, dateTime, money, num, shortHash, utcTime } from '../lib/format';

const LAYER_ORDER = [
  'SYSTEM',
  'DATA',
  'MARKET',
  'STRATEGY',
  'NEWS',
  'CALENDAR',
  'AI',
  'RISK',
  'PROP_FIRM',
  'POSITION',
  'EXECUTION',
];

export function Approvals() {
  const [status, setStatus] = useState<string>('');
  const { data, error } = useDecisions(status ? { status } : {});
  return (
    <div className="page">
      <PageHeader
        title="Trade Approval Center"
        subtitle="Every candidate passes the full gate. One failed mandatory check means NO TRADE."
        actions={
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Filter by status"
          >
            <option value="">All decisions</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
          </select>
        }
      />
      <Card title="Submit a test trade">
        <CandidateForm />
      </Card>
      <Card>
        {error ? (
          <ErrorBox error={error} />
        ) : !data ? (
          <Loading />
        ) : data.decisions.length === 0 ? (
          <Empty>
            No decisions yet. Candidates arrive from n8n or the API (POST
            /api/v1/decisions/evaluate).
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>Instrument</th>
                <th>Account</th>
                <th>Strategy</th>
                <th>Mode</th>
                <th>Final status</th>
                <th>Approval</th>
                <th>First reason</th>
              </tr>
            </thead>
            <tbody>
              {data.decisions.map((d) => (
                <tr key={d.decisionId}>
                  <td className="mono">
                    <Link to={`/approvals/${d.decisionId}`}>{utcTime(d.decidedAt)}</Link>
                  </td>
                  <td className="strong">
                    {d.direction} {d.symbol}
                  </td>
                  <td>{d.accountId}</td>
                  <td>{d.strategyId}</td>
                  <td>
                    <Pill status={d.mode} />
                  </td>
                  <td>
                    <Pill status={d.status} />
                  </td>
                  <td>
                    {d.approvalState ? (
                      <Pill status={d.approvalState} />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="truncate">
                    {d.reasons[0] ?? <span className="muted">all checks passed</span>}
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

export function DecisionDetailPage() {
  const { id = '' } = useParams();
  const { data, error } = useDecision(id);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const d = data.decision;
  const signal = data.inputs.candidate.signal;

  return (
    <div className="page">
      <PageHeader
        title={`${d.direction} ${d.symbol}`}
        subtitle={
          <>
            Decision <span className="mono">{d.decisionId}</span> · {dateTime(d.decidedAt)}
          </>
        }
        actions={<Pill status={d.status} label={`FINAL STATUS: ${d.status}`} />}
      />

      <div className="grid cols-2">
        <Card title="Explanation">
          <KV
            rows={[
              ['What', d.explanation.what],
              [
                'Why',
                <ul className="reasons" key="why">
                  {d.explanation.why.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>,
              ],
              ['When', dateTime(d.explanation.when)],
              ['Risk', d.explanation.risk],
              ['Invalidated by', d.explanation.invalidatedBy.join(' · ')],
              ['Would stop it', d.explanation.wouldStop.join(' · ')],
            ]}
          />
        </Card>
        <Card title="Candidate (SIGNAL)">
          <KV
            rows={[
              ['Account', d.accountId],
              [
                'Strategy',
                `${d.strategyId}${data.inputs.strategy ? ` v${data.inputs.strategy.version} (${data.inputs.strategy.ownership})` : ''}`,
              ],
              [
                'Setup',
                `${signal.setupState} · ${signal.entryType} · ${signal.timeframe ?? 'n/a'}`,
              ],
              [
                'Entry / Stop / Target',
                `${num(signal.entry, 5)} / ${num(signal.stop, 5)} / ${num(signal.target, 5)}`,
              ],
              [
                'Detected',
                `${dateTime(signal.detectedAt)} (${ago(signal.detectedAt, Date.parse(d.decidedAt))} before decision)`,
              ],
              ['Rationale', signal.rationale.length ? signal.rationale.join(' · ') : '—'],
              ['Mode', <Pill key="m" status={d.mode} />],
              [
                'Config',
                <span key="c" className="mono">
                  {shortHash(d.configHash)}
                </span>,
              ],
            ]}
          />
        </Card>
      </div>

      {d.status === 'APPROVED' && <ApprovalPanel decision={d} approvalState={data.approvalState} />}
      {d.sizing && <SizingCard decision={d} />}

      <Card
        title={`Gate checks (${d.checks.filter((c) => c.verdict === 'PASS').length}/${d.checks.length} passed)`}
      >
        {LAYER_ORDER.map((layer) => {
          const checks = d.checks.filter((c) => c.layer === layer);
          if (checks.length === 0) return null;
          return (
            <div key={layer} className="layer">
              <div className="layer-name">{layer.replace('_', '-')}</div>
              {checks.map((c) => (
                <details
                  key={c.checkId}
                  className={`check check-${c.verdict}`}
                  open={c.verdict !== 'PASS'}
                >
                  <summary>
                    <Pill status={c.verdict} /> <span className="mono">{c.checkId}</span> —{' '}
                    {c.reasons[0]}
                  </summary>
                  {c.reasons.length > 1 && (
                    <ul className="reasons">
                      {c.reasons.slice(1).map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  )}
                  {c.details && <SubChecks details={c.details} />}
                </details>
              ))}
            </div>
          );
        })}
      </Card>
    </div>
  );
}

function SubChecks({ details }: { details: Record<string, unknown> }) {
  const checks = details.checks as
    { rule?: string; check?: string; verdict: string; message: string }[] | undefined;
  if (!Array.isArray(checks)) return <pre className="json">{JSON.stringify(details, null, 2)}</pre>;
  return (
    <table className="table compact">
      <tbody>
        {checks.map((c, i) => (
          <tr key={i}>
            <td>
              <Pill status={c.verdict} />
            </td>
            <td className="mono">{c.rule ?? c.check}</td>
            <td>{c.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SizingCard({ decision }: { decision: TradeDecision }) {
  const s = decision.sizing!;
  return (
    <Card title="Position sizing (smallest applicable limit wins)">
      <div className="grid cols-2">
        <KV
          rows={[
            ['Actual size', <strong key="q">{num(s.quantity, 4)}</strong>],
            ['Recommended (risk budget)', num(s.recommendedQuantity, 4)],
            [
              'Maximum allowed (caps)',
              s.maxAllowedQuantity === null ? 'uncapped' : num(s.maxAllowedQuantity, 4),
            ],
            ['Stop distance', `${num(s.stopDistanceTicks, 2)} ticks`],
            ['Risk per unit', money(s.riskPerUnit)],
            ['Dollar risk (worst case)', money(s.dollarRisk)],
            ['Risk % of equity', `${num(s.riskPctOfEquity, 3)}%`],
            [
              'Binding constraint',
              <span key="b" className="mono">
                {s.bindingConstraint}
              </span>,
            ],
          ]}
        />
        <table className="table compact">
          <thead>
            <tr>
              <th>Constraint</th>
              <th>Kind</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {s.constraints.map((c) => (
              <tr
                key={c.name}
                className={
                  c.name === s.bindingConstraint || `firm-${c.name}` === s.bindingConstraint
                    ? 'highlight'
                    : ''
                }
              >
                <td className="mono">{c.name}</td>
                <td>{c.kind === 'RISK_AMOUNT' ? 'risk $' : 'quantity'}</td>
                <td className="num">
                  {c.kind === 'RISK_AMOUNT' ? money(c.value) : num(c.value, 4)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ApprovalPanel({
  decision,
  approvalState,
}: {
  decision: TradeDecision;
  approvalState: string | null;
}) {
  const exec = useExecute();
  const status = useStatus();
  // Judge expiry against ASTRA's clock (the server's, or the demo's simulated one).
  const now = status.data ? Date.parse(status.data.now) : Date.now();
  const expired = decision.approval ? Date.parse(decision.approval.expiresAt) <= now : true;
  const canExecute = approvalState === 'PENDING' && !expired;
  return (
    <Card title="Approval">
      <div className="row-between">
        <div>
          Approval <span className="mono">{decision.approval?.approvalId}</span> · state{' '}
          <Pill status={approvalState} /> · expires {utcTime(decision.approval?.expiresAt)}
          {expired && approvalState === 'PENDING' && <span className="muted"> (expired)</span>}
        </div>
        <ConfirmButton
          label="Execute (operator)"
          confirmLabel={`Confirm ${decision.orderPlan?.direction} ${decision.orderPlan?.quantity} ${decision.symbol} (${status.data?.mode ?? decision.mode})`}
          disabled={!canExecute || exec.isPending}
          onConfirm={() => exec.mutate(decision.approval!.approvalId)}
        />
      </div>
      {exec.isPending && <div className="muted">Sending to the execution gateway…</div>}
      {exec.data && (
        <div
          className={`result tone-border-${exec.data.outcome === 'CONFIRMED' || exec.data.outcome === 'SHADOW_RECORDED' ? 'ok' : 'bad'}`}
        >
          <Pill
            status={
              exec.data.outcome === 'CONFIRMED'
                ? 'CONFIRMED'
                : exec.data.outcome === 'SHADOW_RECORDED'
                  ? 'SHADOW'
                  : 'REJECTED'
            }
            label={exec.data.outcome}
          />{' '}
          {exec.data.reasons.join(' · ')}
        </div>
      )}
      {exec.error && (
        <ErrorBox
          title="Execution request failed"
          error={
            exec.error instanceof ApiError && exec.error.status === 403
              ? new Error('Only the operator role may execute approvals.')
              : exec.error
          }
        />
      )}
    </Card>
  );
}
