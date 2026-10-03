import type { CalendarWindow, ObservedOk } from '@astra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
});
