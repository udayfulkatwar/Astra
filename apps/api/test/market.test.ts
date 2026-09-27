import { afterEach, describe, expect, it } from 'vitest';
import { H, bringOnline, candidate, createHarness, dbAvailable, type Harness } from './harness';

const available = await dbAvailable();
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type Json = Record<string, any>;
const json = (r: { body: string }) => JSON.parse(r.body) as Json;

async function postQuotes(
  harness: Harness,
  quotes: { symbol: string; bid: number; ask: number; asOf?: string }[],
) {
  const asOf = harness.clock.now().toISOString();
  const r = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/market/quotes',
    headers: H.automation,
    payload: { source: 'test', quotes: quotes.map((q) => ({ asOf, ...q })) },
  });
  return json(r);
}

const get = async (harness: Harness, url: string) => harness.app.inject({ url, headers: H.viewer });

const scanner = async (harness: Harness) =>
  json(await get(harness, '/api/v1/market/scanner')).snapshots as Json[];

describe.skipIf(!available)('API — market scanner', () => {
  it('returns a snapshot per configured instrument with nulls where nothing is derivable', async () => {
    h = await createHarness();
    expect((await h.app.inject({ url: '/api/v1/market/scanner' })).statusCode).toBe(401);
    await bringOnline(h);
    const snaps = await scanner(h);
    expect(snaps.map((s) => s.symbol).sort()).toEqual(['MNQ', 'NQ', 'XAUUSD']);
    const mnq = snaps.find((s) => s.symbol === 'MNQ')!;
    expect(mnq).toMatchObject({
      asOf: '2026-09-28T14:00:00.000Z',
      quote: { status: 'OK', source: 'ingest:test', sourceKind: 'MANUAL' },
      mid: 20_000.125,
      spreadTicks: 1,
      market: { open: true, nextClose: '2026-09-28T21:00:00.000Z' },
      activeSessions: ['london', 'new-york', 'ny-cash', 'london-ny-overlap'],
      // Observation started at 10:00 New York: today's bar and every session began earlier,
      // so their levels are unknown — null / omitted, never estimated.
      today: null,
      previousDay: null,
      changeFromPrevClosePct: null,
      sessions: [],
      atr: { H1: null, D1: null },
      quality: { status: 'OK', reason: null, lastJumpAt: null },
      barsAvailable: { M1: 0, M5: 0, M15: 0, M30: 0, H1: 0, H4: 0, D1: 0 },
    });
  });

  it('reports the current trading day once it has been observed from its start', async () => {
    h = await createHarness();
    await postQuotes(h, [{ symbol: 'MNQ', bid: 20_000, ask: 20_000.25 }]);
    h.clock.set('2026-09-28T22:00:30.000Z'); // Mon 18:00:30 New York: a new trading day
    await postQuotes(h, [{ symbol: 'MNQ', bid: 20_010, ask: 20_010.25 }]);
    h.clock.advance(10_000);
    await postQuotes(h, [{ symbol: 'MNQ', bid: 20_014, ask: 20_014.25 }]);
    const mnq = (await scanner(h)).find((s) => s.symbol === 'MNQ')!;
    expect(mnq).toMatchObject({
      today: { open: 20_010.125, high: 20_014.125, low: 20_010.125, close: 20_014.125 },
      previousDay: null, // Monday was only partly observed: discarded, not shown as complete
      activeSessions: [],
      // Bars that began before 14:00 (the H4 12:00 bar, Monday's D1) were incomplete.
      barsAvailable: { M1: 1, M5: 1, M15: 1, M30: 1, H1: 1, H4: 0, D1: 0 },
    });
  });
});

