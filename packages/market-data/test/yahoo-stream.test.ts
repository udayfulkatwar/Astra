import { ManualClock } from '@astra/core';
import { describe, expect, it } from 'vitest';
import type { RawPrice, RawQuote } from '../src/adapter';
import { YAHOO_STREAM_URL, YahooStreamAdapter } from '../src/feeds/yahoo-stream';
import { FakeSocket, FakeTimers, YFINANCE_BTC_MESSAGE, frame } from './yahoo-fixtures';

const T0 = '2026-09-28T14:00:00.000Z';

function setup(opts: { symbols?: string[]; reconnectIfSilentMs?: number } = {}) {
  const clock = new ManualClock(T0);
  const timers = new FakeTimers((ms) => clock.advance(ms));
  const sockets: FakeSocket[] = [];
  const quotes: RawQuote[] = [];
  const prices: RawPrice[] = [];
  const discarded: string[] = [];
  const adapter = new YahooStreamAdapter({
    symbols: opts.symbols ?? ['EURUSD=X', 'NQ=F'],
    clock,
    timers,
    socket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    ...(opts.reconnectIfSilentMs !== undefined
      ? { reconnectIfSilentMs: opts.reconnectIfSilentMs }
      : {}),
    onDiscard: (r) => discarded.push(r),
  });
  const start = () =>
    adapter.start(
      (q) => quotes.push(q),
      (p) => prices.push(p),
    );
  return { clock, timers, sockets, quotes, prices, discarded, adapter, start };
}

const nowMs = (clock: ManualClock) => clock.now().getTime();

