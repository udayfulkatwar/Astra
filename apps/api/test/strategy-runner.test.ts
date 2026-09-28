import type { Bar } from '@astra/market-data';
import { afterEach, describe, expect, it } from 'vitest';
import { HOUR, M15, h1Path, split, type Ohlc } from '../../../packages/strategy-lsfvg/test/helpers';
import { H, bringOnline, createHarness, dbAvailable, START, type Harness } from './harness';

const available = await dbAvailable();
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type Json = Record<string, any>;
const json = (r: { body: string }) => JSON.parse(r.body) as Json;
const get = async (harness: Harness, url: string) =>
  json(await harness.app.inject({ url, headers: H.operator }));

// The engine test's scenario (bullish H1, sweep of 1.0990, displacement, FVG 1.1000–1.1012),
// shifted so the setup completes exactly at the harness start (Monday 14:00 UTC).
const H1 = h1Path([
  [0, 1.095],
  [4, 1.09],
  [9, 1.098],
  [14, 1.094],
  [19, 1.105],
  [24, 1.101],
]);
const M15S: Ohlc[] = [
  { o: 1.101, h: 1.1014, l: 1.1006, c: 1.1008 },
  { o: 1.1008, h: 1.101, l: 1.1, c: 1.1002 },
  { o: 1.1002, h: 1.1004, l: 1.099, c: 1.0994 },
  { o: 1.0994, h: 1.1003, l: 1.0993, c: 1.1001 },
  { o: 1.1001, h: 1.1008, l: 1.0998, c: 1.1006 },
  { o: 1.1006, h: 1.1016, l: 1.1004, c: 1.1012 },
  { o: 1.1012, h: 1.102, l: 1.1009, c: 1.1011 },
  { o: 1.1011, h: 1.1013, l: 1.1003, c: 1.1004 },
  { o: 1.1004, h: 1.1006, l: 1.0996, c: 1.0998 },
  { o: 1.0998, h: 1.1, l: 1.0985, c: 1.0995 },
  { o: 1.0995, h: 1.103, l: 1.0993, c: 1.1028 },
  { o: 1.1028, h: 1.1035, l: 1.1012, c: 1.103 },
];

function bars(extra: Ohlc[] = []): Bar[] {
  const start = Date.parse(START) - 24 * HOUR - 12 * M15;
  const out = [];
  let t = start;
  for (const x of H1) {
    out.push(...split(t, x, 12));
    t += HOUR;
  }
  for (const x of [...M15S, ...extra]) {
    out.push(...split(t, x, 3));
    t += M15;
  }
  return out.map((c) => ({
    ...c,
    symbol: 'EURUSD',
    timeframe: 'M5' as const,
    volume: null,
    tickCount: 0,
    complete: true,
    source: 'test',
    sourceKind: 'SIMULATED' as const,
  }));
}

async function eurusd(harness: Harness, bid: number) {
  await harness.app.inject({
    method: 'POST',
    url: '/api/v1/market/quotes',
    headers: H.automation,
    payload: {
      source: 'test',
      quotes: [
        {
          symbol: 'EURUSD',
          bid,
          ask: Math.round((bid + 0.00008) * 1e5) / 1e5,
          asOf: harness.clock.now().toISOString(),
        },
      ],
    },
  });
}

describe.skipIf(!available)('API — strategy runner (ADR-0024)', () => {
  it('turns a completed LSFVG setup into a gated LIMIT order with the §26 record', async () => {
    h = await createHarness();
    await bringOnline(h);
    await eurusd(h, 1.103);
    const all = bars();
    // Everything up to the setup's last candle closes at the harness clock.
    expect(all.at(-1)!.closeTime).toBe(START);
    h.runtime.strategies.onBars(all);
    await h.runtime.strategies.idle();

    const status = await get(h, '/api/v1/strategies/runner');
    expect(status.enabled).toBe(true);
    const a = status.recent.find((r: Json) => r.strategyId === 'lsfvg-a');
    expect(a).toMatchObject({
      accountId: 'paper-fx',
      record: {
        PAIR: 'EURUSD',
        DIRECTION: 'LONG',
        'LIQUIDITY TYPE': 'SWING_LOW',
        'FVG RANGE': '1.1 – 1.1012',
        ENTRY: '1.1006 (LIMIT, until 2026-09-28T15:00:00.000Z)',
        DECISION: 'TRADE',
        'RISK %': expect.stringMatching(/^0\.2\d*%$/),
        'CORRELATION CHECK': 'PASS',
      },
    });
    expect(a.execution).toMatch(/^CONFIRMED: WORKING: LIMIT/);
    // Model B is measured on its own account.
    expect(status.recent.some((r: Json) => r.strategyId === 'lsfvg-b')).toBe(true);

    const orders = (await get(h, '/api/v1/accounts/paper-fx')).orders as Json[];
    expect(orders[0]).toMatchObject({
      symbol: 'EURUSD',
      entryType: 'LIMIT',
      plannedEntry: 1.1006,
      status: 'ACCEPTED',
      strategyId: 'lsfvg-a',
    });
    const events = ((await get(h, '/api/v1/events?limit=50')).events as Json[]).map((e) => e.type);
    expect(events).toContain('STRATEGY_SETUP_APPROVED');
  });

  it('cancels the resting order when an M5 candle closes below the sweep low', async () => {
    h = await createHarness();
    await bringOnline(h);
    await eurusd(h, 1.103);
    const all = bars([{ o: 1.103, h: 1.1031, l: 1.098, c: 1.0982 }]);
    const upToSetup = all.filter((b) => Date.parse(b.closeTime) <= Date.parse(START));
    h.runtime.strategies.onBars(upToSetup);
    await h.runtime.strategies.idle();
    const id = ((await get(h, '/api/v1/accounts/paper-fx')).orders as Json[])[0]!.clientOrderId;

    // The next 15 minutes (fed as candles only: no quote reaches the limit here).
    h.clock.advance(15 * 60_000);
    h.runtime.strategies.onBars(all.slice(upToSetup.length));
    await h.runtime.strategies.idle();
    const orders = (await get(h, '/api/v1/accounts/paper-fx')).orders as Json[];
    expect(orders.find((o) => o.clientOrderId === id)).toMatchObject({ status: 'CANCELLED' });
  });
});
