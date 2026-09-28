/**
 * AI Model Monitor (Phase 6, ADR-0020). AI is CONTEXT: it can veto a trade, never approve one,
 * and never sets size, limits or risk. Shows the routes, today's budget, every model call with
 * its cost, the analyses the gate used and post-trade reviews (whose proposals are never applied).
 */
import { useState } from 'react';
import { useAiAnalyses, useAiReview, useAiReviews, useAiStatus, useJournal } from '../api/hooks';
import type { AiCallRecord, AiStatus, AiTradeReview, StoredAiAnalysis } from '../api/types';
import { Card, Empty, ErrorBox, Loading, PageHeader, Pill, Stat, UsageBar } from '../components/ui';
import { ago, num, utcTime } from '../lib/format';
import type { Tone } from '../lib/status';

const words = (s: string) => s.toLowerCase().replace(/_/g, ' ');
const usd = (v: number) => `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}`;
const VERDICT_TONE: Record<string, Tone> = { SUPPORTS: 'ok', NEUTRAL: 'warn', CONFLICTS: 'bad' };
const RISK_TONE: Record<string, Tone> = { LOW: 'ok', MEDIUM: 'warn', HIGH: 'bad' };
const CALL_TONE: Record<AiCallRecord['status'], Tone> = {
  OK: 'ok',
  INVALID: 'bad',
  REFUSED: 'restricted',
  TRUNCATED: 'bad',
  TIMEOUT: 'unknown',
  ERROR: 'bad',
  BLOCKED: 'unknown',
};
const CLASS_TONE: Record<string, Tone> = {
  GOOD_WIN: 'ok',
  GOOD_LOSS: 'info',
  GOOD_BREAKEVEN: 'info',
  POOR_WIN: 'warn',
  POOR_LOSS: 'bad',
  POOR_BREAKEVEN: 'warn',
};

function StatusCard({ s }: { s: AiStatus }) {
  const u = s.usage;
  const missing = s.routes.filter((r) => !r.available);
  return (
    <Card title="Status">
      <p>
        <Pill status={s.health.status} /> {s.health.detail}
      </p>
      {s.killSwitchActive && (
        <p className="error-box">
          AI kill switch is active: no model calls. Strategies that require AI analysis take no
          trades.
        </p>
      )}
      {s.standIn && (
        <p className="muted small">
          <Pill status="SIMULATED" tone="shadow" /> Simulation mode uses the SIMULATED stand-in: a
          few fixed rules over the same brief a model would see. It is not an AI model and not
          analysis; SHADOW and LIVE refuse its output.
        </p>
      )}
      {!s.configured ? (
        <p className="muted small">
          AI is not configured (no <span className="mono">ai:</span> block in astra.yaml).
        </p>
      ) : (
        missing.length > 0 &&
        !s.standIn && (
          <p className="muted small">
            No provider for {missing.map((r) => words(r.task)).join(', ')}: set the API key in the
            server&apos;s environment (the variable named in astra.yaml, e.g.{' '}
            <span className="mono">ANTHROPIC_API_KEY</span>) — never in config or this dashboard.
            Until then, strategies that require AI analysis take no trades.
          </p>
        )
      )}
      <div className="grid cols-4">
        <Stat label="Calls today" value={`${u.calls} / ${u.limits.dailyCalls}`} />
        <Stat
          label="Cost today"
          value={`${usd(u.costUsd)} / ${usd(u.limits.dailyCostUsd)}`}
          sub={u.reservedUsd > 0 ? `${usd(u.reservedUsd)} reserved in flight` : 'UTC day'}
        />
        <Stat
          label="Gate: minimum confidence"
          value={num(s.gate.minConfidence, 2)}
          sub={`analysis valid ${Math.round(s.gate.maxAgeMs / 60_000)} min`}
        />
        <Stat
          label="Refusal fallback (Claude)"
          value={s.serverSideFallbacks ? 'On' : 'Off'}
          sub={
            s.standIn
              ? 'not used by the stand-in'
              : "a declined request is re-run on Anthropic's fallback model"
          }
        />
      </div>
      <UsageBar
        pct={Math.max(u.calls / u.limits.dailyCalls, u.costUsd / u.limits.dailyCostUsd) * 100}
        caution={s.budget.degradeAt * 100}
        restricted={100}
        label="Daily AI budget used (calls or cost, whichever is higher)"
      />
      <p className="muted small">
        A call is refused when its worst-case cost would pass the daily limit. Limits are DEFAULTS
        to set yourself.
      </p>
    </Card>
  );
}

