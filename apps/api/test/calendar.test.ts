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
const get = async (harness: Harness, url: string) =>
  json(await harness.app.inject({ url, headers: H.viewer }));

const push = (harness: Harness, events: Json[]) =>
  harness.app.inject({
    method: 'POST',
    url: '/api/v1/calendar/window',
    headers: H.automation,
    payload: {
      source: 'n8n',
      window: {
        from: '2026-09-28T12:00:00.000Z',
        to: '2026-09-29T14:00:00.000Z',
        events,
      },
    },
  });

const cpi = (at: string) => ({
  id: 'us-cpi',
  title: 'US CPI (m/m)',
  currency: 'USD',
  impact: 'HIGH',
  scheduledAt: at,
  expected: '0.3%',
});

describe.skipIf(!available)('API — economic calendar', () => {
  it('blocks trades inside an event blackout, reports changes and fails closed when stale', async () => {
    h = await createHarness();
    await bringOnline(h); // 14:00 UTC, Monday 10:00 New York

    expect((await push(h, [cpi('2026-09-28T14:10:00.000Z')])).statusCode).toBe(200);
    let risk = await get(h, '/api/v1/calendar/risk');
    expect(risk.calendar).toMatchObject({
      status: 'OK',
      source: 'ingest:n8n',
      sourceKind: 'MANUAL',
    });
    expect(risk.rule).toEqual({ impactLevels: ['HIGH'], minutesBefore: 15, minutesAfter: 15 });
    expect(risk.instruments.find((i: Json) => i.symbol === 'MNQ')).toMatchObject({
      state: 'BLACKOUT',
      clearAt: '2026-09-28T14:25:00.000Z',
      blocking: [{ id: 'us-cpi' }],
    });

    // The gate agrees: the same assessment rejects a candidate.
    const d = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/decisions/evaluate',
        headers: H.automation,
        payload: { candidate: candidate(h) },
      }),
    );
    expect(d.decision.status).toBe('REJECTED');
    expect(
      d.decision.checks.find((c: Json) => c.checkId === 'calendar.event-blackout'),
    ).toMatchObject({ verdict: 'FAIL' });

    // The provider moves the release: a change event, and the instrument is clear until 14:45.
    const moved = json(await push(h, [cpi('2026-09-28T15:00:00.000Z')]));
    expect(moved).toEqual({ accepted: 1, changes: [{ type: 'RESCHEDULED', eventId: 'us-cpi' }] });
    risk = await get(h, '/api/v1/calendar/risk');
    expect(risk.instruments.find((i: Json) => i.symbol === 'MNQ')).toMatchObject({
      state: 'CLEAR',
      next: { event: { id: 'us-cpi' }, blackoutFrom: '2026-09-28T14:45:00.000Z' },
    });
    const events = (await get(h, '/api/v1/events?limit=100')).events as Json[];
    expect(events.find((e) => e.type === 'CALENDAR_RESCHEDULED')).toMatchObject({
      level: 'WARN',
      component: 'calendar',
    });

    // Invalid data is refused and the previous window kept.
    const dup = await push(h, [cpi('2026-09-28T15:00:00.000Z'), cpi('2026-09-28T16:00:00.000Z')]);
    expect(dup.statusCode).toBe(400);
    expect(json(dup).error.message).toMatch(/repeats event id us-cpi/);

    // No update for over an hour (calendarMaxAgeMs): UNKNOWN, CALENDAR degraded, no trades.
    h.clock.advance(3_600_001);
    risk = await get(h, '/api/v1/calendar/risk');
    expect(risk.calendar.status).toBe('STALE');
    expect(risk.instruments.every((i: Json) => i.state === 'UNKNOWN')).toBe(true);
    await h.runtime.cycle();
    const status = await get(h, '/api/v1/system/status');
    expect(status.calendar.status).toBe('DEGRADED');
    expect(status.trading.enabled).toBe(false);
  });

  it('polls the SIMULATED schedule in simulation mode', async () => {
    h = await createHarness({ simulation: true });
    const risk = await get(h, '/api/v1/calendar/risk');
    expect(risk.calendar).toMatchObject({
      status: 'OK',
      source: 'simulation',
      sourceKind: 'SIMULATED',
    });
    expect(risk.poller).toMatchObject({
      adapter: 'simulation',
      kind: 'SIMULATED',
      consecutiveFailures: 0,
    });
    // Monday 10:00 New York: the 10:00 MEDIUM release is not restricted; next HIGH is Tue 08:30.
    expect(risk.instruments.find((i: Json) => i.symbol === 'NQ')).toMatchObject({
      state: 'CLEAR',
      next: {
        event: { id: 'sim-us-high-2026-09-29', title: 'SIMULATED — US high-impact release' },
        blackoutFrom: '2026-09-29T12:15:00.000Z',
      },
    });
    const upcoming = await get(h, '/api/v1/calendar/upcoming?hours=48');
    expect(upcoming.value.events.every((e: Json) => e.title.startsWith('SIMULATED'))).toBe(true);
  });

  it('requires authentication', async () => {
    h = await createHarness();
    expect((await h.app.inject({ url: '/api/v1/calendar/risk' })).statusCode).toBe(401);
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/v1/calendar/window',
      headers: H.viewer,
      payload: {},
    });
    expect(r.statusCode).toBe(403);
  });
});
