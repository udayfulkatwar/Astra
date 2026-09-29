/**
 * Yahoo Finance streaming feed — free, public, no account and no API key. It is the stream the
 * open-source yfinance client uses (Apache-2.0, https://github.com/ranaroussi/yfinance,
 * `yfinance/live.py`):
 *
 * - WebSocket `wss://streamer.finance.yahoo.com/?version=2`;
 * - subscribe with the JSON text `{"subscribe": [symbols…]}`, re-sent every 15 s (heartbeat);
 * - each message is JSON whose `message` field is a base64 `PricingData` protobuf.
 *
 * What ASTRA takes from it: PRICES with the provider's timestamp → bars, charts and analysis
 * (`PriceSink`). Never a tradable quote, even when a message carries a bid and ask: a public,
 * indicative feed is not the price of the venue an order would go to, so it must not size or
 * enter a trade (ADR-0026). With only this feed the gate keeps seeing no quote → no trade.
 *
 * It is an unofficial, best-effort public stream: no service guarantee, Yahoo's terms apply, and
 * some markets are delayed. The adapter measures the delay of every message (receive time −
 * provider time) and reports it; health is ONLINE only while prices actually arrive.
 */
import { errorMessage, type Clock, type DataSourceKind } from '@astra/core';
import type { AdapterHealth, MarketDataAdapter, PriceSink, QuoteSink } from '../adapter';
import { base64Bytes, decodePricingData, type PricingData } from './yahoo-proto';

export const YAHOO_STREAM_URL = 'wss://streamer.finance.yahoo.com/?version=2';

/** The part of the WebSocket API the adapter uses (browser / Node 22 `WebSocket` both fit). */
export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface YahooStreamOptions {
  /** Adapter id (the `providerSymbols` key and the data source name). Default `yahoo`. */
  readonly id?: string;
  /** Provider symbols to subscribe to (e.g. `EURUSD=X`, `NQ=F`, `BTC-USD`). */
  readonly symbols: readonly string[];
  readonly clock: Clock;
  readonly url?: string;
  /** Opens a socket (default: the global `WebSocket`). */
  readonly socket?: SocketFactory;
  readonly timers?: Timers;
  /** Re-send the subscription this often (default 15 s, as yfinance). */
  readonly heartbeatMs?: number;
  /** Reconnect backoff: first delay, doubling up to the maximum (default 1 s … 60 s). */
  readonly reconnectInitialMs?: number;
  readonly reconnectMaxMs?: number;
  /** Connected but no price for this long → DEGRADED (market closed, or a silent stall). */
  readonly staleAfterMs?: number;
  /** A symbol whose latest price is older than this on arrival is reported as delayed. */
  readonly maxLagMs?: number;
  /**
   * Connected but not one message for this long → close and reconnect (a silently dead socket
   * looks exactly like a quiet market otherwise). Default 5 min; checked on each heartbeat.
   */
  readonly reconnectIfSilentMs?: number;
  /** A connection not open after this long is abandoned and retried (default 30 s). */
  readonly connectTimeoutMs?: number;
  /** Called for every message that could not be used (malformed, unknown symbol, no price). */
  readonly onDiscard?: (reason: string) => void;
}

export interface SymbolFeedStats {
  readonly symbol: string;
  readonly messages: number;
  readonly lastPrice: number | null;
  readonly lastProviderTime: string | null;
  readonly lastReceivedAt: string | null;
  /** Receive time − provider time of the latest message (ms). */
  readonly lastLagMs: number | null;
  readonly maxLagMs: number | null;
  /** Messages that carried a bid and ask (information only: never used as a quote). */
  readonly withBidAsk: number;
}

export interface YahooStreamStats {
  readonly state: 'IDLE' | 'CONNECTING' | 'OPEN' | 'WAITING_TO_RECONNECT' | 'STOPPED';
  readonly connects: number;
  readonly reconnectAttempt: number;
  readonly discarded: number;
  readonly lastError: string | null;
  readonly symbols: readonly SymbolFeedStats[];
}

type MutableSymbolStats = { -readonly [K in keyof SymbolFeedStats]: SymbolFeedStats[K] };

export class YahooStreamAdapter implements MarketDataAdapter {
  readonly id: string;
  /** The provider's own real-time stream; delays are measured and reported per symbol. */
  readonly kind: DataSourceKind = 'LIVE';

