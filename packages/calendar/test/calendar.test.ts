import { ManualClock, type CalendarWindow, type EconomicEvent } from '@astra/core';
import { describe, expect, it, vi } from 'vitest';
import { CalendarPoller, type CalendarAdapter } from '../src/poller';
import { CalendarService, diffWindows, type CalendarChange } from '../src/service';
import { SimulatedCalendarAdapter } from '../src/simulated';

const NOW = '2026-09-28T12:00:00.000Z';

const event = (id: string, at: string, extra: Partial<EconomicEvent> = {}): EconomicEvent => ({
  id,
  title: `event ${id}`,
  impact: 'HIGH',
  scheduledAt: at,
  affectedInstruments: [],
  ...extra,
});

const win = (
  events: EconomicEvent[],
  from = '2026-09-28T00:00:00Z',
  to = '2026-09-29T00:00:00Z',
) => ({
  from,
  to,
  events,
});

function setup(
  instruments: Record<string, string[] | undefined> = {
    NQ: ['USD'],
    XAUUSD: ['USD'],
    EURUSD: undefined,
  },
) {
  const clock = new ManualClock(NOW);
  const changes: CalendarChange[][] = [];
  const service = new CalendarService({
    clock,
    freshness: { maxAgeMs: 3_600_000, maxFutureSkewMs: 2_000 },
    instruments: new Map(Object.entries(instruments).map(([s, c]) => [s, { eventCurrencies: c }])),
    onChanges: (c) => changes.push([...c]),
  });
  return { clock, service, changes };
}

describe('CalendarService', () => {
  it('is UNAVAILABLE until a window arrives, then OK until it ages into STALE', () => {
    const { clock, service } = setup();
    expect(service.current()).toMatchObject({ status: 'UNAVAILABLE' });
    expect(service.health().status).toBe('UNKNOWN');
    service.ingest(win([event('a', '2026-09-28T12:30:00Z')]), 'provider', 'LIVE');
    expect(service.fresh()).toMatchObject({
      status: 'OK',
      source: 'provider',
      sourceKind: 'LIVE',
      asOf: NOW,
    });
    expect(service.health()).toMatchObject({ status: 'ONLINE' });
    clock.advance(3_600_001);
    expect(service.fresh()).toMatchObject({ status: 'STALE' });
    expect(service.health()).toMatchObject({
      status: 'DEGRADED',
      detail: expect.stringMatching(/STALE/),
    });
  });

  it('rejects invalid windows and repeated ids, keeping the previous window', () => {
    const { service } = setup();
    service.ingest(win([event('a', '2026-09-28T12:30:00Z')]), 'provider', 'LIVE');
    expect(() => service.ingest({ from: 'x', to: 'y', events: [] }, 'provider', 'LIVE')).toThrow(
      /invalid calendar window/,
    );
    expect(() =>
      service.ingest(
        win([event('a', '2026-09-28T12:30:00Z'), event('a', '2026-09-28T13:30:00Z')]),
        'provider',
        'LIVE',
      ),
    ).toThrow(/repeats event id a/);
    expect(() =>
      service.ingest(win([], '2026-09-29T00:00:00Z', '2026-09-28T00:00:00Z'), 'p', 'LIVE'),
    ).toThrow();
    const w = service.current();
    expect(w.status === 'OK' && w.value.events.map((e) => e.id)).toEqual(['a']);
  });

  it('binds each source to one data kind', () => {
    const { service } = setup();
    service.ingest(win([]), 'sim', 'SIMULATED');
    expect(() => service.ingest(win([]), 'sim', 'LIVE')).toThrow(
      /delivers SIMULATED data; refusing LIVE/,
    );
  });

  it('maps events to instruments by currency, fail-safe for unmapped instruments and currencies', () => {
    const { service } = setup();
    service.ingest(
      win([
        event('usd', '2026-09-28T12:30:00Z', { currency: 'usd' }),
        event('jpy', '2026-09-28T13:00:00Z', { currency: 'JPY' }),
        event('none', '2026-09-28T14:00:00Z'),
        event('explicit', '2026-09-28T15:00:00Z', { currency: 'USD', affectedInstruments: ['NQ'] }),
      ]),
      'provider',
      'LIVE',
    );
    const w = service.current();
    if (w.status !== 'OK') throw new Error('expected a window');
    const affected = Object.fromEntries(w.value.events.map((e) => [e.id, e.affectedInstruments]));
    expect(affected).toEqual({
      usd: [], // every instrument is affected → "all"
      jpy: ['EURUSD'], // only the instrument without a currency list (fail-safe)
      none: [], // no currency → all
      explicit: ['NQ'], // the provider's own mapping wins
    });
  });

  it('reports changes inside the range both windows cover; the first window is the baseline', () => {
    const { service, changes } = setup();
    const first = service.ingest(
      win([
        event('cpi', '2026-09-28T12:30:00Z'),
        event('pmi', '2026-09-28T14:00:00Z', { impact: 'MEDIUM' }),
        event('gone', '2026-09-28T16:00:00Z'),
        event('early', '2026-09-28T01:00:00Z'),
      ]),
      'provider',
      'LIVE',
    );
    expect(first.changes).toEqual([]);
    // The second window starts later: "early" falls outside it and is NOT reported as removed.
    const second = service.ingest(
      win(
        [
          event('cpi', '2026-09-28T12:30:00Z', { actual: '0.3%' }),
          event('pmi', '2026-09-28T14:15:00Z', { impact: 'HIGH' }),
          event('new', '2026-09-28T18:00:00Z'),
        ],
        '2026-09-28T06:00:00Z',
      ),
      'provider',
      'LIVE',
    );
    expect(second.changes.map((c) => [c.type, c.event.id])).toEqual([
      ['ACTUAL_RELEASED', 'cpi'],
      ['RESCHEDULED', 'pmi'],
      ['IMPACT_CHANGED', 'pmi'],
      ['ADDED', 'new'],
      ['REMOVED', 'gone'],
    ]);
    expect(changes).toEqual([second.changes]);
  });

  it('upcoming() filters events and passes non-OK observations through', () => {
    const { service } = setup();
    expect(service.upcoming(new Date(NOW), new Date(NOW)).status).toBe('UNAVAILABLE');
    service.ingest(
      win([event('a', '2026-09-28T12:30:00Z'), event('b', '2026-09-28T20:00:00Z')]),
      'p',
      'LIVE',
    );
    const w = service.upcoming(new Date(NOW), new Date('2026-09-28T13:00:00Z'));
    expect(w.status === 'OK' && w.value.events.map((e) => e.id)).toEqual(['a']);
  });

  it('diffWindows ignores events outside the shared coverage', () => {
    const a: CalendarWindow = win([event('x', '2026-09-28T02:00:00Z')]);
    const b: CalendarWindow = win([], '2026-09-28T03:00:00Z');
    expect(diffWindows(a, b)).toEqual([]);
  });
});

