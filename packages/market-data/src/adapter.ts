/**
 * Market-data adapter port. An adapter connects ASTRA to one quote source and pushes what the
 * source reports into a sink; the MarketDataService maps provider symbols, validates, checks
 * ordering and quality, and builds bars. Adapters never decide anything.
 *
 * Implemented today: SimulationAdapter (SIMULATED, paper testing only) and HTTP ingestion via
 * the API (MANUAL). The slot for real providers (LIVE kind) is this interface: the owner has not
 * yet chosen a platform (MT5, cTrader, DXtrade, Match-Trader, Tradovate, Rithmic/ProjectX, …).
 * A real adapter must:
 * - stamp each quote with the PROVIDER's timestamp (never the receive time),
 * - send the provider's own symbol; `instrument.providerSymbols[adapter.id]` maps it,
 * - reconnect with backoff and report `health()` honestly (no quote ≠ healthy),
 * - declare `kind: 'LIVE'` only for real-time data from the provider (delayed data is not LIVE).
 */
import type { DataSourceKind, HealthStatus } from '@astra/core';

/** A quote as the provider sends it: `symbol` is the provider's symbol (mapped by the service). */
export interface RawQuote {
  readonly symbol: string;
  readonly bid: number;
  readonly ask: number;
  readonly last?: number | undefined;
  /** Provider timestamp (ISO-8601 with offset). */
  readonly asOf: string;
}

/** Delivers one quote to the service. Never throws: rejections are counted and reported. */
export type QuoteSink = (quote: RawQuote) => void;

export interface AdapterHealth {
  readonly status: HealthStatus;
  readonly detail: string;
}

export interface MarketDataAdapter {
  /** Adapter id: the key in `instrument.providerSymbols` and the `source` of its observations. */
  readonly id: string;
  readonly kind: DataSourceKind;
  start(sink: QuoteSink): void | Promise<void>;
  stop(): void | Promise<void>;
  health(): AdapterHealth;
}