describe.skipIf(!available)('API — bars', () => {
  it('validates the query and serves bars oldest → newest with their completeness', async () => {
    h = await createHarness();
    await postQuotes(h, [{ symbol: 'MNQ', bid: 20_000, ask: 20_000.25 }]);
    h.clock.advance(65_000);
    await postQuotes(h, [{ symbol: 'MNQ', bid: 20_001, ask: 20_001.25 }]);

    const r = await get(h, '/api/v1/market/bars?symbol=MNQ&timeframe=M1&limit=10');
    expect(r.statusCode).toBe(200);
    expect(json(r).bars).toEqual([
      {
        symbol: 'MNQ',
        timeframe: 'M1',
        openTime: '2026-09-28T14:00:00.000Z',
        closeTime: '2026-09-28T14:01:00.000Z',
        open: 20_000.125,
        high: 20_000.125,
        low: 20_000.125,
        close: 20_000.125,
        volume: null,
        tickCount: 1,
        complete: true,
        source: 'ingest:test',
        sourceKind: 'MANUAL',
      },
      expect.objectContaining({ openTime: '2026-09-28T14:01:00.000Z', complete: false }),
    ]);
    expect(
      json(await get(h, '/api/v1/market/bars?symbol=MNQ&timeframe=M1&limit=1')).bars,
    ).toHaveLength(1);
    expect(json(await get(h, '/api/v1/market/bars?symbol=NQ&timeframe=D1')).bars).toEqual([]);

    for (const bad of [
      'symbol=MNQ&timeframe=M2',
      'symbol=MNQ&timeframe=M1&limit=0',
      'symbol=MNQ&timeframe=M1&limit=1001',
      'symbol=mnq&timeframe=M1',
      'timeframe=M1',
    ]) {
      const res = await get(h, `/api/v1/market/bars?${bad}`);
      expect(res.statusCode, bad).toBe(400);
      expect(json(res).error.code).toBe('VALIDATION');
    }
    expect((await get(h, '/api/v1/market/bars?symbol=ES&timeframe=M1')).statusCode).toBe(404);
    expect(
      (await h.app.inject({ url: '/api/v1/market/bars?symbol=MNQ&timeframe=M1' })).statusCode,
    ).toBe(401);
  });

  it('persists completed bars and serves them again after a restart', async () => {
    h = await createHarness();
    for (const [offsetMs, bid] of [
      [0, 20_000],
      [20_000, 20_002],
      [20_000, 19_999],
      [25_000, 20_001],
    ] as const) {
      h.clock.advance(offsetMs);
      await postQuotes(h, [{ symbol: 'MNQ', bid, ask: bid + 0.25 }]);
    }
    h.clock.set('2026-09-28T14:02:03.000Z'); // 14:01 bar ends; closed by the loop after 2 s grace
    await h.runtime.cycle();
    await h.runtime.barPersister.flush(); // the loop writes bars in the background
    expect(h.runtime.barPersister.stats()).toMatchObject({ pending: 0, persisted: 2 });
    const before = json(await get(h, '/api/v1/market/bars?symbol=MNQ&timeframe=M1')).bars;
    expect(
      before.map((b: Json) => [b.openTime, b.open, b.high, b.low, b.close, b.complete]),
    ).toEqual([
      ['2026-09-28T14:00:00.000Z', 20_000.125, 20_002.125, 19_999.125, 19_999.125, true],
      ['2026-09-28T14:01:00.000Z', 20_001.125, 20_001.125, 20_001.125, 20_001.125, true],
    ]);
    expect(await h.runtime.repos.marketBars.recent('MNQ', 'M1', 10)).toEqual(before);

    h = await h.restart();
    expect(json(await get(h, '/api/v1/market/bars?symbol=MNQ&timeframe=M1')).bars).toEqual(before);
    // The M5 bar was still in progress at shutdown: never stored, never resurrected.
    expect(json(await get(h, '/api/v1/market/bars?symbol=MNQ&timeframe=M5')).bars).toEqual([]);
    expect((await scanner(h)).find((s) => s.symbol === 'MNQ')!.barsAvailable.M1).toBe(2);

    // The minute in progress at restart was only partly observed: it stays hidden.
    h.clock.advance(7_000);
    await postQuotes(h, [{ symbol: 'MNQ', bid: 20_003, ask: 20_003.25 }]);
    expect(json(await get(h, '/api/v1/market/bars?symbol=MNQ&timeframe=M1')).bars).toEqual(before);
  });
});

