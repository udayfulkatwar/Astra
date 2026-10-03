import { afterEach, describe, expect, it } from 'vitest';
import { jsonb } from '@astra/db';
import { H, createHarness, dbAvailable, type Harness } from './harness';

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
});
