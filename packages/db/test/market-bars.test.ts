import type { Bar } from '@astra/market-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MarketBarRepository } from '../src/repositories/market-bars';
import { createTestDb, dbAvailable, type TestDb } from './helpers';

const available = await dbAvailable();

const START = Date.parse('2026-09-28T14:00:00Z');
function minute(i: number, extra: Partial<Bar> = {}): Bar {
  const open = 20_000 + i * 0.25;
  return {
    symbol: 'NQ',
    timeframe: 'M1',
    openTime: new Date(START + i * 60_000).toISOString(),
    closeTime: new Date(START + (i + 1) * 60_000).toISOString(),
    open,
    high: open + 1.125,
    low: open - 0.5,
    close: open + 0.125,
    volume: null,
    tickCount: 10 + i,
    complete: true,
    source: 'feed',
    sourceKind: 'LIVE',
    ...extra,
  };
}

describe.skipIf(!available)('market bars repository', () => {
  let db: TestDb;
  let repo: MarketBarRepository;
  beforeAll(async () => {
    db = await createTestDb();
    repo = new MarketBarRepository(db.sql);
  });
  afterAll(async () => {
    await db.cleanup();
  });

  it('round-trips completed bars exactly, oldest → newest, with null volume kept null', async () => {
    const bars = [minute(0), minute(1), minute(2, { volume: 1_234.5 })];
    await repo.upsert([bars[2]!, bars[0]!, bars[1]!]);
    expect(await repo.recent('NQ', 'M1', 10)).toEqual(bars);
    expect(await repo.recent('NQ', 'H1', 10)).toEqual([]);
    expect(await repo.recent('MNQ', 'M1', 10)).toEqual([]);
  });

  it('returns only the newest `limit` bars', async () => {
    const recent = await repo.recent('NQ', 'M1', 2);
    expect(recent.map((b) => b.openTime)).toEqual([minute(1).openTime, minute(2).openTime]);
  });

  it('upserts: the same key is replaced, never duplicated (also within one call)', async () => {
    const replaced = minute(1, { high: 20_010, close: 20_009, tickCount: 99 });
    await repo.upsert([minute(1, { high: 20_005 }), replaced]);
    const rows = await repo.recent('NQ', 'M1', 10);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual(replaced);
  });

  it('keeps one series per source', async () => {
    await repo.upsert([minute(0, { source: 'simulation', sourceKind: 'SIMULATED' })]);
    const rows = await repo.recent('NQ', 'M1', 10);
    expect(rows.filter((b) => b.openTime === minute(0).openTime).map((b) => b.source)).toEqual([
      'feed',
      'simulation',
    ]);
  });

  it('stores large sets in batches', async () => {
    const many = Array.from({ length: 1_200 }, (_, i) =>
      minute(i, { symbol: 'MNQ', timeframe: 'M5' }),
    );
    // M5 bars need 5-minute periods; the repository stores what it is given (alignment is the
    // aggregator's job), so only ordering and completeness matter here.
    await repo.upsert(many);
    const rows = await repo.recent('MNQ', 'M5', 1_000);
    expect(rows).toHaveLength(1_000);
    expect(rows[0]!.openTime).toBe(many[200]!.openTime);
    expect(rows.at(-1)!.openTime).toBe(many[1_199]!.openTime);
  });

  it('refuses in-progress bars and bars the schema constraints reject', async () => {
    await expect(repo.upsert([minute(50, { complete: false })])).rejects.toThrow(/in-progress/);
    await expect(repo.upsert([minute(51, { high: 1, low: 2 })])).rejects.toThrow();
    await expect(repo.upsert([minute(52, { sourceKind: 'GUESSED' as 'LIVE' })])).rejects.toThrow();
    expect((await repo.recent('NQ', 'M1', 100)).map((b) => b.openTime)).not.toContain(
      minute(50).openTime,
    );
  });
  it('returns bars within a time range, optionally from one source', async () => {
    await repo.upsert([
      minute(3),
      minute(4),
      minute(4, { source: 'other', sourceKind: 'HISTORICAL' }),
    ]);
    const range = await repo.range({
      symbol: 'NQ',
      timeframe: 'M1',
      from: minute(1).openTime,
      to: minute(4).closeTime,
      limit: 100,
    });
    expect(range.map((b) => `${b.openTime.slice(11, 16)} ${b.source}`)).toEqual([
      '14:01 feed',
      '14:02 feed',
      '14:03 feed',
      '14:04 feed',
      '14:04 other',
    ]);
    const one = await repo.range({
      symbol: 'NQ',
      timeframe: 'M1',
      from: minute(1).openTime,
      to: minute(4).openTime, // the 14:04 bar ends after `to`: excluded
      limit: 2,
      source: 'feed',
    });
    expect(one.map((b) => b.openTime)).toEqual([minute(1).openTime, minute(2).openTime]);
  });
});