describe.skipIf(!available)('API — market-data quality and health', () => {
  it('an abnormal price jump blocks decisions during the cooldown, then trading recovers', async () => {
    h = await createHarness();
    await bringOnline(h);
    h.clock.advance(1_000);
    const jumpAt = h.clock.now().toISOString();
    // 100 points = 400 ticks > MNQ maxQuoteJumpTicks 200.
    expect(await postQuotes(h, [{ symbol: 'MNQ', bid: 20_100, ask: 20_100.25 }])).toEqual({
      accepted: 1,
      ignored: [],
    });

    const r = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/decisions/evaluate',
        headers: H.automation,
        payload: {
          candidate: candidate(h, { entry: 20_100.25, stop: 20_090.25, target: 20_120.25 }),
        },
      }),
    );
    expect(r.decision.status).toBe('REJECTED');
    const quoteCheck = r.decision.checks.find((c: Json) => c.checkId === 'data.quote');
    expect(quoteCheck.verdict).not.toBe('PASS');
    expect(r.decision.reasons.join()).toMatch(/quote INVALID .*abnormal price jump of 400 ticks/);

    const mnq = (await scanner(h)).find((s) => s.symbol === 'MNQ')!;
    expect(mnq).toMatchObject({
      quote: { status: 'INVALID' },
      mid: null,
      quality: { status: 'SUSPECT', lastJumpAt: jumpAt },
    });
    expect(mnq.quality.reason).toMatch(/abnormal price jump/);

    // After the 60 s cooldown, fresh quotes at the new level are valid again.
    h.clock.advance(61_000);
    await postQuotes(h, [
      { symbol: 'MNQ', bid: 20_100, ask: 20_100.25 },
      { symbol: 'NQ', bid: 20_000, ask: 20_000.25 },
      { symbol: 'XAUUSD', bid: 2_600, ask: 2_600.2 },
    ]);
    await h.runtime.cycle();
    const ok = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/decisions/evaluate',
        headers: H.automation,
        payload: {
          candidate: candidate(h, { entry: 20_100.25, stop: 20_090.25, target: 20_120.25 }),
        },
      }),
    );
    expect(ok.decision.reasons).toEqual([]);
    expect(ok.decision.status).toBe('APPROVED');
    expect((await scanner(h)).find((s) => s.symbol === 'MNQ')!.quality).toEqual({
      status: 'OK',
      reason: null,
      lastJumpAt: jumpAt,
    });
  });

  it('MARKET_DATA is DEGRADED when only some traded instruments have fresh quotes', async () => {
    h = await createHarness();
    await bringOnline(h);
    h.clock.advance(6_000); // quote freshness limit is 5 s
    await postQuotes(h, [{ symbol: 'MNQ', bid: 20_000, ask: 20_000.25 }]);
    await h.runtime.cycle();
    const s = json(await get(h, '/api/v1/system/status'));
    expect(s.data.status).toBe('DEGRADED');
    expect(s.data.detail).toMatch(/fresh quotes for 1\/3: MNQ \(ingest:test\)/);
    expect(s.data.detail).toMatch(/NQ STALE/);
    expect(s.trading.reasons).toContain('MARKET_DATA DEGRADED');
  });

  it('ignores out-of-order quotes and says so; unknown instruments are still refused', async () => {
    h = await createHarness();
    await bringOnline(h);
    const earlier = new Date(h.clock.now().getTime() - 1_000).toISOString();
    const r = await postQuotes(h, [{ symbol: 'MNQ', bid: 19_000, ask: 19_000.25, asOf: earlier }]);
    expect(r).toEqual({
      accepted: 0,
      ignored: [{ symbol: 'MNQ', reason: expect.stringMatching(/older than the latest/) }],
    });
    const unknown = await h.app.inject({
      method: 'POST',
      url: '/api/v1/market/quotes',
      headers: H.automation,
      payload: {
        source: 'test',
        quotes: [{ symbol: 'ES', bid: 1, ask: 1, asOf: h.clock.now().toISOString() }],
      },
    });
    expect(unknown.statusCode).toBe(400);
    expect(json(unknown).error.message).toMatch(/unknown instrument ES/);
    const quotes = json(await get(h, '/api/v1/market/quotes')).quotes as Json[];
    expect(quotes.find((q) => q.value.symbol === 'MNQ')!.value.bid).toBe(20_000);
  });

  it('runs the SIMULATED adapter when simulation is enabled (labelled SIMULATED end to end)', async () => {
    h = await createHarness({ simulation: true });
    expect(h.runtime.simulation?.health().status).toBe('ONLINE');
    await h.runtime.cycle();
    const quotes = json(await get(h, '/api/v1/market/quotes')).quotes as Json[];
    expect(quotes.map((q) => [q.value.symbol, q.source, q.sourceKind]).sort()).toEqual([
      ['MNQ', 'simulation', 'SIMULATED'],
      ['NQ', 'simulation', 'SIMULATED'],
      ['XAUUSD', 'simulation', 'SIMULATED'],
    ]);
    const s = json(await get(h, '/api/v1/system/status'));
    expect(s.data.status).toBe('ONLINE');
    expect(s.calendar.source).toBe('SIMULATED');
    expect(s.simulation).toBe(true);
  });
});