function RoutesCard({ s }: { s: AiStatus }) {
  return (
    <Card title="Routes">
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Provider</th>
              <th>Model</th>
              <th>Effort</th>
              <th className="num">Max output</th>
              <th className="num">Timeout</th>
              <th>Available</th>
            </tr>
          </thead>
          <tbody>
            {s.routes.map((r) => (
              <tr key={r.task}>
                <td className="strong">{words(r.task)}</td>
                <td>
                  {r.provider}
                  {r.providerKind && <span className="tag">{r.providerKind}</span>}
                </td>
                <td className="mono">{r.model}</td>
                <td>{r.effort ?? '—'}</td>
                <td className="num">{r.maxOutputTokens.toLocaleString()}</td>
                <td className="num">{Math.round(r.timeoutMs / 1000)} s</td>
                <td>
                  <Pill
                    status={r.available && r.priced ? 'ONLINE' : 'UNAVAILABLE'}
                    label={!r.available ? 'NO PROVIDER' : !r.priced ? 'NO PRICE' : 'YES'}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function gateEffect(a: StoredAiAnalysis, min: number): { tone: Tone; label: string } {
  const v = a.analysis;
  if (v.verdict === 'CONFLICTS') return { tone: 'bad', label: 'VETO: conflicts' };
  if (v.eventRisk === 'HIGH') return { tone: 'bad', label: 'VETO: event risk' };
  if (v.confidence < min) return { tone: 'bad', label: 'VETO: low confidence' };
  return { tone: 'ok', label: 'no veto' };
}

function AnalysesCard({ min }: { min: number }) {
  const { data, error } = useAiAnalyses();
  return (
    <Card title="Signal analyses">
      {error ? (
        <ErrorBox error={error} />
      ) : !data ? (
        <Loading />
      ) : data.analyses.length === 0 ? (
        <Empty>
          No analyses yet. A signal of a strategy with{' '}
          <span className="mono">requiresAiAnalysis</span> is analysed only after every
          deterministic check passes.
        </Empty>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>Signal</th>
                <th>Verdict</th>
                <th className="num">Confidence</th>
                <th className="num">Setup</th>
                <th>Event risk</th>
                <th>Gate</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {data.analyses.map((a) => {
                const v = a.analysis;
                const g = gateEffect(a, min);
                return (
                  <tr key={v.analysisId}>
                    <td className="mono">{utcTime(v.producedAt)}</td>
                    <td className="small">
                      <span className="mono">{v.signalId.slice(0, 18)}</span>
                      <div className="muted">
                        {v.model} <span className="tag">{a.sourceKind}</span>
                      </div>
                    </td>
                    <td>
                      <Pill status={v.verdict} tone={VERDICT_TONE[v.verdict]} />
                    </td>
                    <td className="num">{num(v.confidence, 2)}</td>
                    <td className="num">{v.setupQuality}</td>
                    <td>
                      <Pill status={v.eventRisk} tone={RISK_TONE[v.eventRisk]} />
                    </td>
                    <td>
                      <Pill status={g.label} tone={g.tone} />
                    </td>
                    <td className="small">
                      <ul className="plain-list">
                        {v.reasons.slice(0, 3).map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Review({ r }: { r: AiTradeReview }) {
  return (
    <li className="news-item">
      <div className="news-meta">
        <Pill
          status={r.classification}
          tone={CLASS_TONE[r.classification]}
          label={words(r.classification)}
        />
        <span className="strong">{r.symbol}</span>
        <span className="muted small mono">
          {r.tradeId.slice(0, 18)} · {ago(r.producedAt)} · {r.model}
        </span>
        <span className="tag">{r.sourceKind}</span>
      </div>
      <div>{r.summary}</div>
      <div className="muted small">
        setup {r.setupQuality} · entry {r.entryQuality} · exit {r.exitQuality}
        {r.ruleViolations.length > 0 && <> · rules: {r.ruleViolations.join('; ')}</>}
        {r.executionIssues.length > 0 && <> · execution: {r.executionIssues.join('; ')}</>}
      </div>
      <div className="small">Lessons: {r.lessons.join(' ')}</div>
      {r.proposals.length > 0 && (
        <div className="small">
          <Pill status="PROPOSED" tone="warn" /> For your review — never applied automatically:
          <ul className="plain-list">
            {r.proposals.map((p, i) => (
              <li key={i}>
                <b>{p.parameter}</b>: {p.suggestion} <span className="muted">({p.rationale})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function ReviewsCard({ auto }: { auto: boolean }) {
  const { data, error } = useAiReviews();
  const journal = useJournal(null);
  const review = useAiReview();
  const [tradeId, setTradeId] = useState('');
  const trades = journal.data?.entries ?? [];
  const chosen = tradeId || trades[0]?.tradeId || '';
  return (
    <Card title="Post-trade reviews">
      <p className="muted small">
        Good or poor is judged on process (setup, entry, exit, rules, execution), not on profit; win
        or loss comes from the journal. {auto ? 'New trades are reviewed automatically.' : ''}
      </p>
      <div className="filter-row">
        <label className="field inline">
          <span>Trade</span>
          <select id="ai-review-trade" value={chosen} onChange={(e) => setTradeId(e.target.value)}>
            {trades.length === 0 && <option value="">No journaled trades</option>}
            {trades.slice(0, 50).map((t) => (
              <option key={t.tradeId} value={t.tradeId}>
                {t.symbol} {t.direction} {t.result.outcome} ({t.result.rMultiple ?? '?'} R) ·{' '}
                {t.exit.at.slice(5, 16).replace('T', ' ')}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn"
          disabled={!chosen || review.isPending}
          onClick={() => review.mutate(chosen)}
        >
          {review.isPending ? 'Reviewing…' : 'Review this trade'}
        </button>
      </div>
      {review.error && <ErrorBox error={review.error} />}
      {review.data && !review.data.review && (
        <p className="error-box">
          No review: {review.data.status} — {review.data.reason}
        </p>
      )}
      {error ? (
        <ErrorBox error={error} />
      ) : !data ? (
        <Loading />
      ) : data.reviews.length === 0 ? (
        <Empty>No reviews yet.</Empty>
      ) : (
        <ul className="news-list">
          {data.reviews.map((r) => (
            <Review key={r.reviewId} r={r} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function CallsCard({ calls }: { calls: readonly AiCallRecord[] }) {
  return (
    <Card title="Call log">
      {calls.length === 0 ? (
        <Empty>No model calls yet.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="table compact">
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>Task</th>
                <th>Model</th>
                <th>Status</th>
                <th className="num">Latency</th>
                <th className="num">Tokens in / out</th>
                <th className="num">Cost</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.callId}>
                  <td className="mono">{utcTime(c.startedAt)}</td>
                  <td>{words(c.task)}</td>
                  <td className="small">
                    <span className="mono">{c.servedModel ?? c.model}</span>
                    {c.fallbackUsed && <span className="tag">fallback</span>}
                  </td>
                  <td>
                    <Pill status={c.status} tone={CALL_TONE[c.status]} />
                  </td>
                  <td className="num">
                    {c.latencyMs > 0 ? `${(c.latencyMs / 1000).toFixed(1)} s` : '—'}
                  </td>
                  <td className="num">
                    {c.usage
                      ? `${(c.usage.inputTokens + c.usage.cacheReadTokens + c.usage.cacheWriteTokens).toLocaleString()} / ${c.usage.outputTokens.toLocaleString()}`
                      : '—'}
                  </td>
                  <td className="num">
                    {usd(c.costUsd)}
                    {c.costEstimated ? ' (est.)' : ''}
                  </td>
                  <td className="small">
                    {c.blockedBy ? `${words(c.blockedBy)}: ` : ''}
                    {c.error ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function AiMonitor() {
  const { data, error } = useAiStatus();
  return (
    <div className="page">
      <PageHeader
        title="AI Model Monitor"
        subtitle="AI is context: it can veto a trade, never approve one, and never sets size, limits or risk. Every model call is logged with its cost; malformed answers are rejected, never repaired."
      />
      {error ? (
        <ErrorBox error={error} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <StatusCard s={data} />
          <RoutesCard s={data} />
          <AnalysesCard min={data.gate.minConfidence} />
          <ReviewsCard auto={data.postTradeReviewAuto} />
          <CallsCard calls={data.recentCalls} />
        </>
      )}
    </div>
  );
}
