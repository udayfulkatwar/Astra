import type { FetchLike } from '@astra/market-data';
import { createDb } from '@astra/db';
import { ManualClock } from '@astra/core';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeSocket, frame } from '../../../packages/market-data/test/yahoo-fixtures';
import { loadEnv } from '../src/env';
import { parseFeedList } from '../src/runtime/feeds';
import { AstraRuntime } from '../src/runtime/runtime';
import { CONFIG, H, START, createHarness, dbAvailable, type Harness } from './harness';

const available = await dbAvailable();
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type Json = Record<string, any>;
const json = (r: { body: string }) => JSON.parse(r.body) as Json;
const get = async (url: string) => json(await h!.app.inject({ url, headers: H.viewer }));

/**
 * SYNTHETIC chart responses in Yahoo's documented format (made-up prices, not market data):
 * 30 complete 1-minute candles 13:30–14:00 UTC for every symbol; GBPUSD=X answers HTTP 404.
 */
function fakeYahoo() {
  const sockets: FakeSocket[] = [];
  const requested: string[] = [];
  const fetch: FetchLike = (url) => {
    const symbol = decodeURIComponent(url.split('/chart/')[1]!.split('?')[0]!);
    requested.push(symbol);
    if (symbol === 'GBPUSD=X') {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    }
    const base = symbol.endsWith('=F') ? 20_000 : symbol === 'USDJPY=X' ? 150 : 1.1;
    const t0 = Date.parse(START) / 1000 - 30 * 60;
    const ts = Array.from({ length: 30 }, (_, i) => t0 + i * 60);
    const px = (i: number, d: number) => base * (1 + (i + d) / 10_000);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          chart: {
            result: [
              {
                timestamp: ts,
                indicators: {
                  quote: [
                    {
                      open: ts.map((_, i) => px(i, 0)),
                      high: ts.map((_, i) => px(i, 2)),
                      low: ts.map((_, i) => px(i, -1)),
                      close: ts.map((_, i) => px(i, 1)),
                      volume: ts.map(() => 0),
                    },
                  ],
                },
              },
            ],
            error: null,
          },
        }),
    });
  };
  const socket = (url: string) => {
    const s = new FakeSocket(url);
    sockets.push(s);
    return s;
  };
  return { sockets, requested, transport: { fetch, socket } };
}

