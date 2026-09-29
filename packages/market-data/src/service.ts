/**
 * MarketDataService — the single entry point for quotes (adapters and HTTP ingestion).
 *
 * For every quote: provider symbol → ASTRA symbol (`instrument.providerSymbols`; unknown symbols
 * are rejected) → schema validation (crossed/zero quotes rejected) → ordering (a quote older than
 * the latest one, or dated beyond the allowed clock skew, is ignored) → quality monitor (abnormal
 * jumps mark the symbol SUSPECT) → latest quote → bar aggregation → listeners.
 *
 * `latest(symbol)` never returns a default: no quote → UNAVAILABLE, suspect → INVALID.
 * Freshness is judged by the consumer at its own decision time (`fresh()` applies it now).
 */
import {
  AstraError,
  IsoDateTimeSchema,
  QuoteSchema,
  applyFreshness,
  errorMessage,
  notObserved,
  observed,
  type Clock,
  type DataSourceKind,
  type FreshnessPolicy,
  type InstrumentSpec,
  type Observed,
  type ObservedOk,
  type Quote,
  type SessionDefinition,
} from '@astra/core';
import { z } from 'zod';
import type {
  AdapterHealth,
  MarketDataAdapter,
  PriceSink,
  QuoteSink,
  RawPrice,
  RawQuote,
} from './adapter';
import { BarAggregator, DEFAULT_MAX_BARS, type AggregatorStats } from './aggregator';
import type { Bar, BarStore } from './bar';
import { feedHealth } from './health';
import { barPrice } from './price';
import { QuoteQualityMonitor, type QuoteQuality } from './quality';
import { computeMarketSnapshot, type MarketSnapshot } from './snapshot';
import { TIMEFRAMES, type Timeframe } from './timeframe';

export const DEFAULT_BAR_CLOSE_GRACE_MS = 2_000;

export interface MarketDataServiceOptions {
  readonly clock: Clock;
  /** Configured instruments by ASTRA symbol. */
  readonly instruments: ReadonlyMap<string, InstrumentSpec>;
  readonly sessions: readonly SessionDefinition[];
  /** Quote freshness: the decision policy's `quoteMaxAgeMs` and `maxFutureSkewMs`. */
  readonly freshness: FreshnessPolicy;
  /** How long a symbol stays SUSPECT after an abnormal jump (default 60 s). */
  readonly suspectCooldownMs?: number | undefined;
  /** Completed bars kept per instrument, source and timeframe (default 1000). */
  readonly maxBarsPerSeries?: number | undefined;
  /** A bar closes without a newer quote this long after its period ends (default 2 s). */
  readonly barCloseGraceMs?: number | undefined;
  readonly timeframes?: readonly Timeframe[] | undefined;
  /** Continuous observation start (default: construction time). */
  readonly observingSince?: Date | undefined;
  /** Completed bars, in order (persistence hook). */
  readonly onBars?: ((bars: readonly Bar[]) => void) | undefined;
  /** A quote from an adapter sink was rejected (sinks never throw into adapters). */
  readonly onRejected?: ((source: string, reason: string) => void) | undefined;
  /** A quote listener threw (the quote itself was still accepted). */
  readonly onListenerError?: ((err: unknown) => void) | undefined;
}

export type IngestOutcome =
  | {
      readonly status: 'ACCEPTED';
      readonly symbol: string;
      /** The quote moved more than `maxQuoteJumpTicks`: symbol SUSPECT for the cooldown. */
      readonly abnormalJump: boolean;
      /** False when the bar aggregator refused it (e.g. its bar period already closed). */
      readonly aggregated: boolean;
    }
  | { readonly status: 'IGNORED'; readonly symbol: string; readonly reason: string };

export interface MarketDataStats extends AggregatorStats {
  /** Quotes rejected (unknown symbol, invalid, source-kind conflict). */
  readonly rejected: number;
  /** Quotes ignored (older than the latest, or dated in the future). */
  readonly ignored: number;
  readonly abnormalJumps: number;
}

/** The latest bid/ask-less price of a symbol (charts only; never a tradable quote). */
export interface LastPrice {
  readonly symbol: string;
  readonly price: number;
  readonly asOf: string;
  readonly source: string;
  readonly sourceKind: DataSourceKind;
}

