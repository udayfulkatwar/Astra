/** System health, live activity, audit log and automation monitor. */
import { useState } from 'react';
import { useAudit, useEventStream, useHealth, useStatus, useVerifyAudit } from '../api/hooks';
import { Card, Empty, ErrorBox, Loading, PageHeader, Pill } from '../components/ui';
import { ago, dateTime, shortHash, utcTime } from '../lib/format';

export function Health() {
  const { data, error } = useHealth();
  const status = useStatus();
  return (
    <div className="page">
      <PageHeader
        title="System Health"
        subtitle="ONLINE / DEGRADED / ERROR / UNKNOWN. A silent component decays to UNKNOWN — silence is never healthy."
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
                <th>Component</th>
                <th>Status</th>
                <th>Required for trading</th>
                <th>Detail</th>
                <th>Last report</th>
                <th>Last ONLINE</th>
              </tr>
            </thead>
            <tbody>
              {data.components.map((c) => (
                <tr key={c.component}>
                  <td className="strong">{c.component.replaceAll('_', ' ')}</td>
                  <td>
                    <Pill status={c.status} />
                  </td>
                  <td>
                    {status.data?.trading.reasons.some((r) => r.startsWith(c.component)) ? (
                      <Pill status="FAIL" label="BLOCKING" />
                    ) : (
                      ''
                    )}
                  </td>
                  <td>{c.detail}</td>
                  <td className="muted">{ago(c.checkedAt)}</td>
                  <td className="muted">{c.lastOnlineAt ? ago(c.lastOnlineAt) : 'never'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

export function Activity() {
  const { events, connected } = useEventStream(300);
  const [level, setLevel] = useState('');
  const shown = level ? events.filter((e) => e.level === level) : events;
  return (
    <div className="page">
      <PageHeader
        title="Live Agent Activity"
        subtitle="What ASTRA is doing, as it happens."
        actions={
          <>
            <Pill
              status={connected ? 'ONLINE' : 'UNKNOWN'}
              label={connected ? 'STREAM CONNECTED' : 'RECONNECTING'}
            />
            <select value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Level">
              <option value="">All levels</option>
              {['INFO', 'WARN', 'ERROR', 'CRITICAL'].map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </>
        }
      />
      <Card>
        {shown.length === 0 ? (
          <Empty>No events yet.</Empty>
        ) : (
          <div className="feed">
            {shown.map((e) => (
              <div key={`${e.id}-${e.seq}`} className={`feed-row level-${e.level}`}>
                <span className="mono muted">{utcTime(e.at)}</span>
                <Pill status={e.level} />
                <span className="feed-component">{e.component}</span>
                <span>{e.message}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

export function Audit() {
  const [category, setCategory] = useState('');
  const { data, error } = useAudit(category || undefined);
  const verify = useVerifyAudit();
  return (
    <div className="page">
      <PageHeader
        title="Audit Log"
        subtitle="Append-only and hash-chained: any edit or deletion of history is detectable."
        actions={
          <>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              aria-label="Category"
            >
              <option value="">All categories</option>
              {['DECISION', 'EXECUTION', 'KILL_SWITCH', 'SYSTEM'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <button className="btn" onClick={() => verify.mutate()} disabled={verify.isPending}>
              Verify chain
            </button>
          </>
        }
      />
      {verify.data && (
        <div className={`result tone-border-${verify.data.ok ? 'ok' : 'bad'}`}>
          <Pill
            status={verify.data.ok ? 'PASS' : 'FAIL'}
            label={verify.data.ok ? 'CHAIN INTACT' : 'CHAIN BROKEN'}
          />{' '}
          {verify.data.checked} entries verified
          {verify.data.brokenAtSeq !== null && ` — broken at #${verify.data.brokenAtSeq}`}
        </div>
      )}
      {verify.error && <ErrorBox error={verify.error} />}
      <Card>
        {error ? (
          <ErrorBox error={error} />
        ) : !data ? (
          <Loading />
        ) : data.entries.length === 0 ? (
          <Empty>No audit entries.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Time</th>
                <th>Actor</th>
                <th>Category</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Hash</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((a) => (
                <tr key={a.seq}>
                  <td className="num">{a.seq}</td>
                  <td className="muted" title={dateTime(a.at)}>
                    {utcTime(a.at)}
                  </td>
                  <td>
                    {a.actorType}:{a.actorId}
                  </td>
                  <td>{a.category}</td>
                  <td className="strong">{a.action}</td>
                  <td className="mono truncate">
                    {a.entityType}:{a.entityId}
                  </td>
                  <td className="mono muted">{shortHash(a.hash)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

export function Automation() {
  const { data } = useStatus();
  return (
    <div className="page">
      <PageHeader
        title="Automation Monitor"
        subtitle="n8n orchestrates; ASTRA core decides (ADR-0005)."
      />
      <Card title="n8n">
        {!data ? (
          <Loading />
        ) : (
          <>
            <p>
              <Pill status={data.automation.status} /> {data.automation.detail}
            </p>
            <p className="muted">
              n8n reports a heartbeat every minute. When it stops, automation becomes UNKNOWN and
              new trades are blocked, while in-core safety monitoring (account state, halts, kill
              switches) keeps running.
            </p>
          </>
        )}
      </Card>
      <Card title="Workflow runs">
        <Empty>
          Per-workflow run history arrives with the Phase 7 workflows. Workflow errors already
          appear in Live Activity.
        </Empty>
      </Card>
    </div>
  );
}
