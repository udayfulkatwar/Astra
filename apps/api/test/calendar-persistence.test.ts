import { afterEach, describe, expect, it } from 'vitest';
import { jsonb } from '@astra/db';
import { FX_QUOTES, H, candidate, createHarness, dbAvailable, type Harness } from './harness';

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

async function pushWindow(harness: Harness, from: string, to: string, eventAt: string) {
  const r = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/calendar/window',
    headers: H.automation,
    payload: {
      source: 'n8n',
      window: {
        from,
        to,
        events: [
          {
            id: 'persisted-cpi',
            title: 'US CPI',
            currency: 'USD',
            impact: 'HIGH',
            scheduledAt: eventAt,
          },
        ],
      },
    },
  });
  expect(r.statusCode).toBe(200);
}

/**
 * Brings every gate input online EXCEPT the economic calendar, so the restored calendar is the
 * only thing that can reject a candidate. (The shared `bringOnline` helper pushes a fresh empty
 * calendar window, which would overwrite whatever restore loaded.)
 */
async function bringOnlineExceptCalendar(harness: Harness) {
  const at = harness.clock.now().toISOString();
  await harness.app.inject({
    method: 'POST',
    url: '/api/v1/automation/heartbeat',
    headers: H.automation,
    payload: { detail: 'n8n ok' },
  });
  await harness.app.inject({
    method: 'POST',
    url: '/api/v1/market/quotes',
    headers: H.automation,
    payload: {
      source: 'test',
      quotes: [
        { symbol: 'MNQ', bid: 20_000, ask: 20_000.25, asOf: at },
        { symbol: 'NQ', bid: 20_000, ask: 20_000.25, asOf: at },
        { symbol: 'XAUUSD', bid: 2_600, ask: 2_600.2, asOf: at },
        ...FX_QUOTES.map((q) => ({ ...q, asOf: at })),
      ],
    },
  });
  await harness.app.inject({
    method: 'POST',
    url: '/api/v1/news/items',
    headers: H.automation,
    payload: { source: 'test', items: [] },
  });
  await harness.runtime.cycle();
}

const evaluate = async (harness: Harness) =>
  json(
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/decisions/evaluate',
      headers: H.automation,
      payload: { candidate: candidate(harness) },
    }),
  );
const checkOf = (decision: Json, id: string): Json =>
  decision.checks.find((c: Json) => c.checkId === id);