  private socket: SocketLike | null = null;
  private priceSink: PriceSink | null = null;
  private state: YahooStreamStats['state'] = 'IDLE';
  private heartbeat: unknown = null;
  private reconnectTimer: unknown = null;
  private connectTimer: unknown = null;
  private attempt = 0;
  private connects = 0;
  private discarded = 0;
  private lastError: string | null = null;
  private openedAtMs: number | null = null;
  private lastMessageMs: number | null = null;
  private readonly subscribed: ReadonlySet<string>;
  private readonly perSymbol = new Map<string, MutableSymbolStats>();
  private readonly timers: Timers;

  constructor(private readonly opts: YahooStreamOptions) {
    this.id = opts.id ?? 'yahoo';
    this.subscribed = new Set(opts.symbols);
    this.timers = opts.timers ?? realTimers;
    for (const s of opts.symbols) {
      this.perSymbol.set(s, {
        symbol: s,
        messages: 0,
        lastPrice: null,
        lastProviderTime: null,
        lastReceivedAt: null,
        lastLagMs: null,
        maxLagMs: null,
        withBidAsk: 0,
      });
    }
  }

  /** Quotes are never emitted (see above); prices go to `prices`. */
  start(_quotes: QuoteSink, prices?: PriceSink): void {
    if (this.state !== 'IDLE' && this.state !== 'STOPPED') return;
    this.priceSink = prices ?? null;
    if (this.subscribed.size === 0) {
      this.lastError = 'no symbols configured for this feed';
      this.state = 'STOPPED';
      return;
    }
    this.connect();
  }

  stop(): void {
    this.state = 'STOPPED';
    this.clearTimers();
    this.closeSocket();
  }

  health(): AdapterHealth {
    const nowMs = this.opts.clock.now().getTime();
    switch (this.state) {
      case 'IDLE':
        return { status: 'UNKNOWN', detail: 'not started' };
      case 'STOPPED':
        return { status: 'UNKNOWN', detail: this.lastError ?? 'stopped' };
      case 'CONNECTING':
        return { status: 'DEGRADED', detail: 'connecting to the Yahoo stream' };
      case 'WAITING_TO_RECONNECT':
        return {
          status: this.attempt >= 5 ? 'ERROR' : 'DEGRADED',
          detail: `disconnected (${this.lastError ?? 'closed'}); reconnect attempt ${this.attempt}`,
        };
      case 'OPEN':
        break;
    }
    const stale = this.opts.staleAfterMs ?? 60_000;
    const received = [...this.perSymbol.values()].filter((s) => s.lastReceivedAt !== null);
    const lastMs = Math.max(
      this.openedAtMs ?? 0,
      ...received.map((s) => Date.parse(s.lastReceivedAt!)),
    );
    if (received.length === 0 || nowMs - lastMs > stale) {
      return {
        status: 'DEGRADED',
        detail: `connected; no prices for ${Math.round((nowMs - lastMs) / 1000)} s (market closed or stream stalled)`,
      };
    }
    const maxLag = this.opts.maxLagMs ?? 30_000;
    const delayed = received.filter((s) => s.lastLagMs !== null && s.lastLagMs > maxLag);
    if (delayed.length > 0) {
      return {
        status: 'DEGRADED',
        detail: `delayed: ${delayed.map((s) => `${s.symbol} ${Math.round(s.lastLagMs! / 1000)} s`).join(', ')}`,
      };
    }
    return {
      status: 'ONLINE',
      detail: `${received.length}/${this.subscribed.size} symbols streaming`,
    };
  }

  stats(): YahooStreamStats {
    return {
      state: this.state,
      connects: this.connects,
      reconnectAttempt: this.attempt,
      discarded: this.discarded,
      lastError: this.lastError,
      symbols: [...this.perSymbol.values()].map((s) => ({ ...s })),
    };
  }

