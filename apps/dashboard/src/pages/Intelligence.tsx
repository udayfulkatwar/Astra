/** Economic calendar and event risk. */
import { ApiError } from '../api/client';
import { useCalendar, useCalendarRisk } from '../api/hooks';
import type { EventImpact, InstrumentEventRisk } from '../api/types';
import { Card, Empty, ErrorBox, Loading, PageHeader, Pill } from '../components/ui';
import { ago, utcTime } from '../lib/format';

/** "12:30Z" today, "09-29 12:30Z" on another day (UTC). */
function when(iso: string | null, now: number): string {
  if (!iso) return '—';
  const sameDay = iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10);
  return `${sameDay ? '' : `${iso.slice(5, 10)} `}${iso.slice(11, 16)}Z`;
}

function until(iso: string, now: number): string {
  const min = Math.round((Date.parse(iso) - now) / 60_000);
  if (min <= 0) return 'now';
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `in ${h} h ${min % 60} min` : `in ${Math.floor(h / 24)} d ${h % 24} h`;
}

function RiskDetail({ r, now }: { r: InstrumentEventRisk; now: number }) {
  if (r.state === 'UNKNOWN') return <span className="muted">{r.reason}</span>;
  if (r.state === 'BLACKOUT') {
    return (
      <>
        <div>
          Until {when(r.clearAt, now)} ({r.clearAt ? until(r.clearAt, now) : '—'}) —{' '}
          {r.blocking
            .map((e) => `${e.impact} “${e.title}” at ${when(e.scheduledAt, now)}`)
            .join('; ')}
        </div>
      </>
    );
  }
  if (!r.next) return <span className="muted">No restricted event in the covered window.</span>;
  return (
    <div>
      Next: {r.next.event.impact} “{r.next.event.title}” at {when(r.next.event.scheduledAt, now)} —
      blackout starts {until(r.next.blackoutFrom, now)}
    </div>
  );
}

function EventRiskCard() {
  const { data, error } = useCalendarRisk();
  return (
    <Card title="Event risk now">
      {error instanceof ApiError && error.status === 404 ? (
        <Empty>Event risk is not available from this ASTRA server yet.</Empty>
      ) : error ? (
        <ErrorBox error={error} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <p className="muted small">
            Blackout: {data.rule.impactLevels.join(', ')} events (unknown impact counts as HIGH),{' '}
            {data.rule.minutesBefore} min before → {data.rule.minutesAfter} min after. Global rule —
            a strategy or firm rule can widen it. The gate makes this same assessment for every
            trade.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Instrument</th>
                <th>State</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.instruments.map((r) => (
                <tr key={r.symbol}>
                  <td className="strong">{r.symbol}</td>
                  <td>
                    <Pill
                      status={r.state}
                      tone={r.state === 'CLEAR' ? 'ok' : r.state === 'BLACKOUT' ? 'bad' : 'unknown'}
                      label={r.state === 'BLACKOUT' ? 'BLACKOUT — NO TRADE' : r.state}
                    />
                  </td>
                  <td className="small">
                    <RiskDetail r={r} now={Date.parse(data.now)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            {data.calendar.status === 'OK' ? (
              <>
                Calendar from{' '}
                <Pill
                  status={data.calendar.sourceKind === 'SIMULATED' ? 'SHADOW' : 'INFO'}
                  label={`${data.calendar.source} · ${data.calendar.sourceKind}`}
                />{' '}
                · received {ago(data.calendar.asOf)} · coverage{' '}
                {when(data.calendar.from, Date.parse(data.now))} →{' '}
                {when(data.calendar.to, Date.parse(data.now))}
              </>
            ) : (
              <>Calendar {data.calendar.reason} — every trade is refused until it is fresh.</>
            )}
            {data.poller && (
              <>
                {' '}
                · provider {data.poller.adapter}: last success {ago(data.poller.lastSuccessAt)}
                {data.poller.consecutiveFailures > 0 &&
                  `, ${data.poller.consecutiveFailures} failed polls (${data.poller.lastError ?? ''})`}
              </>
            )}
          </p>
        </>
      )}
    </Card>
  );
}

export function CalendarPage() {
  const { data, error } = useCalendar(168);
  const risk = useCalendarRisk();
  const rule = risk.data?.rule;
  const restricted = (impact: EventImpact) =>
    rule !== undefined && rule.impactLevels.includes(impact === 'UNKNOWN' ? 'HIGH' : impact);
  const blocking = new Set(
    (risk.data?.instruments ?? []).flatMap((r) =>
      r.state === 'BLACKOUT' ? r.blocking.map((e) => e.id) : [],
    ),
  );
  return (
    <div className="page">
      <PageHeader
        title="Economic Calendar"
        subtitle="Events drive the event-risk blackout. No, stale or incomplete calendar data → NO NEW TRADES."
      />
      <EventRiskCard />
      <Card title="Events (next 7 days)">
        {error ? (
          <ErrorBox error={error} />
        ) : !data ? (
          <Loading />
        ) : data.status !== 'OK' || !data.value ? (
          <Empty>
            Calendar {data.status}
            {'reason' in data ? `: ${data.reason}` : ''}. No provider is chosen yet (owner input);
            n8n can push windows to POST /api/v1/calendar/window.
          </Empty>
        ) : data.value.events.length === 0 ? (
          <Empty>No events in the next 7 days within the covered window.</Empty>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Time (UTC)</th>
                  <th>Event</th>
                  <th>Currency</th>
                  <th>Impact</th>
                  <th>Blackout</th>
                  <th>Expected</th>
                  <th>Previous</th>
                  <th>Actual</th>
                  <th>Affects</th>
                </tr>
              </thead>
              <tbody>
                {data.value.events.map((e) => (
                  <tr key={e.id} className={blocking.has(e.id) ? 'row-alert' : undefined}>
                    <td className="mono">
                      {e.scheduledAt.slice(0, 10)} {utcTime(e.scheduledAt)}
                    </td>
                    <td className="strong">{e.title}</td>
                    <td>{e.currency ?? '—'}</td>
                    <td>
                      <Pill
                        status={
                          e.impact === 'MEDIUM' ? 'WARN' : e.impact === 'LOW' ? 'INFO' : e.impact
                        }
                        label={e.impact}
                      />
                    </td>
                    <td className="small">
                      {blocking.has(e.id)
                        ? 'active now'
                        : restricted(e.impact) && rule
                          ? `−${rule.minutesBefore}/+${rule.minutesAfter} min`
                          : '—'}
                    </td>
                    <td>{e.expected ?? '—'}</td>
                    <td>{e.previous ?? '—'}</td>
                    <td>{e.actual ?? '—'}</td>
                    <td>
                      {e.affectedInstruments.length ? e.affectedInstruments.join(', ') : 'all'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
