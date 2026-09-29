/**
 * Free chart feeds (ADR-0026): a public price stream plus its recent history, so ASTRA has real
 * charts 24/7 without a broker, funded or demo account.
 *
 * PRICES ONLY. A feed here never delivers a tradable quote: with these feeds alone the gate keeps
 * rejecting every trade (no quote → no trade) until the execution platform's own quotes arrive.
 * Bars from the feed feed the charts, the scanner's bar metrics, market structure and the
 * rule-based strategies' observation — every resulting setup still meets the gate.
 */
import type { AstraConfig } from '@astra/config';
import { errorMessage, type Clock, type DataSourceKind } from '@astra/core';
import {
  TIMEFRAMES,
  YahooStreamAdapter,
  yahooBackfill,
  type AdapterHealth,
  type BarStore,
  type FetchLike,
  type MarketDataService,
  type SocketFactory,
  type SymbolFeedStats,
  type Timers,
  type YahooStreamStats,
} from '@astra/market-data';
import type { Logger } from 'pino';

export const FEED_IDS = ['yahoo'] as const;
export type FeedId = (typeof FEED_IDS)[number];

/** Network seams (tests); the default is the runtime's WebSocket, fetch and timers. */
export interface FeedTransport {
  readonly socket?: SocketFactory;
  readonly fetch?: FetchLike;
  readonly timers?: Timers;
}

export interface FeedSymbol {
  /** ASTRA instrument. */
  readonly symbol: string;
  /** The feed's symbol for it (`providerSymbols[feed id]`). */
  readonly providerSymbol: string;
}

export interface BackfillStatus extends FeedSymbol {
  readonly status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'OFF';
  readonly at: string | null;
  /** 1-minute candles received / kept (complete and consistent) / dropped. */
  readonly received: number;
  readonly kept: number;
  readonly dropped: number;
  /** Bars (all timeframes) added to the in-memory series; stored bars are not added twice. */
  readonly loaded: number;
  /** Bars written to the database. */
  readonly stored: number;
  readonly error: string | null;
}

export interface FeedStatus {
  readonly id: string;
  readonly kind: DataSourceKind;
  /** What the feed may be used for: charts and analysis, never a tradable quote. */
  readonly use: 'CHARTS_ONLY';
  readonly health: AdapterHealth;
  readonly stream: Omit<YahooStreamStats, 'symbols'> & {
    readonly symbols: readonly (SymbolFeedStats & { readonly instrument: string })[];
  };
  readonly backfill: readonly BackfillStatus[];
}

const STORE_BATCH = 500;

export class YahooFeed {
  readonly adapter: YahooStreamAdapter;
  readonly symbols: readonly FeedSymbol[];
  private readonly backfills = new Map<string, BackfillStatus>();
  private readonly abort = new AbortController();
  private discards = 0;

  constructor(
    private readonly deps: {
      readonly config: AstraConfig;
      readonly clock: Clock;
      readonly log: Logger;
      readonly market: MarketDataService;
      readonly store: BarStore;
      readonly transport?: FeedTransport | undefined;
    },
  ) {
    const id: FeedId = 'yahoo';
    const settings = deps.config.system.marketData?.feeds?.yahoo;
    this.symbols = [...deps.config.instruments.values()]
      .filter((spec) => spec.providerSymbols?.[id] !== undefined)
      .map((spec) => ({ symbol: spec.symbol, providerSymbol: spec.providerSymbols![id]! }));
    this.adapter = new YahooStreamAdapter({
      id,
      symbols: this.symbols.map((s) => s.providerSymbol),
      clock: deps.clock,
      url: settings?.url,
      socket: deps.transport?.socket,
      timers: deps.transport?.timers,
      heartbeatMs: settings?.heartbeatMs,
      staleAfterMs: settings?.staleAfterMs,
      maxLagMs: settings?.maxLagMs,
      reconnectIfSilentMs: settings?.reconnectIfSilentMs,
      reconnectMaxMs: settings?.reconnectMaxMs,
      onDiscard: (reason) => {
        // Logged sparingly: a changed wire format would otherwise flood the log.
        if (this.discards++ % 1_000 === 0) {
          deps.log.warn({ feed: id, reason, discarded: this.discards }, 'feed message discarded');
        }
      },
    });
    const off = (settings?.backfill ?? '5d') === 'off';
    for (const s of this.symbols) {
      this.backfills.set(s.symbol, {
        ...s,
        status: off ? 'OFF' : 'PENDING',
        at: null,
        received: 0,
        kept: 0,
        dropped: 0,
        loaded: 0,
        stored: 0,
        error: null,
      });
    }
  }

