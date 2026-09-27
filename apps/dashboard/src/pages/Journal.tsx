/**
 * Trade Journal (Phase 8): one record per closed trade — the approved plan next to what actually
 * happened — and descriptive statistics over the recorded trades only (n is always shown; small
 * samples say little). Costs are the instrument's configured commission.
 */
import { useState } from 'react';
import { ApiError } from '../api/client';
import { useJournal, useJournalSummary } from '../api/hooks';
import { JournalBreakdown, JournalEntries, JournalTiles } from '../components/JournalViews';
import { Card, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';

export function Journal() {
  const [strategy, setStrategy] = useState<string | null>(null);
  const summary = useJournalSummary(strategy);
  const list = useJournal(strategy);
  const notAvailable = (e: unknown) => e instanceof ApiError && e.status === 404;
  return (
    <div className="page">
      <PageHeader
        title="Trade Journal"
        subtitle="Every closed trade: the approved plan next to what actually happened. Statistics describe the recorded trades only — small samples say little."
      />
      {notAvailable(summary.error) ? (
        <Card>
          <Empty>The trade journal is not available from this ASTRA server yet.</Empty>
        </Card>
      ) : summary.error ? (
        <Card>
          <ErrorBox error={summary.error} />
        </Card>
      ) : !summary.data ? (
        <Card>
          <Loading />
        </Card>
      ) : (
        <>
          <Card
            title={strategy ? `Summary — ${strategy}` : 'Summary'}
            actions={
              strategy && (
                <button type="button" className="btn small" onClick={() => setStrategy(null)}>
                  All strategies
                </button>
              )
            }
          >
            <JournalTiles s={summary.data.overall} />
          </Card>
          {summary.data.overall.trades > 0 && (
            <Card title="Breakdown">
              <div className="breakdowns">
                <JournalBreakdown title="By strategy" groups={summary.data.byStrategy} />
                <JournalBreakdown title="By instrument" groups={summary.data.bySymbol} />
                <JournalBreakdown title="By exit" groups={summary.data.byExitReason} />
              </div>
              {!strategy && summary.data.byStrategy.length > 1 && (
                <p className="muted small">
                  Filter:{' '}
                  {summary.data.byStrategy.map((g) => (
                    <button
                      key={g.key}
                      type="button"
                      className="linklike"
                      onClick={() => setStrategy(g.key)}
                    >
                      {g.key}{' '}
                    </button>
                  ))}
                </p>
              )}
            </Card>
          )}
          <Card title="Trades">
            {list.error ? (
              <ErrorBox error={list.error} />
            ) : !list.data ? (
              <Loading />
            ) : (
              <JournalEntries entries={list.data.entries} />
            )}
          </Card>
          <p className="muted small">
            P&amp;L is net of the instrument&apos;s configured commission. R = net P&amp;L ÷ risk
            from the actual entry to the planned stop. Best / worst = most favourable / adverse
            price observed while open (&ldquo;partial&rdquo; when observation began after the
            entry).
          </p>
        </>
      )}
    </div>
  );
}