describe.skipIf(!available)('API — market structure', () => {
  it('derives swings from complete bars only and validates the query', async () => {
    h = await createHarness();
    // One quote per minute from 14:00: M1 mids …000, …001, …005, …002, …001 (+ the live bar).
    for (const bid of [20_000, 20_001, 20_005, 20_002, 20_001, 20_000]) {
      await postQuotes(h, [{ symbol: 'MNQ', bid, ask: bid + 0.25 }]);
      h.clock.advance(60_000);
    }
    const r = await get(h, '/api/v1/market/structure?symbol=MNQ&timeframe=M1');
    expect(r.statusCode).toBe(200);
    const [s] = json(r).structures as Json[];
    expect(s).toMatchObject({
      symbol: 'MNQ',
      timeframe: 'M1',
      asOf: '2026-09-28T14:05:00.000Z', // the in-progress 14:05 bar is not analysed
      barsAnalysed: 5,
      sufficient: true,
      trend: 'UNKNOWN',
      params: { swingStrength: 2, equalLevelTicks: 2 },
      swings: [
        {
          kind: 'HIGH',
          price: 20_005.125,
          time: '2026-09-28T14:02:00.000Z',
          confirmedAt: '2026-09-28T14:05:00.000Z',
          label: null,
          status: 'INTACT',
          resolvedAt: null,
        },
      ],
      breaks: [],
      nearestAbove: { side: 'BUY_SIDE', level: 20_005.125, kind: 'SWING' },
      nearestBelow: null,
    });

    const all = json(await get(h, '/api/v1/market/structure')).structures as Json[];
    // Default H1: the 14:00 bar is still in progress, so there is nothing to analyse yet.
    expect(all.map((x) => [x.symbol, x.timeframe, x.barsAnalysed, x.trend]).sort()).toEqual([
      ['MNQ', 'H1', 0, 'UNKNOWN'],
      ['NQ', 'H1', 0, 'UNKNOWN'],
      ['XAUUSD', 'H1', 0, 'UNKNOWN'],
    ]);
    expect((await get(h, '/api/v1/market/structure?timeframe=M2')).statusCode).toBe(400);
    expect((await get(h, '/api/v1/market/structure?symbol=ES')).statusCode).toBe(404);
    expect((await h.app.inject({ url: '/api/v1/market/structure' })).statusCode).toBe(401);
  });
});