describe('YahooStreamAdapter', () => {
  it('connects to the public stream, subscribes on open and re-subscribes every 15 s', () => {
    const { sockets, timers, adapter, start } = setup();
    expect(adapter.health().status).toBe('UNKNOWN');
    start();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe(YAHOO_STREAM_URL);
    expect(adapter.health()).toMatchObject({ status: 'DEGRADED', detail: /connecting/ });
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ subscribe: ['EURUSD=X', 'NQ=F'] })]);
    timers.run(15_000);
    expect(sockets[0]!.sent).toHaveLength(2);
    timers.run(30_000);
    expect(sockets[0]!.sent).toHaveLength(4);
  });

  it('emits prices with the provider timestamp; never a quote, even with a bid and ask', () => {
    const { clock, sockets, quotes, prices, adapter, start } = setup();
    start();
    sockets[0]!.open();
    const t = nowMs(clock) - 1_200;
    sockets[0]!.receive(frame({ id: 'NQ=F', price: 20000.25, time: t }));
    sockets[0]!.receive(
      frame({ id: 'EURUSD=X', price: 1.0855, time: t + 1, bid: 1.0854, ask: 1.0856 }),
    );
    expect(quotes).toEqual([]);
    expect(prices).toEqual([
      { symbol: 'NQ=F', price: 20000.25, asOf: new Date(t).toISOString() },
      { symbol: 'EURUSD=X', price: 1.0855, asOf: new Date(t + 1).toISOString() },
    ]);
    const [eur, nq] = adapter.stats().symbols;
    expect(nq).toMatchObject({ messages: 1, lastLagMs: 1_200, maxLagMs: 1_200, withBidAsk: 0 });
    expect(eur).toMatchObject({ messages: 1, lastPrice: 1.0855, withBidAsk: 1 });
  });

  it('discards malformed, unsubscribed and price-less messages, and counts them', () => {
    const { clock, sockets, quotes, prices, discarded, adapter, start } = setup();
    start();
    sockets[0]!.open();
    const s = sockets[0]!;
    s.receive(new Uint8Array([1, 2]));
    s.receive('not json');
    s.receive(JSON.stringify({ type: 'pricing' }));
    s.receive(JSON.stringify({ message: '!!!' }));
    s.receive(JSON.stringify({ message: YFINANCE_BTC_MESSAGE })); // real, but not subscribed
    s.receive(frame({ id: 'NQ=F', time: nowMs(clock) })); // no price
    s.receive(frame({ id: 'NQ=F', price: 20000 })); // no time
    s.receive(frame({ id: 'NQ=F', price: -1, time: nowMs(clock) }));
    expect(quotes).toEqual([]);
    expect(prices).toEqual([]);
    expect(adapter.stats().discarded).toBe(8);
    expect(discarded).toEqual([
      'non-text message',
      'message is not JSON',
      'message without a pricing payload',
      expect.stringMatching(/undecodable/),
      'not subscribed: BTC-USD',
      'NQ=F: no price or time',
      'NQ=F: no price or time',
      'NQ=F: no price or time',
    ]);
  });

  it('health: ONLINE only while prices arrive; delayed and silent streams are DEGRADED', () => {
    const { clock, sockets, timers, adapter, start } = setup();
    start();
    sockets[0]!.open();
    expect(adapter.health()).toMatchObject({ status: 'DEGRADED', detail: /no prices/ });
    sockets[0]!.receive(frame({ id: 'NQ=F', price: 20000, time: nowMs(clock) - 500 }));
    expect(adapter.health()).toMatchObject({ status: 'ONLINE', detail: '1/2 symbols streaming' });
    // A delayed market (e.g. 15-minute delayed data) is reported, never passed off as live.
    sockets[0]!.receive(frame({ id: 'EURUSD=X', price: 1.08, time: nowMs(clock) - 900_000 }));
    expect(adapter.health()).toMatchObject({
      status: 'DEGRADED',
      detail: /delayed: EURUSD=X 900 s/,
    });
    sockets[0]!.receive(frame({ id: 'EURUSD=X', price: 1.08, time: nowMs(clock) - 100 }));
    expect(adapter.health().status).toBe('ONLINE');
    timers.run(61_000);
    expect(adapter.health()).toMatchObject({ status: 'DEGRADED', detail: /no prices for 61 s/ });
  });

  it('reconnects with exponential backoff (1 s, 2 s, 4 s … 60 s max); ERROR after 5 attempts', () => {
    const { sockets, timers, adapter, start } = setup();
    start();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      sockets.at(-1)!.drop();
      delays.push(...timers.timeouts());
      timers.run(timers.timeouts()[0]!);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    expect(sockets).toHaveLength(9);
    sockets.at(-1)!.drop();
    expect(adapter.health()).toMatchObject({ status: 'ERROR', detail: /reconnect attempt 9/ });
  });

  it('a good price resets the backoff; a reconnect subscribes again', () => {
    const { clock, sockets, timers, adapter, start } = setup();
    start();
    sockets[0]!.drop();
    timers.run(1_000);
    sockets[1]!.drop();
    timers.run(2_000);
    sockets[2]!.open();
    sockets[2]!.receive(frame({ id: 'NQ=F', price: 20000, time: nowMs(clock) }));
    expect(adapter.stats()).toMatchObject({ reconnectAttempt: 0, connects: 1 });
    expect(sockets[2]!.sent).toHaveLength(1);
    sockets[2]!.drop();
    expect(timers.timeouts()).toEqual([1_000]);
  });

  it("an error without a close event (Node's failed handshake) still reconnects", () => {
    const { sockets, timers, adapter, start } = setup();
    start();
    sockets[0]!.fail('Received network error or non-101 status code.');
    expect(sockets[0]!.closed).toBe(true);
    expect(adapter.stats()).toMatchObject({
      state: 'WAITING_TO_RECONNECT',
      reconnectAttempt: 1,
      lastError: 'Received network error or non-101 status code.',
    });
    sockets[0]!.drop(); // a late close is ignored (detached)
    expect(adapter.stats().reconnectAttempt).toBe(1);
    timers.run(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.fail();
    expect(adapter.stats()).toMatchObject({ reconnectAttempt: 2, lastError: 'socket error' });
  });

  it('a handshake that never completes is abandoned after the connect timeout', () => {
    const { sockets, timers, adapter, start } = setup();
    start();
    timers.run(30_000);
    expect(sockets[0]!.closed).toBe(true);
    expect(adapter.stats()).toMatchObject({
      state: 'WAITING_TO_RECONNECT',
      lastError: 'connection timed out',
    });
    timers.run(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open(); // opened in time: the timeout no longer applies
    timers.run(60_000);
    expect(sockets).toHaveLength(2);
    expect(adapter.stats().state).toBe('OPEN');
  });

  it('closes and reconnects a socket that has been silent too long (a dead connection)', () => {
    const { sockets, timers, adapter, start } = setup({ reconnectIfSilentMs: 120_000 });
    start();
    sockets[0]!.open();
    timers.run(135_000);
    expect(sockets[0]!.closed).toBe(true);
    expect(adapter.stats()).toMatchObject({
      state: 'WAITING_TO_RECONNECT',
      lastError: 'no message for 135 s',
    });
    timers.run(1_000);
    expect(sockets).toHaveLength(2);
  });

  it('stop closes the socket, cancels timers and ignores late events', () => {
    const { clock, sockets, timers, prices, adapter, start } = setup();
    start();
    const s = sockets[0]!;
    s.open();
    adapter.stop();
    expect(s.closed).toBe(true);
    expect(timers.count).toBe(0);
    s.receive(frame({ id: 'NQ=F', price: 20000, time: nowMs(clock) }));
    s.drop();
    expect(prices).toEqual([]);
    expect(timers.count).toBe(0);
    expect(adapter.health()).toMatchObject({ status: 'UNKNOWN', detail: 'stopped' });
  });

  it('with no symbols it does not connect and says why', () => {
    const { sockets, adapter, start } = setup({ symbols: [] });
    start();
    expect(sockets).toHaveLength(0);
    expect(adapter.health()).toMatchObject({
      status: 'UNKNOWN',
      detail: 'no symbols configured for this feed',
    });
  });

  it('a socket factory that throws (no WebSocket) is a failed connect, retried', () => {
    const clock = new ManualClock(T0);
    const timers = new FakeTimers((ms) => clock.advance(ms));
    const adapter = new YahooStreamAdapter({
      symbols: ['NQ=F'],
      clock,
      timers,
      socket: () => {
        throw new Error('no WebSocket implementation in this runtime');
      },
    });
    adapter.start(() => {});
    expect(adapter.health()).toMatchObject({
      status: 'DEGRADED',
      detail: /no WebSocket implementation/,
    });
    expect(timers.timeouts()).toEqual([1_000]);
  });
});