const RawPriceSchema = z.object({
  symbol: z.string().min(1),
  price: z.number().positive().finite(),
  asOf: IsoDateTimeSchema,
});

export class MarketDataService {
  private readonly quotes = new Map<string, ObservedOk<Quote>>();
  private readonly prices = new Map<string, LastPrice>();
  private readonly listeners = new Set<(q: Quote) => void>();
  /** adapter id → provider symbol → ASTRA symbol. */
  private readonly providerIndex = new Map<string, Map<string, string>>();
  /** Each source delivers exactly one kind of data (a SIMULATED source can never become LIVE). */
  private readonly sourceKinds = new Map<string, DataSourceKind>();
  private readonly aggregator: BarAggregator;
  private readonly quality: QuoteQualityMonitor;
  private readonly timeframes: readonly Timeframe[];
  private rejected = 0;
  private ignored = 0;
  private abnormalJumps = 0;

  constructor(private readonly opts: MarketDataServiceOptions) {
    for (const [symbol, spec] of opts.instruments) {
      for (const [adapterId, providerSymbol] of Object.entries(spec.providerSymbols ?? {})) {
        const index = this.providerIndex.get(adapterId) ?? new Map<string, string>();
        const existing = index.get(providerSymbol);
        if (existing !== undefined && existing !== symbol) {
          throw new AstraError(
            'CONFIG_INVALID',
            `provider symbol "${providerSymbol}" of adapter ${adapterId} is mapped to both ${existing} and ${symbol}`,
          );
        }
        index.set(providerSymbol, symbol);
        this.providerIndex.set(adapterId, index);
      }
    }
    this.timeframes = opts.timeframes ?? TIMEFRAMES;
    this.quality = new QuoteQualityMonitor({ cooldownMs: opts.suspectCooldownMs });
    this.aggregator = new BarAggregator({
      tradingHours: (s) => opts.instruments.get(s)?.tradingHours,
      timeframes: this.timeframes,
      maxBars: opts.maxBarsPerSeries ?? DEFAULT_MAX_BARS,
      observingSinceMs: (opts.observingSince ?? opts.clock.now()).getTime(),
    });
  }

  /** Ingests one quote. Throws VALIDATION for unknown symbols and invalid quotes. */
  ingest(raw: RawQuote, source: string, sourceKind: DataSourceKind): IngestOutcome {
    const symbol = this.resolveSymbol(raw.symbol, source);
    const parsed = QuoteSchema.safeParse({ ...raw, symbol });
    if (!parsed.success) {
      this.reject(`invalid quote for ${symbol} from ${source}: ${z.prettifyError(parsed.error)}`);
    }
    const quote = parsed.data;
    const bound = this.sourceKinds.get(source);
    if (bound !== undefined && bound !== sourceKind) {
      this.reject(`source ${source} delivers ${bound} data; refusing ${sourceKind}`);
    }
    this.sourceKinds.set(source, sourceKind);

    const nowMs = this.opts.clock.now().getTime();
    const atMs = Date.parse(quote.asOf);
    if (atMs - nowMs > this.opts.freshness.maxFutureSkewMs) {
      return this.ignore(symbol, `timestamp ${quote.asOf} is in the future (clock skew?)`);
    }
    const previous = this.quotes.get(symbol);
    if (previous && atMs < Date.parse(previous.asOf)) {
      return this.ignore(symbol, `older than the latest quote (${previous.asOf})`);
    }

    const spec = this.opts.instruments.get(symbol)!;
    const abnormalJump = this.quality.observe(quote, spec, nowMs);
    if (abnormalJump) this.abnormalJumps++;
    this.quotes.set(symbol, observed(quote, { source, sourceKind, asOf: quote.asOf }));
    const tick = this.aggregator.ingest({
      symbol,
      price: barPrice(quote),
      atMs,
      source,
      sourceKind,
    });
    if (tick.accepted) this.emitBars(tick.completed);
    for (const listener of this.listeners) {
      try {
        listener(quote);
      } catch (err) {
        this.opts.onListenerError?.(err);
      }
    }
    return { status: 'ACCEPTED', symbol, abnormalJump, aggregated: tick.accepted };
  }