describe.skipIf(!available)('API — free chart feed (Yahoo, prices only)', () => {
  it('loads history, streams prices into the charts, and never provides a tradable quote', async () => {
    const yahoo = fakeYahoo();
    h = await createHarness({ feeds: ['yahoo'], feedTransport: yahoo.transport });
    await h.runtime.feedHistoryLoaded();

    // One connection, subscribed to every mapped instrument (XAUUSD has no free feed).
    expect(yahoo.sockets).toHaveLength(1);
    yahoo.sockets[0]!.open();
    const sub = JSON.parse(yahoo.sockets[0]!.sent[0]!) as { subscribe: string[] };
    expect(sub.subscribe.sort()).toEqual(['EURUSD=X', 'GBPUSD=X', 'MNQ=F', 'NQ=F', 'USDJPY=X']);
    expect(yahoo.requested.sort()).toEqual(sub.subscribe);

    // History: 30 one-minute candles → M1 + whole M5 / M15 / M30 periods (the H1 began earlier).
    const { feeds } = await get('/api/v1/market/feeds');
    expect(feeds).toHaveLength(1);
    const feed = feeds[0] as Json;
    expect(feed).toMatchObject({ id: 'yahoo', kind: 'LIVE', use: 'CHARTS_ONLY' });
    const eur = (feed.backfill as Json[]).find((b) => b.symbol === 'EURUSD');
    expect(eur).toMatchObject({
      providerSymbol: 'EURUSD=X',
      status: 'DONE',
      received: 30,
      kept: 30,
      dropped: 0,
      loaded: 30 + 6 + 2 + 1,
      stored: 39,
      error: null,
    });
    expect((feed.backfill as Json[]).find((b) => b.symbol === 'GBPUSD')).toMatchObject({
      status: 'FAILED',
      error: 'HTTP 404',
    });
    const m1 = (await get('/api/v1/market/bars?symbol=EURUSD&timeframe=M1&limit=100'))
      .bars as Json[];
    expect(m1).toHaveLength(30);
    expect(m1[0]).toMatchObject({ openTime: '2026-09-28T13:30:00.000Z', source: 'yahoo' });
    expect(m1.every((b) => b.volume === null)).toBe(true); // FX volume 0 → unknown, not 0
    expect(await h.runtime.repos.marketBars.recent('EURUSD', 'M5', 100)).toHaveLength(6);

    // Live prices continue the same series; the provider's time is kept, the delay measured.
    h.clock.advance(5_000);
    const t = h.clock.now().getTime() - 300;
    yahoo.sockets[0]!.receive(frame({ id: 'EURUSD=X', price: 1.1042, time: t }));
    expect((await get('/api/v1/market/prices')).prices).toEqual([
      {
        symbol: 'EURUSD',
        price: 1.1042,
        asOf: new Date(t).toISOString(),
        source: 'yahoo',
        sourceKind: 'LIVE',
      },
    ]);
    const after = (await get('/api/v1/market/bars?symbol=EURUSD&timeframe=M1&limit=100'))
      .bars as Json[];
    expect(after).toHaveLength(31);
    expect(after.at(-1)).toMatchObject({ openTime: START, complete: false, close: 1.1042 });
    const streamed = ((await get('/api/v1/market/feeds')).feeds[0].stream.symbols as Json[]).find(
      (s) => s.instrument === 'EURUSD',
    );
    expect(streamed).toMatchObject({ symbol: 'EURUSD=X', messages: 1, lastLagMs: 300 });

    // …but a price is never a quote: the gate's view of market data is unchanged (no trade).
    expect(h.runtime.market.fresh('EURUSD')).toMatchObject({ status: 'UNAVAILABLE' });
    await h.runtime.cycle();
    const status = await get('/api/v1/system/status');
    expect(status.data.status).not.toBe('ONLINE');
    expect(status.data.detail).toMatch(/chart feed yahoo ONLINE: .*prices only, never tradable/);

    const socket = yahoo.sockets[0]!;
    await h.close();
    h = undefined;
    expect(socket.closed).toBe(true);
  });

  it('without ASTRA_FEEDS nothing connects and the feeds list is empty', async () => {
    h = await createHarness();
    expect(h.runtime.yahoo).toBeNull();
    expect(await get('/api/v1/market/feeds')).toEqual({ feeds: [] });
    expect(await get('/api/v1/market/prices')).toEqual({ prices: [] });
  });
});

describe('ASTRA_FEEDS', () => {
  const base = {
    DATABASE_URL: 'postgres://astra:x@localhost:5432/astra',
    ASTRA_OPERATOR_TOKEN: 'o'.repeat(32),
    ASTRA_AUTOMATION_TOKEN: 'a'.repeat(32),
  };

  it('is a list of known feeds; empty by default', () => {
    expect(loadEnv(base).ASTRA_FEEDS).toEqual([]);
    expect(loadEnv({ ...base, ASTRA_FEEDS: ' Yahoo, yahoo ' }).ASTRA_FEEDS).toEqual(['yahoo']);
    expect(() => loadEnv({ ...base, ASTRA_FEEDS: 'yahoo,bloomberg' })).toThrow(
      /unknown feed\(s\) bloomberg/,
    );
    expect(parseFeedList('')).toEqual([]);
  });

  it('cannot be combined with simulation (simulated and real prices must not mix)', () => {
    expect(() => loadEnv({ ...base, ASTRA_SIMULATION: 'true', ASTRA_FEEDS: 'yahoo' })).toThrow(
      /cannot be combined/,
    );
    const sql = createDb({ url: base.DATABASE_URL });
    expect(
      () =>
        new AstraRuntime({
          config: CONFIG,
          sql,
          clock: new ManualClock(START),
          log: pino({ level: 'silent' }),
          runMigrations: false,
          liveTradingAuthorized: false,
          simulation: true,
          feeds: ['yahoo'],
          startLoops: false,
        }),
    ).toThrow(/cannot run together/);
    void sql.end();
  });
});
