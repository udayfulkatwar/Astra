/**
 * Charts: interactive candles from ASTRA's own feeds (UTC), and the free chart feeds' state —
 * connection, per-symbol delay (provider time → ASTRA) and history load (ADR-0026).
 * Chart-feed prices are for charts and analysis only: they are never a tradable quote.
 */
import { useState } from 'react';
import { ApiError } from '../api/client';
import { useBars, useConfigSummary, useFeeds, usePrices } from '../api/hooks';
import type { ChartFeedStatus, Timeframe } from '../api/types';
import { CandleChart } from '../components/CandleChart';
import { Card, Empty, ErrorBox, Loading, PageHeader, Pill } from '../components/ui';
import { delay, tickDecimals } from '../lib/candles';
import { ago, num, utcTime } from '../lib/format';

const TIMEFRAMES: Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
const KEY = 'astra.charts.view';

function saved(): { symbol: string | null; tf: Timeframe } {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as {
      symbol?: unknown;
      tf?: unknown;
    } | null;
    return {
      symbol: typeof v?.symbol === 'string' ? v.symbol : null,
      tf: TIMEFRAMES.includes(v?.tf as Timeframe) ? (v!.tf as Timeframe) : 'M5',
    };
  } catch {
    return { symbol: null, tf: 'M5' };
  }
}

function sourceTone(kind: string | undefined) {
  return kind === 'SIMULATED' ? 'SHADOW' : 'INFO';
}