  /**
   * Ingests a bid/ask-less price: bars (and so charts, structure, the scanner's bar metrics) only.
   * It never becomes the latest QUOTE — the gate and everything that needs a spread keep seeing
   * UNAVAILABLE unless a bid/ask source delivers. Same symbol mapping, source-kind binding, clock
   * skew and ordering rules as quotes.
   */
  ingestPrice(raw: RawPrice, source: string, sourceKind: DataSourceKind): IngestOutcome {
    const symbol = this.resolveSymbol(raw.symbol, source);
    const parsed = RawPriceSchema.safeParse(raw);
    if (!parsed.success) {
      this.reject(`invalid price for ${symbol} from ${source}: ${z.prettifyError(parsed.error)}`);
    }
    const bound = this.sourceKinds.get(source);
    if (bound !== undefined && bound !== sourceKind) {
      this.reject(`source ${source} delivers ${bound} data; refusing ${sourceKind}`);
    }
    this.sourceKinds.set(source, sourceKind);
    const nowMs = this.opts.clock.now().getTime();
    const atMs = Date.parse(parsed.data.asOf);
    if (atMs - nowMs > this.opts.freshness.maxFutureSkewMs) {
      return this.ignore(symbol, `timestamp ${parsed.data.asOf} is in the future (clock skew?)`);
    }
    const key = `${symbol}\u0000${source}`;
    const previous = this.prices.get(key);
    if (previous && atMs < Date.parse(previous.asOf)) {
      return this.ignore(symbol, `older than the latest price (${previous.asOf})`);
    }
    const asOf = new Date(atMs).toISOString();
    this.prices.set(key, { symbol, price: parsed.data.price, asOf, source, sourceKind });
    const tick = this.aggregator.ingest({
      symbol,
      price: parsed.data.price,
      atMs,
      source,
      sourceKind,
    });
    if (tick.accepted) this.emitBars(tick.completed);
    return { status: 'ACCEPTED', symbol, abnormalJump: false, aggregated: tick.accepted };
  }

  /** A price sink for an adapter (bid/ask-less prices), labelled with its id and kind. */
  priceSink(adapter: Pick<MarketDataAdapter, 'id' | 'kind'>): PriceSink {
    return (raw) => {
      try {
        this.ingestPrice(raw, adapter.id, adapter.kind);
      } catch (err) {
        this.opts.onRejected?.(adapter.id, errorMessage(err));
      }
    };
  }

  /** Latest bid/ask-less price per symbol and source (charts, feed monitoring). */
  lastPrices(): LastPrice[] {
    return [...this.prices.values()];
  }

  /**
   * Completed bars from a provider's own history (a backfill before its stream starts). Only
   * complete, window-aligned bars are accepted (the aggregator's seeding rules); returns how many.
   */
  seedBars(bars: readonly Bar[]): number {
    return this.aggregator.seed(bars);
  }

  /** A sink for an adapter: quotes are labelled with the adapter's id and kind. */
  sink(adapter: Pick<MarketDataAdapter, 'id' | 'kind'>): QuoteSink {
    return (raw) => {
      try {
        this.ingest(raw, adapter.id, adapter.kind);
      } catch (err) {
        this.opts.onRejected?.(adapter.id, errorMessage(err));
      }
    };
  }

  /** Latest quote: UNAVAILABLE if none, INVALID while the symbol is suspect. Not freshness-checked. */
  latest(symbol: string): Observed<Quote> {
    const q = this.quotes.get(symbol);
    if (!q) return notObserved('UNAVAILABLE', `no quote received for ${symbol}`, 'market-data');
    const quality = this.quality.quality(symbol, this.opts.clock.now().getTime());
    if (quality.suspect) {
      return notObserved('INVALID', quality.reason ?? 'abnormal price jump', q.source, {
        sourceKind: q.sourceKind,
        asOf: q.asOf,
      });
    }
    return q;
  }

  /** Latest quote with freshness applied now. */
  fresh(symbol: string): Observed<Quote> {
    return applyFreshness(this.latest(symbol), this.opts.clock.now(), this.opts.freshness);
  }

  /** Last received quote per symbol, as observed (the raw quotes endpoint). */
  all(): ObservedOk<Quote>[] {
    return [...this.quotes.values()];
  }

  quoteQuality(symbol: string): QuoteQuality {
    return this.quality.quality(symbol, this.opts.clock.now().getTime());
  }

