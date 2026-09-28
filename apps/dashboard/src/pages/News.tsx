/**
 * News Intelligence (Phase 4, ADR-0019). Headlines are DATA; ASTRA classifies them into CONTEXT —
 * category, impact, affected instruments — and turns recent high-impact news into a news-risk
 * level the gate checks: HIGH blocks new trades for the instruments concerned; no fresh feed
 * blocks everything. Sentiment is the provider's, shown as context; it never creates a trade.
 */
import { useState } from 'react';
import { useNews, useNewsContext } from '../api/hooks';
import type { ClassifiedNews, NewsContextView } from '../api/types';
import { Card, Empty, ErrorBox, Loading, PageHeader, Pill } from '../components/ui';
import { ago, num } from '../lib/format';

type Impact = 'HIGH' | 'MEDIUM' | 'LOW';
const RISK_TONE = { HIGH: 'bad', ELEVATED: 'warn', NORMAL: 'ok' } as const;
const IMPACT_TONE = { HIGH: 'bad', MEDIUM: 'warn', LOW: 'unknown' } as const;
const CATEGORIES = [
  'MACRO',
  'CENTRAL_BANK',
  'INFLATION',
  'EMPLOYMENT',
  'GEOPOLITICS',
  'BANKING',
  'ENERGY',
  'COMMODITIES',
  'CRYPTO',
  'EQUITIES',
  'CORPORATE',
  'REGULATORY',
  'MARKET_STRUCTURE',
  'OTHER',
];
const words = (s: string) => s.toLowerCase().replace(/_/g, ' ');
const BASIS: Record<string, string> = {
  PROVIDER_SYMBOL: 'tagged by the provider',
  CURRENCY: 'currency match',
  CURRENCY_UNMAPPED: 'currency; instrument currencies not configured (fail-safe)',
  KEYWORD: 'keyword match',
  UNKNOWN_RELEVANCE: 'high impact, relevance unknown (fail-safe: all instruments)',
};

