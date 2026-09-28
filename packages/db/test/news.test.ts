import { classifyNews } from '@astra/news';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NewsRepository } from '../src/repositories/news';
import { createTestDb, dbAvailable, type TestDb } from './helpers';

const available = await dbAvailable();

const news = (id: string, publishedAt: string, headline = `US CPI rises ${id}`) =>
  classifyNews({
    item: { id, headline, publishedAt },
    source: 'wire',
    sourceKind: 'LIVE',
    receivedAt: publishedAt,
    instruments: new Map([['NQ', { eventCurrencies: ['USD'] }]]),
  });

describe.skipIf(!available)('news repository', () => {
  let db: TestDb;
  let repo: NewsRepository;
  beforeAll(async () => {
    db = await createTestDb();
    repo = new NewsRepository(db.sql);
  });
  afterAll(async () => {
    await db.cleanup();
  });

  it('stores classified items once and returns recent ones exactly, oldest first', async () => {
    const a = news('a', '2026-09-28T12:00:00.000Z');
    const b = news('b', '2026-09-28T13:00:00.000Z');
    const c = news('c', '2026-09-27T09:00:00.000Z');
    expect(await repo.record([a, b, c])).toBe(3);
    expect(await repo.record([a])).toBe(0);
    expect(await repo.since('2026-09-28T00:00:00.000Z')).toEqual([a, b]);
    expect(await repo.since('2026-09-01T00:00:00.000Z', 2)).toEqual([a, b]); // newest kept
    const [row] = await db.sql<{ affected: string[]; impact: string }[]>`
      select affected, impact from news_items where item_key = 'wire:a'`;
    expect(row).toEqual({ affected: ['NQ'], impact: 'MEDIUM' });
  });
});
