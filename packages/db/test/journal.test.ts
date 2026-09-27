import type { JournalEntry } from '@astra/journal';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JournalRepository } from '../src/repositories/journal';
import { createTestDb, dbAvailable, type TestDb } from './helpers';

const available = await dbAvailable();

const entry = (
  id: string,
  o: { account?: string; strategy?: string | null; closedAt: string },
): JournalEntry => ({
  tradeId: id,
  accountId: o.account ?? 'acct-a',
  source: o.strategy === null ? 'EXTERNAL' : 'ASTRA',
  strategyId: o.strategy === undefined ? 'breakout' : o.strategy,
  signalId: null,
  decisionId: null,
  mode: 'PAPER',
  symbol: 'NQ',
  direction: 'LONG',
  quantity: 1,
  plan: null,
  entry: { price: 20_000, at: '2026-09-28T14:00:00.000Z', slippageTicks: 0 },
  exit: { price: 20_010, at: o.closedAt, reason: 'TARGET', slippageTicks: 0 },
  durationSec: 60,
  result: {
    grossPnl: 200,
    costs: 4,
    costsSource: 'INSTRUMENT_SPEC',
    netPnl: 196,
    initialRisk: 200,
    rMultiple: 0.98,
    outcome: 'WIN',
  },
  excursion: null,
  exitedAsPlanned: true,
});

describe.skipIf(!available)('trade journal repository', () => {
  let db: TestDb;
  let repo: JournalRepository;
  beforeAll(async () => {
    db = await createTestDb();
    repo = new JournalRepository(db.sql);
  });
  afterAll(async () => {
    await db.cleanup();
  });

  it('records each trade once, filters, and returns newest first', async () => {
    const at = '2026-09-28T16:00:00.000Z';
    expect(await repo.record(entry('t1', { closedAt: '2026-09-28T14:10:00.000Z' }), at)).toBe(true);
    expect(await repo.record(entry('t1', { closedAt: '2026-09-28T14:10:00.000Z' }), at)).toBe(
      false,
    );
    await repo.record(entry('t2', { closedAt: '2026-09-28T15:10:00.000Z', strategy: null }), at);
    await repo.record(entry('t3', { account: 'acct-b', closedAt: '2026-09-28T15:30:00.000Z' }), at);
    expect((await repo.list()).map((e) => e.tradeId)).toEqual(['t3', 't2', 't1']);
    expect((await repo.list({ accountId: 'acct-a' })).map((e) => e.tradeId)).toEqual(['t2', 't1']);
    expect((await repo.list({ strategyId: 'breakout' })).map((e) => e.tradeId)).toEqual([
      't3',
      't1',
    ]);
    expect((await repo.list({ limit: 1 }))[0]).toEqual(
      entry('t3', { account: 'acct-b', closedAt: '2026-09-28T15:30:00.000Z' }),
    );
  });

  it('is append-only', async () => {
    await expect(db.sql`update trade_journal set outcome = 'LOSS'`).rejects.toThrow(/append-only/);
    await expect(db.sql`delete from trade_journal`).rejects.toThrow(/append-only/);
  });
});