  onQuote(listener: (q: Quote) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Completes bars whose period has ended (call periodically). */
  advance(): Bar[] {
    const done = this.aggregator.advance(
      this.opts.clock.now().getTime(),
      this.opts.barCloseGraceMs ?? DEFAULT_BAR_CLOSE_GRACE_MS,
    );
    this.emitBars(done);
    return done;
  }

  /**
   * Warm-up from stored completed bars (before feeds start). Bars ending in the future or failing
   * validation are not used. Returns how many bars were loaded.
   */
  async warmUp(store: BarStore): Promise<number> {
    const nowMs = this.opts.clock.now().getTime();
    const limit = this.opts.maxBarsPerSeries ?? DEFAULT_MAX_BARS;
    let loaded = 0;
    for (const symbol of this.opts.instruments.keys()) {
      for (const tf of this.timeframes) {
        const bars = await store.recent(symbol, tf, limit);
        loaded += this.aggregator.seed(bars.filter((b) => Date.parse(b.closeTime) <= nowMs));
      }
    }
    return loaded;
  }

  /** Bars of the instrument's current source, oldest → newest; the last may be in progress. */
  bars(symbol: string, timeframe: Timeframe, limit = DEFAULT_MAX_BARS): Bar[] {
    const source = this.primarySource(symbol);
    if (!source || limit <= 0) return [];
    return this.aggregator.bars(symbol, source, timeframe, { includeCurrent: true }).slice(-limit);
  }

  snapshot(symbol: string): MarketSnapshot {
    const now = this.opts.clock.now();
    const source = this.primarySource(symbol);
    const bars = Object.fromEntries(
      TIMEFRAMES.map((tf) => [
        tf,
        source ? this.aggregator.bars(symbol, source, tf, { includeCurrent: true }) : [],
      ]),
    ) as Record<Timeframe, Bar[]>;
    const coverage = source ? this.aggregator.coverageFromMs(symbol, source, 'M1') : null;
    return computeMarketSnapshot({
      symbol,
      now,
      instrument: this.opts.instruments.get(symbol),
      sessions: this.opts.sessions,
      quote: this.latest(symbol),
      freshness: this.opts.freshness,
      lastJumpAt: this.quality.quality(symbol, now.getTime()).lastJumpAt,
      bars,
      m1CoverageFrom:
        coverage !== null && Number.isFinite(coverage) ? new Date(coverage).toISOString() : null,
    });
  }

  /** Snapshots of every configured instrument. */
  snapshots(): MarketSnapshot[] {
    return [...this.opts.instruments.keys()].map((s) => this.snapshot(s));
  }

  /** MARKET_DATA health for the given instruments (fresh quotes for all / some / none). */
  feedHealth(symbols: readonly string[]): AdapterHealth {
    return feedHealth(symbols, (s) => this.fresh(s));
  }

  stats(): MarketDataStats {
    return {
      ...this.aggregator.stats(),
      rejected: this.rejected,
      ignored: this.ignored,
      abnormalJumps: this.abnormalJumps,
    };
  }

  /** The source whose bars represent the instrument: that of the latest quote, else of the newest bars. */
  private primarySource(symbol: string): string | null {
    const latest = this.quotes.get(symbol)?.source;
    if (latest !== undefined) return latest;
    let best: { source: string; at: number } | null = null;
    for (const source of this.aggregator.sources(symbol)) {
      const at = this.aggregator.lastActivityMs(symbol, source);
      if (at !== null && (best === null || at > best.at)) best = { source, at };
    }
    return best?.source ?? null;
  }

  private resolveSymbol(providerSymbol: string, source: string): string {
    const mapped = this.providerIndex.get(source)?.get(providerSymbol);
    if (mapped !== undefined) return mapped;
    const spec = this.opts.instruments.get(providerSymbol);
    if (!spec) this.reject(`unknown instrument ${providerSymbol} (source ${source})`);
    const expected = spec.providerSymbols?.[source];
    if (expected !== undefined && expected !== providerSymbol) {
      this.reject(`${source} must send ${providerSymbol} as its provider symbol "${expected}"`);
    }
    return providerSymbol;
  }

  private emitBars(bars: readonly Bar[]): void {
    if (bars.length > 0) this.opts.onBars?.(bars);
  }

  private ignore(symbol: string, reason: string): IngestOutcome {
    this.ignored++;
    return { status: 'IGNORED', symbol, reason };
  }

  private reject(message: string): never {
    this.rejected++;
    throw new AstraError('VALIDATION', message);
  }
}