  private connect(): void {
    this.state = 'CONNECTING';
    let socket: SocketLike;
    try {
      const factory =
        this.opts.socket ??
        ((url: string) => {
          const WS = (globalThis as { WebSocket?: new (u: string) => SocketLike }).WebSocket;
          if (!WS) throw new Error('no WebSocket implementation in this runtime');
          return new WS(url);
        });
      socket = factory(this.opts.url ?? YAHOO_STREAM_URL);
    } catch (err) {
      this.fail(errorMessage(err));
      return;
    }
    this.socket = socket;
    this.connectTimer = this.timers.setTimeout(() => {
      this.connectTimer = null;
      if (this.socket !== socket || this.state !== 'CONNECTING') return;
      this.closeSocket();
      this.fail('connection timed out');
    }, this.opts.connectTimeoutMs ?? 30_000);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      if (this.connectTimer !== null) this.timers.clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.state = 'OPEN';
      this.connects++;
      this.openedAtMs = this.opts.clock.now().getTime();
      this.lastMessageMs = this.openedAtMs;
      this.subscribe();
      this.heartbeat = this.timers.setInterval(
        () => this.onHeartbeat(),
        this.opts.heartbeatMs ?? 15_000,
      );
    };
    socket.onmessage = (ev) => {
      if (this.socket === socket) this.onMessage(ev.data);
    };
    // Node's WebSocket reports a failed handshake with `error` and no `close`: any error ends
    // this connection (its later events are detached) and schedules a reconnect.
    socket.onerror = (ev) => {
      if (this.socket !== socket) return;
      const detail = (ev as { message?: unknown } | null)?.message;
      this.closeSocket();
      this.fail(typeof detail === 'string' && detail !== '' ? detail : 'socket error');
    };
    socket.onclose = () => {
      if (this.socket === socket) this.fail(this.lastError ?? 'connection closed');
    };
  }

  private onHeartbeat(): void {
    const silentMs = this.opts.clock.now().getTime() - (this.lastMessageMs ?? 0);
    const limit = this.opts.reconnectIfSilentMs ?? 300_000;
    if (this.state === 'OPEN' && silentMs > limit) {
      this.closeSocket();
      this.fail(`no message for ${Math.round(silentMs / 1000)} s`);
      return;
    }
    this.subscribe();
  }

  private subscribe(): void {
    try {
      this.socket?.send(JSON.stringify({ subscribe: [...this.subscribed] }));
    } catch (err) {
      this.lastError = errorMessage(err);
    }
  }

  private fail(reason: string): void {
    this.lastError = reason;
    this.clearTimers();
    this.socket = null;
    if (this.state === 'STOPPED') return;
    this.state = 'WAITING_TO_RECONNECT';
    this.attempt++;
    const initial = this.opts.reconnectInitialMs ?? 1_000;
    const max = this.opts.reconnectMaxMs ?? 60_000;
    const delay = Math.min(max, initial * 2 ** (this.attempt - 1));
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.state === 'WAITING_TO_RECONNECT') this.connect();
    }, delay);
  }

  /** Detaches and closes the current socket (its late events can no longer reach the adapter). */
  private closeSocket(): void {
    const s = this.socket;
    this.socket = null;
    if (!s) return;
    s.onopen = null;
    s.onclose = null;
    s.onerror = null;
    s.onmessage = null;
    try {
      s.close();
    } catch {
      // already closed
    }
  }

  private clearTimers(): void {
    if (this.heartbeat !== null) this.timers.clearInterval(this.heartbeat);
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    if (this.connectTimer !== null) this.timers.clearTimeout(this.connectTimer);
    this.heartbeat = null;
    this.reconnectTimer = null;
    this.connectTimer = null;
  }

  private discard(reason: string): void {
    this.discarded++;
    this.opts.onDiscard?.(reason);
  }

  private onMessage(data: unknown): void {
    this.lastMessageMs = this.opts.clock.now().getTime();
    if (typeof data !== 'string') return this.discard('non-text message');
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return this.discard('message is not JSON');
    }
    const encoded = (payload as { message?: unknown } | null)?.message;
    if (typeof encoded !== 'string') return this.discard('message without a pricing payload');
    let msg: PricingData;
    try {
      msg = decodePricingData(base64Bytes(encoded));
    } catch (err) {
      return this.discard(`undecodable pricing data: ${errorMessage(err)}`);
    }
    const stats = this.perSymbol.get(msg.id);
    if (!stats) return this.discard(`not subscribed: ${msg.id}`);
    if (msg.price === null || !(msg.price > 0) || msg.time === null || !(msg.time > 0))
      return this.discard(`${msg.id}: no price or time`);

    const nowMs = this.opts.clock.now().getTime();
    const asOf = new Date(msg.time).toISOString();
    const lag = nowMs - msg.time;
    stats.messages++;
    stats.lastPrice = msg.price;
    stats.lastProviderTime = asOf;
    stats.lastReceivedAt = new Date(nowMs).toISOString();
    stats.lastLagMs = lag;
    stats.maxLagMs = stats.maxLagMs === null ? lag : Math.max(stats.maxLagMs, lag);
    this.attempt = 0;

    if (msg.bid !== null && msg.ask !== null) stats.withBidAsk++;
    this.priceSink?.({ symbol: msg.id, price: msg.price, asOf });
  }
}