describe('CalendarPoller', () => {
  const adapter = (fetch: CalendarAdapter['fetch']): CalendarAdapter => ({
    id: 'prov',
    kind: 'LIVE',
    fetch,
  });

  it('fetches [now − lookback, now + lookahead] and ingests the result', async () => {
    const { clock, service } = setup();
    const fetch = vi.fn((range: { from: Date; to: Date }) =>
      Promise.resolve(
        win([event('a', '2026-09-28T12:30:00Z')], range.from.toISOString(), range.to.toISOString()),
      ),
    );
    const poller = new CalendarPoller({
      adapter: adapter(fetch),
      service,
      clock,
      intervalMs: 60_000,
      timeoutMs: 1_000,
      lookbackMs: 3_600_000,
      lookaheadMs: 7 * 86_400_000,
    });
    const r = await poller.poll();
    expect(r).toMatchObject({ ok: true, at: NOW, events: 1, changes: [] });
    expect(fetch.mock.calls[0]![0]).toEqual({
      from: new Date('2026-09-28T11:00:00Z'),
      to: new Date('2026-10-05T12:00:00Z'),
    });
    expect(service.fresh()).toMatchObject({ status: 'OK', source: 'prov', sourceKind: 'LIVE' });
    expect(poller.status()).toMatchObject({
      lastSuccessAt: NOW,
      consecutiveFailures: 0,
      lastError: null,
    });
  });

  it('keeps the previous window on failure and counts consecutive failures', async () => {
    const { clock, service } = setup();
    let fail = false;
    const poller = new CalendarPoller({
      adapter: adapter(() =>
        fail ? Promise.reject(new Error('HTTP 503')) : Promise.resolve(win([])),
      ),
      service,
      clock,
      intervalMs: 60_000,
      timeoutMs: 1_000,
      lookbackMs: 0,
      lookaheadMs: 3_600_000,
    });
    await poller.poll();
    fail = true;
    clock.advance(60_000);
    expect(await poller.poll()).toMatchObject({ ok: false, error: 'HTTP 503', failures: 1 });
    expect(await poller.poll()).toMatchObject({ ok: false, failures: 2 });
    expect(service.current()).toMatchObject({ status: 'OK', asOf: NOW }); // still the old window
    expect(poller.status()).toMatchObject({
      lastSuccessAt: NOW,
      lastError: 'HTTP 503',
      consecutiveFailures: 2,
    });
  });

  it('times out a hanging provider and aborts its request; invalid data counts as a failure', async () => {
    vi.useFakeTimers();
    try {
      const { clock, service } = setup();
      let aborted = false;
      const hanging = new CalendarPoller({
        adapter: adapter((_, signal) => {
          signal.addEventListener('abort', () => (aborted = true));
          return new Promise(() => {});
        }),
        service,
        clock,
        intervalMs: 60_000,
        timeoutMs: 5_000,
        lookbackMs: 0,
        lookaheadMs: 3_600_000,
      });
      const pending = hanging.poll();
      expect(hanging.poll()).toBe(pending); // never overlaps with itself
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toMatchObject({
        ok: false,
        error: expect.stringMatching(/timed out after 5000 ms/),
      });
      expect(aborted).toBe(true);

      const invalid = new CalendarPoller({
        adapter: adapter(() => Promise.resolve({ events: 'nope' })),
        service,
        clock,
        intervalMs: 60_000,
        timeoutMs: 5_000,
        lookbackMs: 0,
        lookaheadMs: 3_600_000,
      });
      expect(await invalid.poll()).toMatchObject({
        ok: false,
        error: expect.stringMatching(/invalid calendar window/),
      });
      expect(service.current().status).toBe('UNAVAILABLE');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SimulatedCalendarAdapter', () => {
  it('generates the labelled weekly schedule in New York time across a DST change', () => {
    const sim = new SimulatedCalendarAdapter();
    // Fri 30 Oct → Wed 4 Nov 2026 (US clocks go back on Sun 1 Nov).
    const w = sim.window({
      from: new Date('2026-10-30T00:00:00Z'),
      to: new Date('2026-11-04T23:59:00Z'),
    });
    const high = w.events.filter((e) => e.impact === 'HIGH').map((e) => [e.id, e.scheduledAt]);
    expect(high).toEqual([
      ['sim-us-high-2026-10-30', '2026-10-30T12:30:00.000Z'], // 08:30 EDT
      ['sim-us-high-2026-11-02', '2026-11-02T13:30:00.000Z'], // 08:30 EST
      ['sim-us-high-2026-11-03', '2026-11-03T13:30:00.000Z'],
      ['sim-us-high-2026-11-04', '2026-11-04T13:30:00.000Z'],
      ['sim-us-rate-2026-11-04', '2026-11-04T19:00:00.000Z'], // Wednesday 14:00 EST
    ]);
    expect(w.events.every((e) => e.title.startsWith('SIMULATED'))).toBe(true);
    expect(w.events.some((e) => e.scheduledAt.startsWith('2026-10-31'))).toBe(false); // weekend
  });

  it('keeps only events inside the requested range, which becomes the coverage', async () => {
    const sim = new SimulatedCalendarAdapter();
    const range = { from: new Date('2026-09-28T12:31:00Z'), to: new Date('2026-09-28T14:00:00Z') };
    expect(await sim.fetch(range)).toEqual({
      from: '2026-09-28T12:31:00.000Z',
      to: '2026-09-28T14:00:00.000Z',
      events: [
        {
          id: 'sim-us-medium-2026-09-28',
          title: 'SIMULATED — US medium-impact release',
          currency: 'USD',
          impact: 'MEDIUM',
          scheduledAt: '2026-09-28T14:00:00.000Z',
          affectedInstruments: [],
        },
      ],
    });
  });
});