describe.skipIf(!available)('API — calendar persistence', () => {
  it('restores a recent accepted window after restart with the original observation timestamp', async () => {
    h = await createHarness();
    await pushWindow(
      h,
      '2026-09-28T00:00:00.000Z',
      '2026-10-05T14:00:00.000Z',
      '2026-09-28T15:00:00.000Z',
    );
    const before = await get(h, '/api/v1/calendar/risk');
    expect(before.calendar).toMatchObject({
      status: 'OK',
      source: 'ingest:n8n',
      sourceKind: 'MANUAL',
      asOf: '2026-09-28T14:00:00.000Z',
    });

    h = await h.restart();

    const after = await get(h, '/api/v1/calendar/risk');
    expect(after.calendar).toMatchObject({
      status: 'OK',
      source: 'ingest:n8n',
      sourceKind: 'MANUAL',
      asOf: '2026-09-28T14:00:00.000Z',
    });
    expect(after.instruments.find((i: Json) => i.symbol === 'NQ')).toMatchObject({
      state: 'CLEAR',
      next: { event: { id: 'persisted-cpi' } },
    });
  });

  it('does not refresh stale persisted data during restart', async () => {
    h = await createHarness();
    await pushWindow(
      h,
      '2026-09-28T00:00:00.000Z',
      '2026-10-05T14:00:00.000Z',
      '2026-09-28T16:00:00.000Z',
    );
    h.clock.advance(3_600_001);

    h = await h.restart();

    // The restored underlying observation keeps its original source and asOf (restart is not a
    // refresh); this view is deliberately not freshness-checked.
    expect(h.runtime.calendar.current()).toMatchObject({
      status: 'OK',
      source: 'ingest:n8n',
      asOf: '2026-09-28T14:00:00.000Z',
    });
    // Freshness is evaluated against that original asOf, so it is already STALE (and keeps them).
    expect(h.runtime.calendar.fresh()).toMatchObject({
      status: 'STALE',
      source: 'ingest:n8n',
      asOf: '2026-09-28T14:00:00.000Z',
    });
    // The API risk view reports non-OK calendars by status + reason only (no source/asOf).
    const risk = await get(h, '/api/v1/calendar/risk');
    expect(risk.calendar.status).toBe('STALE');
    expect(risk.instruments.every((i: Json) => i.state === 'UNKNOWN')).toBe(true);
    await h.runtime.cycle();
    const status = await get(h, '/api/v1/system/status');
    expect(status.calendar.status).toBe('DEGRADED');
    expect(status.trading.enabled).toBe(false);
  });

  it('survives a malformed stored window: startup succeeds and the calendar stays UNAVAILABLE', async () => {
    h = await createHarness();
    await h.db.sql`
      insert into calendar_windows (source, source_kind, as_of, from_at, to_at, window_payload)
      values ('ingest:n8n', 'MANUAL', '2026-09-28T14:00:00.000Z', '2026-09-28T00:00:00.000Z',
        '2026-10-05T00:00:00.000Z', ${jsonb(h.db.sql, { from: 'bad', events: [{ id: 1 }] })})`;

    h = await h.restart();

    const risk = await get(h, '/api/v1/calendar/risk');
    expect(risk.calendar.status).toBe('UNAVAILABLE');
    expect(risk.instruments.every((i: Json) => i.state === 'UNKNOWN')).toBe(true);
    await h.runtime.cycle();
    const status = await get(h, '/api/v1/system/status');
    expect(status.trading.enabled).toBe(false);
  });

  it('does not restore events outside the horizon from an overlapping window', async () => {
    h = await createHarness();
    await pushWindow(
      h,
      '2026-09-01T00:00:00.000Z',
      '2026-12-31T00:00:00.000Z',
      '2026-12-30T12:00:00.000Z',
    );

    h = await h.restart();

    const risk = await get(h, '/api/v1/calendar/risk');
    expect(risk.instruments.every((i: Json) => !i.next)).toBe(true);
  });

  it('does not restore a stored window outside the configured lookback/lookahead horizon', async () => {
    h = await createHarness();
    await pushWindow(
      h,
      '2026-10-20T00:00:00.000Z',
      '2026-10-21T00:00:00.000Z',
      '2026-10-20T12:00:00.000Z',
    );

    h = await h.restart();

    const risk = await get(h, '/api/v1/calendar/risk');
    expect(risk.calendar.status).toBe('UNAVAILABLE');
    expect(risk.instruments.every((i: Json) => i.state === 'UNKNOWN')).toBe(true);
  });

  // The real acceptance proof: a candidate reaching the ACTUAL decision gate is rejected when the
  // restored calendar is STALE or UNAVAILABLE, and an active blackout survives restart — with every
  // other gate input valid, so the calendar is demonstrably the cause (not a missing quote etc.).

  it('gate: rejects a candidate when the restored calendar is STALE after restart', async () => {
    h = await createHarness();
    // Event far from `now`: no blackout — so a PASS would be possible if the calendar were fresh.
    await pushWindow(
      h,
      '2026-09-28T00:00:00.000Z',
      '2026-10-05T14:00:00.000Z',
      '2026-10-01T12:00:00.000Z',
    );
    h.clock.advance(3_600_001); // past calendarMaxAgeMs

    h = await h.restart();

    // Restored, but stale against the preserved asOf — restart did not refresh it.
    expect(h.runtime.calendar.current().status).toBe('OK');
    expect(h.runtime.calendar.fresh().status).toBe('STALE');

    await bringOnlineExceptCalendar(h);
    const d = (await evaluate(h)).decision;
    expect(d.status).toBe('REJECTED');
    // The calendar check cannot pass on stale data (NO TRADE by default).
    expect(checkOf(d, 'calendar.event-blackout').verdict).not.toBe('PASS');
    // Quotes are fresh, so the rejection is attributable to the calendar, not missing market data.
    expect(checkOf(d, 'data.quote').verdict).toBe('PASS');
  });

  it('gate: rejects a candidate when the restored calendar is UNAVAILABLE after restart', async () => {
    h = await createHarness();
    // Stored window sits entirely outside the restore horizon → nothing is restored.
    await pushWindow(
      h,
      '2026-10-20T00:00:00.000Z',
      '2026-10-21T00:00:00.000Z',
      '2026-10-20T12:00:00.000Z',
    );

    h = await h.restart();
    expect(h.runtime.calendar.current().status).toBe('UNAVAILABLE');

    await bringOnlineExceptCalendar(h);
    const d = (await evaluate(h)).decision;
    expect(d.status).toBe('REJECTED');
    expect(checkOf(d, 'calendar.event-blackout').verdict).not.toBe('PASS');
    expect(checkOf(d, 'data.quote').verdict).toBe('PASS');
  });

  it('gate: a restored recent window keeps its asOf and still enforces an active event blackout', async () => {
    h = await createHarness();
    // A HIGH USD event 10 minutes ahead of START (Mon 14:00 UTC): inside the ±15 min blackout.
    await pushWindow(
      h,
      '2026-09-28T13:00:00.000Z',
      '2026-09-30T00:00:00.000Z',
      '2026-09-28T14:10:00.000Z',
    );
    const before = (await evaluate(h)).decision;
    expect(before.status).toBe('REJECTED');
    expect(checkOf(before, 'calendar.event-blackout').verdict).toBe('FAIL');

    // Restart WITHOUT advancing the clock: the window is still fresh and the blackout still active.
    h = await h.restart();

    // The restored observation keeps its original asOf (restart is not a new observation).
    const current = h.runtime.calendar.current();
    expect(current).toMatchObject({
      status: 'OK',
      source: 'ingest:n8n',
      asOf: '2026-09-28T14:00:00.000Z',
    });
    expect(h.runtime.calendar.fresh().status).toBe('OK');

    await bringOnlineExceptCalendar(h);
    const d = (await evaluate(h)).decision;
    expect(d.status).toBe('REJECTED');
    const calendarCheck = checkOf(d, 'calendar.event-blackout');
    expect(calendarCheck.verdict).toBe('FAIL');
    // The blackout is enforced by the specific restored event, not a generic unavailability.
    expect(calendarCheck.details.events).toContain('persisted-cpi');
    // Every other gate input is valid, so the blackout is the decisive rejection.
    expect(checkOf(d, 'data.quote').verdict).toBe('PASS');
  });
});
