import type { CalendarWindow, ObservedOk } from '@astra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jsonb } from '../src/client';
import { CalendarRepository } from '../src/repositories/calendar';
import { createTestDb, dbAvailable, type TestDb } from './helpers';

const available = await dbAvailable();

const saved = (
  source: string,
  asOf: string,
  from: string,
  to: string,
  id: string,
): ObservedOk<CalendarWindow> => ({
  status: 'OK',
  source,
  sourceKind: 'MANUAL',
  asOf,
  value: {
    from,
    to,
    events: [
      {
        id,
        title: `event ${id}`,
        impact: 'HIGH',
        scheduledAt: '2026-09-28T15:00:00.000Z',
        affectedInstruments: ['NQ'],
      },
    ],
  },
});

describe.skipIf(!available)('calendar repository', () => {
  let db: TestDb;
  let repo: CalendarRepository;
  beforeAll(async () => {
    db = await createTestDb();
    repo = new CalendarRepository(db.sql);
  });
  afterAll(async () => {
    await db.cleanup();
  });

  it('records accepted windows and restores the newest overlapping observation exactly', async () => {
    const old = saved(
      'ingest:old',
      '2026-09-28T12:00:00.000Z',
      '2026-09-27T00:00:00.000Z',
      '2026-09-29T00:00:00.000Z',
      'old',
    );
    const latest = saved(
      'ingest:new',
      '2026-09-28T13:00:00.000Z',
      '2026-09-28T00:00:00.000Z',
      '2026-10-05T00:00:00.000Z',
      'new',
    );
    await repo.record(old);
    await repo.record(latest);

    expect(
      await repo.latestOverlapping('2026-09-28T14:00:00.000Z', '2026-10-01T00:00:00.000Z'),
    ).toEqual(latest);
  });

  it('ignores windows whose asserted coverage does not overlap the requested horizon', async () => {
    expect(
      await repo.latestOverlapping('2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
    ).toBeNull();
  });

  it('skips malformed rows, falls back to the next valid one and reports them', async () => {
    const good = saved(
      'ingest:good',
      '2026-09-28T10:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
      '2026-11-08T00:00:00.000Z',
      'good',
    );
    await repo.record(good);
    await db.sql`
      insert into calendar_windows (source, source_kind, as_of, from_at, to_at, window_payload)
      values ('ingest:bad', 'MANUAL', '2026-09-28T11:00:00.000Z', '2026-11-01T00:00:00.000Z',
        '2026-11-08T00:00:00.000Z', ${jsonb(db.sql, { from: 'nope', events: 'x' })})`;
    const invalid: string[] = [];
    expect(
      await repo.latestOverlapping('2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z', (r) =>
        invalid.push(r),
      ),
    ).toEqual(good);
    expect(invalid).toHaveLength(1);
  });

  it('skips a newer row with duplicate event ids and falls back to an older valid one', async () => {
    const good = saved(
      'ingest:valid',
      '2027-03-01T10:00:00.000Z',
      '2027-03-01T00:00:00.000Z',
      '2027-03-08T00:00:00.000Z',
      'march-cpi',
    );
    await repo.record(good);
    // A newer observation that passes the shape schema but repeats an event id. The shape schema
    // does not enforce id uniqueness, but CalendarService.restore rejects it — so if the repo
    // returned it, restore would throw and no older valid window would be restored.
    const dupEvent = {
      id: 'dup',
      title: 'event dup',
      impact: 'HIGH',
      scheduledAt: '2027-03-02T15:00:00.000Z',
      affectedInstruments: ['NQ'],
    };
    await db.sql`
      insert into calendar_windows (source, source_kind, as_of, from_at, to_at, window_payload)
      values ('ingest:dup', 'MANUAL', '2027-03-01T11:00:00.000Z', '2027-03-01T00:00:00.000Z',
        '2027-03-08T00:00:00.000Z', ${jsonb(db.sql, {
          from: '2027-03-01T00:00:00.000Z',
          to: '2027-03-08T00:00:00.000Z',
          events: [dupEvent, dupEvent],
        })})`;
    const invalid: string[] = [];
    expect(
      await repo.latestOverlapping('2027-03-02T00:00:00.000Z', '2027-03-03T00:00:00.000Z', (r) =>
        invalid.push(r),
      ),
    ).toEqual(good);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatch(/repeats event id dup/);
  });

  it('returns null when every overlapping row is malformed', async () => {
    await db.sql`
      insert into calendar_windows (source, source_kind, as_of, from_at, to_at, window_payload)
      values ('ingest:bad', 'MANUAL', '2026-09-28T11:00:00.000Z', '2027-01-01T00:00:00.000Z',
        '2027-01-08T00:00:00.000Z', ${jsonb(db.sql, { garbage: true })})`;
    expect(
      await repo.latestOverlapping('2027-01-02T00:00:00.000Z', '2027-01-03T00:00:00.000Z'),
    ).toBeNull();
  });
});
