/**
 * Latest quotes per instrument (Phase 1: fed by ingestion or the simulation feed; Phase 2 adds
 * real market-data adapters). A symbol with no quote is UNAVAILABLE — never a guessed price.
 */
import {
  AstraError,
  notObserved,
  observed,
  type DataSourceKind,
  type Observed,
  type ObservedOk,
  type Quote,
} from '@astra/core';

export class MarketDataService {
  private readonly quotes = new Map<string, ObservedOk<Quote>>();
  private readonly listeners = new Set<(q: Quote) => void>();

  constructor(
    private readonly knownSymbol: (symbol: string) => boolean,
    private readonly onIngest: (source: string) => void,
  ) {}

  ingest(quote: Quote, source: string, sourceKind: DataSourceKind): void {
    if (!this.knownSymbol(quote.symbol))
      throw new AstraError('VALIDATION', `unknown instrument ${quote.symbol}`);
    this.quotes.set(quote.symbol, observed(quote, { source, sourceKind, asOf: quote.asOf }));
    this.onIngest(source);
    for (const l of this.listeners) l(quote);
  }

  latest(symbol: string): Observed<Quote> {
    return (
      this.quotes.get(symbol) ??
      notObserved('UNAVAILABLE', `no quote received for ${symbol}`, 'market-data')
    );
  }

  all(): ObservedOk<Quote>[] {
    return [...this.quotes.values()];
  }

  onQuote(listener: (q: Quote) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
