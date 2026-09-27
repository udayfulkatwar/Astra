/** Calendar, market scanner, news and AI monitor. Unbuilt engines say so explicitly. */
import { useCalendar } from '../api/hooks';
import { Card, Empty, ErrorBox, Loading, NotBuilt, PageHeader, Pill } from '../components/ui';
import { dateTime } from '../lib/format';

export function CalendarPage() {
  const { data, error } = useCalendar(168);
  return (
    <div className="page">
      <PageHeader
        title="Economic Calendar"
        subtitle="Events drive the event-risk blackout. No calendar data → NO NEW TRADES."
      />
      <Card>
        {error ? (
          <ErrorBox error={error} />
        ) : !data ? (
          <Loading />
        ) : data.status !== 'OK' || !data.value ? (
          <Empty>
            Calendar {data.status}
            {'reason' in data ? `: ${data.reason}` : ''}. Providers arrive in Phase 4; until then
            n8n can push windows to POST /api/v1/calendar/window.
          </Empty>
        ) : (
          <>
            <p className="muted">
              Source{' '}
              <Pill
                status={data.sourceKind === 'SIMULATED' ? 'SHADOW' : 'INFO'}
                label={`${data.source} · ${data.sourceKind}`}
              />{' '}
              · coverage {dateTime(data.value.from)} → {dateTime(data.value.to)}
            </p>
            {data.value.events.length === 0 ? (
              <Empty>No events in the next 7 days within the covered window.</Empty>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Event</th>
                    <th>Currency</th>
                    <th>Impact</th>
                    <th>Expected</th>
                    <th>Previous</th>
                    <th>Actual</th>
                    <th>Affects</th>
                  </tr>
                </thead>
                <tbody>
                  {data.value.events.map((e) => (
                    <tr key={e.id}>
                      <td className="mono">{dateTime(e.scheduledAt)}</td>
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
                      <td>{e.expected ?? '—'}</td>
                      <td>{e.previous ?? '—'}</td>
                      <td>{e.actual ?? '—'}</td>
                      <td>
                        {e.affectedInstruments.length
                          ? e.affectedInstruments.join(', ')
                          : 'all (unknown mapping)'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

export function News() {
  return (
    <div className="page">
      <PageHeader title="News Intelligence" />
      <Card>
        <NotBuilt phase="Phase 4" what="News ingestion, classification and sentiment">
          <p className="muted">
            The gate already consumes a news-risk assessment contract; `decision.news.required`
            becomes true when this engine is live.
          </p>
        </NotBuilt>
      </Card>
    </div>
  );
}

export function AiMonitor() {
  return (
    <div className="page">
      <PageHeader title="AI Model Monitor" />
      <Card>
        <NotBuilt
          phase="Phase 6"
          what="The AI orchestrator (ChatGPT / Claude routing, structured analysis, cost tracking)"
        >
          <p className="muted">
            AI is CONTEXT only: it can veto a trade, never approve one. Strategies that require AI
            analysis are rejected while it is unavailable.
          </p>
        </NotBuilt>
      </Card>
    </div>
  );
}

export function Backtesting() {
  return (
    <div className="page">
      <PageHeader title="Backtesting" />
      <Card>
        <NotBuilt phase="Phase 8" what="The backtesting subsystem" />
      </Card>
    </div>
  );
}