function ChartCard() {
  const config = useConfigSummary();
  const [view, setView] = useState(saved);
  const instruments = config.data?.instruments ?? [];
  const spec =
    instruments.find((i) => i.symbol === view.symbol) ??
    instruments.find((i) => i.symbol === 'EURUSD') ??
    instruments[0];
  const symbol = spec?.symbol ?? null;
  const bars = useBars(symbol, view.tf, 1_000, 2_000);
  const feeds = useFeeds();
  const prices = usePrices();

  const choose = (next: { symbol?: string; tf?: Timeframe }) => {
    const v = { symbol: next.symbol ?? symbol, tf: next.tf ?? view.tf };
    setView(v);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(v));
    } catch {
      /* per-viewer convenience only */
    }
  };

  const list = bars.data?.bars ?? [];
  const last = list.at(-1);
  const price = prices.data?.prices.find((p) => p.symbol === symbol && p.source === last?.source);
  const feedSymbol = feeds.data?.feeds
    .flatMap((f) => f.stream.symbols.map((s) => ({ feed: f.id, ...s })))
    .find((s) => s.instrument === symbol && s.feed === last?.source);
  const precision = tickDecimals(spec?.tickSize ?? 0.01);

  return (
    <Card
      title="Chart"
      actions={
        <div className="chart-controls">
          <select
            value={symbol ?? ''}
            onChange={(e) => choose({ symbol: e.target.value })}
            aria-label="Instrument"
          >
            {instruments.map((i) => (
              <option key={i.symbol} value={i.symbol}>
                {i.symbol}
              </option>
            ))}
          </select>
          <div className="segmented" role="group" aria-label="Timeframe">
            {TIMEFRAMES.map((t) => (
              <button
                key={t}
                type="button"
                className={t === view.tf ? 'active' : undefined}
                aria-pressed={t === view.tf}
                onClick={() => choose({ tf: t })}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      }
    >
      {config.error ? (
        <ErrorBox error={config.error} />
      ) : bars.error ? (
        <ErrorBox error={bars.error} />
      ) : !config.data || (symbol !== null && !bars.data) ? (
        <Loading />
      ) : symbol === null ? (
        <Empty>No instruments configured.</Empty>
      ) : (
        <>
          <div className="chart-meta">
            <span className="strong">
              {symbol} · {view.tf}
            </span>
            {last ? (
              <>
                <Pill
                  status={sourceTone(last.sourceKind)}
                  label={`${last.source} · ${last.sourceKind}`}
                />
                <span>
                  Last <span className="mono">{num(price?.price ?? last.close, precision)}</span>
                  {price ? (
                    <span className="muted"> · {ago(price.asOf)}</span>
                  ) : (
                    <span className="muted"> · bar closes {utcTime(last.closeTime)}</span>
                  )}
                </span>
                {feedSymbol && (
                  <span className="muted">
                    Feed delay {delay(feedSymbol.lastLagMs)} (max {delay(feedSymbol.maxLagMs)})
                  </span>
                )}
                {price && <Pill status="UNKNOWN" label="Prices only · not tradable" />}
              </>
            ) : null}
          </div>
          {list.length === 0 ? (
            <Empty>
              No {view.tf} bars for {symbol} yet. Bars come from a running feed: the free chart feed
              (ASTRA_FEEDS=yahoo, for instruments with a Yahoo symbol), the simulation, or your
              platform&apos;s quotes — nothing is drawn without real data.
            </Empty>
          ) : (
            <div className={bars.isPlaceholderData ? 'refetching' : undefined}>
              <CandleChart
                bars={list}
                precision={precision}
                viewKey={`${symbol}:${view.tf}`}
                label={`${symbol} ${view.tf} candlestick chart, ${list.length} bars, last close ${num(last!.close, precision)}`}
              />
            </div>
          )}
          <p className="muted small">
            Times in UTC. Up to 1,000 bars; gaps (no price in a period) stay gaps. The lighter
            candle is still forming. Charts by{' '}
            <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
              TradingView
            </a>{' '}
            Lightweight Charts™.
          </p>
        </>
      )}
    </Card>
  );
}

function FeedTable({ feed }: { feed: ChartFeedStatus }) {
  const history = new Map(feed.backfill.map((b) => [b.symbol, b]));
  return (
    <>
      <div className="chart-meta">
        <span className="strong">{feed.id}</span>
        <Pill status={feed.health.status} />
        <span className="muted">{feed.health.detail}</span>
      </div>
      <div className="table-scroll">
        <table className="table compact">
          <thead>
            <tr>
              <th>Instrument</th>
              <th>Feed symbol</th>
              <th className="num">Last price</th>
              <th>Provider time (UTC)</th>
              <th className="num">Delay</th>
              <th className="num">Max delay</th>
              <th className="num">Messages</th>
              <th>History</th>
            </tr>
          </thead>
          <tbody>
            {feed.stream.symbols.map((s) => {
              const h = history.get(s.instrument);
              return (
                <tr key={s.symbol}>
                  <td className="strong">{s.instrument}</td>
                  <td className="mono">{s.symbol}</td>
                  <td className="num">{s.lastPrice === null ? '—' : String(s.lastPrice)}</td>
                  <td>{s.lastProviderTime ? utcTime(s.lastProviderTime) : '—'}</td>
                  <td className="num">{delay(s.lastLagMs)}</td>
                  <td className="num">{delay(s.maxLagMs)}</td>
                  <td className="num">{s.messages}</td>
                  <td>
                    {h ? (
                      <span title={h.error ?? undefined}>
                        <Pill
                          status={
                            h.status === 'DONE'
                              ? 'ONLINE'
                              : h.status === 'FAILED'
                                ? 'ERROR'
                                : 'UNKNOWN'
                          }
                          label={h.status}
                        />{' '}
                        <span className="muted small">
                          {h.status === 'DONE'
                            ? `${h.kept} candles${h.dropped > 0 ? `, ${h.dropped} dropped` : ''}`
                            : (h.error ?? '')}
                        </span>
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        {feed.stream.connects} connection{feed.stream.connects === 1 ? '' : 's'} ·{' '}
        {feed.stream.discarded} unusable message{feed.stream.discarded === 1 ? '' : 's'} discarded
        {feed.stream.lastError ? ` · last issue: ${feed.stream.lastError}` : ''}
      </p>
    </>
  );
}

function FeedsCard() {
  const { data, error } = useFeeds();
  return (
    <Card title="Free chart feeds">
      {error instanceof ApiError && error.status === 404 ? (
        <Empty>This ASTRA server has no chart feeds yet.</Empty>
      ) : error ? (
        <ErrorBox error={error} />
      ) : !data ? (
        <Loading />
      ) : data.feeds.length === 0 ? (
        <Empty>
          No free chart feed is running. Set ASTRA_FEEDS=yahoo (needs internet access; no account or
          key) to stream real prices 24/7 for the instruments that have a Yahoo symbol.
        </Empty>
      ) : (
        data.feeds.map((f) => <FeedTable key={f.id} feed={f} />)
      )}
      <p className="muted small">
        Public, unofficial price stream: best effort, some markets delayed — the delay is measured
        per message. Prices only: never a bid/ask quote, so the gate still says NO TRADE until your
        platform&apos;s own quotes arrive.
      </p>
    </Card>
  );
}

export function Charts() {
  return (
    <div className="page">
      <PageHeader
        title="Charts"
        subtitle="Real candles from ASTRA's feeds — nothing is drawn without real data."
      />
      <ChartCard />
      <FeedsCard />
    </div>
  );
}