  /**
   * Recent 1-minute history for every symbol (one request at a time), built into every
   * timeframe, loaded into the series the stream continues and stored. A failure is logged and
   * shown in `status()`; the stream runs either way.
   */
  async backfill(): Promise<void> {
    const range = this.deps.config.system.marketData?.feeds?.yahoo?.backfill ?? '5d';
    if (range === 'off') return;
    for (const s of this.symbols) {
      if (this.abort.signal.aborted) return;
      this.update(s.symbol, { status: 'RUNNING', error: null });
      const spec = this.deps.config.instruments.get(s.symbol)!;
      try {
        const r = await yahooBackfill({
          symbol: s.symbol,
          providerSymbol: s.providerSymbol,
          source: this.adapter.id,
          sourceKind: this.adapter.kind,
          nowMs: this.deps.clock.now().getTime(),
          timeframes: TIMEFRAMES,
          tradingHours: spec.tradingHours,
          range,
          fetch: this.deps.transport?.fetch,
          signal: this.abort.signal,
        });
        const loaded = this.deps.market.seedBars(r.bars);
        this.update(s.symbol, {
          received: r.received,
          kept: r.kept,
          dropped: r.dropped,
          loaded,
        });
        let stored = 0;
        for (let i = 0; i < r.bars.length; i += STORE_BATCH) {
          const batch = r.bars.slice(i, i + STORE_BATCH);
          await this.deps.store.upsert(batch);
          stored += batch.length;
        }
        this.update(s.symbol, { status: 'DONE', at: this.now(), stored });
        this.deps.log.info(
          { feed: this.adapter.id, symbol: s.symbol, candles: r.kept, dropped: r.dropped, loaded },
          'feed history loaded',
        );
      } catch (err) {
        this.update(s.symbol, { status: 'FAILED', at: this.now(), error: errorMessage(err) });
        this.deps.log.warn(
          { feed: this.adapter.id, symbol: s.symbol, err: errorMessage(err) },
          'feed history not loaded (the stream still runs)',
        );
      }
    }
  }

  /** Cancels a running backfill (shutdown). */
  cancel(): void {
    this.abort.abort();
  }

  status(): FeedStatus {
    const stats = this.adapter.stats();
    const instrument = new Map(this.symbols.map((s) => [s.providerSymbol, s.symbol]));
    return {
      id: this.adapter.id,
      kind: this.adapter.kind,
      use: 'CHARTS_ONLY',
      health: this.adapter.health(),
      stream: {
        ...stats,
        symbols: stats.symbols.map((s) => ({ ...s, instrument: instrument.get(s.symbol)! })),
      },
      backfill: [...this.backfills.values()],
    };
  }

  private update(symbol: string, patch: Partial<BackfillStatus>): void {
    this.backfills.set(symbol, { ...this.backfills.get(symbol)!, ...patch });
  }

  private now(): string {
    return this.deps.clock.now().toISOString();
  }
}

/** Parses ASTRA_FEEDS ("yahoo", comma-separated; empty = none). Throws on unknown ids. */
export function parseFeedList(value: string | undefined): FeedId[] {
  const ids = (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unknown = ids.filter((id) => !(FEED_IDS as readonly string[]).includes(id));
  if (unknown.length > 0) {
    throw new Error(`unknown feed(s) ${unknown.join(', ')} (available: ${FEED_IDS.join(', ')})`);
  }
  return [...new Set(ids)] as FeedId[];
}
