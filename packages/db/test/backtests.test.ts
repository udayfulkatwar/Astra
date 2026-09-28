import { runBacktest, simulateM1Bars } from '@astra/backtest';
import { decisionConfigView, loadAstraConfig } from '@astra/config';
import { DEFAULT_MONITOR_POLICY, DEFAULT_PROTECTION_POLICY } from '@astra/risk';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BacktestRepository } from '../src/repositories/backtests';
import { createTestDb, dbAvailable, type TestDb } from './helpers';

const available = await dbAvailable();

describe.skipIf(!available)('backtest runs repository', () => {
  let db: TestDb;
  let repo: BacktestRepository;
  beforeAll(async () => {
    db = await createTestDb();
    repo = new BacktestRepository(db.sql);
  });
  afterAll(async () => {
    await db.cleanup();
  });

  it('stores a run exactly and lists summaries newest first; runs are immutable', async () => {
    const config = loadAstraConfig(resolve(import.meta.dirname, '../../../config'));
    const bars = simulateM1Bars({
      symbol: 'MNQ',
      tickSize: 0.25,
      startPrice: 18_000,
      from: '2026-03-02T00:00:00Z',
      to: '2026-03-04T00:00:00Z',
      hours: config.instruments.get('MNQ')!.tradingHours!,
      seed: 7,
    });
    const result = await runBacktest({
      config: {
        symbol: 'MNQ',
        accountId: 'paper-demo',
        calendar: 'NOT_MODELLED',
        news: 'NOT_MODELLED',
      },
      bars,
      env: {
        config: decisionConfigView(config),
        monitorPolicy: DEFAULT_MONITOR_POLICY,
        protectionPolicy: DEFAULT_PROTECTION_POLICY,
        lateObservationThresholdMs: 300_000,
      },
    });
    const request = { data: { kind: 'SIMULATED', seed: 7 } };
    await repo.record({
      runId: 'bt-1',
      createdAt: '2026-09-27T10:00:00.000Z',
      createdBy: 'operator',
      dataKind: 'SIMULATED',
      request,
      result,
    });
    await repo.record({
      runId: 'bt-2',
      createdAt: '2026-09-27T11:00:00.000Z',
      createdBy: 'operator',
      dataKind: 'SIMULATED',
      request,
      result,
    });

    const run = await repo.get('bt-1');
    expect(run?.result).toEqual(result);
    expect(run?.request).toEqual(request);
    expect(run).toMatchObject({
      accountId: 'paper-demo',
      symbol: 'MNQ',
      strategyId: 'structure-breakout-template',
      from: result.data.from,
      to: result.data.to,
      summary: { trades: result.trades.length, label: result.label },
    });
    expect(await repo.get('missing')).toBeNull();
    expect((await repo.list()).map((r) => r.runId)).toEqual(['bt-2', 'bt-1']);
    await expect(db.sql`update backtest_runs set symbol = 'NQ'`).rejects.toThrow();
    await expect(db.sql`delete from backtest_runs`).rejects.toThrow();
  });
});