function ContextTable({ data }: { data: NewsContextView }) {
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>Instrument</th>
            <th>News risk</th>
            <th>Sentiment (provider)</th>
            <th>Calendar</th>
            <th>Combined context</th>
          </tr>
        </thead>
        <tbody>
          {data.instruments.map((i) => (
            <tr key={i.symbol}>
              <td className="strong">{i.symbol}</td>
              <td>
                {i.risk.status === 'OK' ? (
                  <>
                    <Pill status={i.risk.level} tone={RISK_TONE[i.risk.level]} />
                    {i.risk.clearsAt && (
                      <div className="muted small">until {i.risk.clearsAt.slice(11, 16)} UTC</div>
                    )}
                    {i.risk.reasons[0] && <div className="small">{i.risk.reasons[0]}</div>}
                  </>
                ) : (
                  <>
                    <Pill status="UNKNOWN" tone="unknown" />
                    <div className="muted small">{i.risk.reason}</div>
                  </>
                )}
              </td>
              <td>
                {i.sentiment.label === 'UNKNOWN' ? (
                  <span className="muted">unknown (no provider sentiment)</span>
                ) : (
                  <>
                    <div>{words(i.sentiment.label)}</div>
                    <div className="muted small">
                      confidence {num(i.sentiment.confidence, 2)} · {words(i.sentiment.momentum)} ·{' '}
                      {i.sentiment.items} item(s)
                      {i.sentiment.simulated ? ' · SIMULATED' : ''}
                    </div>
                  </>
                )}
              </td>
              <td>
                <Pill
                  status={i.calendar}
                  tone={
                    i.calendar === 'CLEAR' ? 'ok' : i.calendar === 'BLACKOUT' ? 'bad' : 'unknown'
                  }
                />
              </td>
              <td>{i.combined}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Headline({ n }: { n: ClassifiedNews }) {
  return (
    <li className="news-item">
      <div className="news-meta">
        <Pill status={n.impact} tone={IMPACT_TONE[n.impact]} />
        <span className="tag">{words(n.category)}</span>
        <span className="muted small mono">
          {n.item.publishedAt.slice(5, 10)} {n.item.publishedAt.slice(11, 16)} UTC ·{' '}
          {ago(n.item.publishedAt)}
        </span>
      </div>
      <div className="news-headline">
        {n.item.url ? (
          <a href={n.item.url} target="_blank" rel="noreferrer noopener">
            {n.item.headline}
          </a>
        ) : (
          n.item.headline
        )}
      </div>
      <div className="muted small">
        {n.item.publisher ?? n.source} <span className="tag">{n.sourceKind}</span>
        {n.affected.length > 0 ? (
          <>
            {' '}
            · affects{' '}
            {n.affected.map((a, i) => (
              <span key={a.symbol} title={BASIS[a.basis]}>
                {i > 0 && ', '}
                <b>{a.symbol}</b>
              </span>
            ))}
          </>
        ) : (
          ' · no configured instrument affected'
        )}
        {n.sentiment && (
          <>
            {' '}
            · sentiment {words(n.sentiment.label)} ({num(n.sentiment.confidence, 2)})
          </>
        )}
        {n.basis.length > 0 && <> · why: {n.basis.join(', ')}</>}
      </div>
    </li>
  );
}

export function NewsPage() {
  const ctx = useNewsContext();
  const [symbol, setSymbol] = useState<string | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const feed = useNews({ symbol, impact, category });
  const f = feed.data?.feed;

  return (
    <div className="page">
      <PageHeader
        title="News Intelligence"
        subtitle="Headlines are data; ASTRA classifies them into context. HIGH news risk blocks new trades for the instruments concerned, and without a fresh news feed no new trade is approved. Sentiment is context only — it never creates a trade."
      />

      <Card title="Feed">
        {feed.error ? (
          <ErrorBox error={feed.error} />
        ) : !f ? (
          <Loading />
        ) : (
          <>
            <p>
              <Pill
                status={f.health.status}
                tone={
                  f.health.status === 'ONLINE'
                    ? 'ok'
                    : f.health.status === 'DEGRADED'
                      ? 'warn'
                      : 'unknown'
                }
              />{' '}
              {f.health.detail}
            </p>
            {f.sources.length === 0 ? (
              <p className="muted small">
                No news has arrived. News comes from a provider (once you choose one), from n8n
                pushing to <span className="mono">POST /api/v1/news/items</span> at least every 15
                minutes (an empty batch counts), or from the SIMULATED feed in simulation mode.
                Until then news risk is unknown and the gate approves no new trades.
              </p>
            ) : (
              <ul className="plain-list small">
                {f.sources.map((s) => (
                  <li key={s.source}>
                    <span className="mono">{s.source}</span> <span className="tag">{s.kind}</span>{' '}
                    last delivery {ago(s.lastUpdateAt)}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>

      <Card title="Context by instrument">
        {ctx.error ? (
          <ErrorBox error={ctx.error} />
        ) : !ctx.data ? (
          <Loading />
        ) : (
          <ContextTable data={ctx.data} />
        )}
      </Card>

      <Card title="Headlines">
        <div className="filter-row">
          <label className="field inline">
            <span>Instrument</span>
            <select
              id="news-symbol"
              value={symbol ?? ''}
              onChange={(e) => setSymbol(e.target.value || null)}
            >
              <option value="">All</option>
              {(ctx.data?.instruments ?? []).map((i) => (
                <option key={i.symbol}>{i.symbol}</option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>Impact</span>
            <div className="segmented" role="group" aria-label="Minimum impact">
              {([null, 'MEDIUM', 'HIGH'] as const).map((v) => (
                <button
                  key={v ?? 'all'}
                  type="button"
                  className={v === impact ? 'active' : undefined}
                  aria-pressed={v === impact}
                  onClick={() => setImpact(v)}
                >
                  {v === null ? 'All' : v === 'MEDIUM' ? 'Medium +' : 'High'}
                </button>
              ))}
            </div>
          </div>
          <label className="field inline">
            <span>Category</span>
            <select
              id="news-category"
              value={category ?? ''}
              onChange={(e) => setCategory(e.target.value || null)}
            >
              <option value="">All</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {words(c)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {feed.error ? (
          <ErrorBox error={feed.error} />
        ) : !feed.data ? (
          <Loading />
        ) : feed.data.items.length === 0 ? (
          <Empty>No headlines match.</Empty>
        ) : (
          <ul className={`news-list ${feed.isPlaceholderData ? 'refetching' : ''}`}>
            {feed.data.items.map((n) => (
              <Headline key={n.key} n={n} />
            ))}
          </ul>
        )}
        <p className="muted small">
          Category and impact come from ASTRA&apos;s rules (default definitions to review) and the
          provider&apos;s own rating — whichever is higher. Hover an instrument to see why it is
          affected.
        </p>
      </Card>
    </div>
  );
}
