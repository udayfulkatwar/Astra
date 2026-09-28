import { resolve } from 'node:path';
import type { AiProvider } from '@astra/ai';
import { loadAstraConfig } from '@astra/config';
import { ManualClock } from '@astra/core';
import { createDb, type Sql } from '@astra/db';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { buildApp } from '../src/app';
import { AstraRuntime } from '../src/runtime/runtime';
import { createTestDb, type TestDb } from '../../../packages/db/test/helpers';

export { dbAvailable } from '../../../packages/db/test/helpers';

export const TOKENS = {
  operator: 'op'.repeat(20),
  automation: 'au'.repeat(20),
  viewer: 'vi'.repeat(20),
};
export const H = {
  operator: { authorization: `Bearer ${TOKENS.operator}` },
  automation: { authorization: `Bearer ${TOKENS.automation}` },
  viewer: { authorization: `Bearer ${TOKENS.viewer}` },
};

export const CONFIG = loadAstraConfig(resolve(__dirname, '../../../config'));
export const START = '2026-09-28T14:00:00.000Z'; // Monday 10:00 New York

export interface Harness {
  app: FastifyInstance;
  runtime: AstraRuntime;
  clock: ManualClock;
  db: TestDb;
  restart(): Promise<Harness>;
  close(): Promise<void>;
}

async function boot(
  sql: Sql,
  clock: ManualClock,
  opts: HarnessOptions,
): Promise<Omit<Harness, 'restart' | 'close' | 'db'>> {
  const log = pino({ level: 'silent' });
  const runtime = new AstraRuntime({
    config: CONFIG,
    sql,
    clock,
    log,
    runMigrations: true,
    liveTradingAuthorized: opts.liveTradingAuthorized ?? false,
    simulation: opts.simulation ?? false,
    startLoops: false,
    aiProviders: opts.aiProviders,
  });
  await runtime.start();
  const app = await buildApp({
    runtime,
    logger: log,
    tokens: TOKENS,
    corsOrigins: ['http://localhost:5173'],
    rateLimitPerMinute: 10_000,
  });
  await app.ready();
  return { app, runtime, clock };
}

export interface HarnessOptions {
  liveTradingAuthorized?: boolean;
  /** Start the SIMULATED market-data adapter (paper testing feed). */
  simulation?: boolean;
  /** AI providers as the entry point would build them from environment keys (default: none). */
  aiProviders?: ReadonlyMap<string, AiProvider>;
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const db = await createTestDb();
  const clock = new ManualClock(START);
  const make = async (sql: Sql): Promise<Harness> => {
    const h = await boot(sql, clock, opts);
    return {
      ...h,
      db,
      async restart() {
        await h.app.close();
        await h.runtime.stop();
        const sql2 = createDb({
          url:
            process.env.TEST_DATABASE_URL ??
            'postgres://astra:astra_dev_only@localhost:5432/astra_test',
          schema: db.schema,
          maxConnections: 5,
        });
        return make(sql2);
      },
      async close() {
        await h.app.close();
        await h.runtime.stop();
        if (sql !== db.sql) await sql.end({ timeout: 5 });
        await db.cleanup();
      },
    };
  };
  return make(db.sql);
}

/**
 * Brings every required input online: heartbeat, quotes for every instrument the paper-demo
 * account trades (MARKET_DATA is ONLINE only when all are fresh), calendar, one safety cycle.
 */
export async function bringOnline(
  h: Harness,
  prices: { bid: number; ask: number } = { bid: 20_000, ask: 20_000.25 },
) {
  const at = h.clock.now().toISOString();
  await h.app.inject({
    method: 'POST',
    url: '/api/v1/automation/heartbeat',
    headers: H.automation,
    payload: { detail: 'n8n ok' },
  });
  await h.app.inject({
    method: 'POST',
    url: '/api/v1/market/quotes',
    headers: H.automation,
    payload: {
      source: 'test',
      quotes: [
        { symbol: 'MNQ', ...prices, asOf: at },
        { symbol: 'NQ', ...prices, asOf: at },
        { symbol: 'XAUUSD', bid: 2_600, ask: 2_600.2, asOf: at },
      ],
    },
  });
  await h.app.inject({
    method: 'POST',
    url: '/api/v1/calendar/window',
    headers: H.automation,
    payload: {
      source: 'test',
      window: {
        from: new Date(h.clock.now().getTime() - 3_600_000).toISOString(),
        to: new Date(h.clock.now().getTime() + 86_400_000).toISOString(),
        events: [],
      },
    },
  });
  // An empty news batch: the feed is alive and nothing high-impact has been reported.
  await h.app.inject({
    method: 'POST',
    url: '/api/v1/news/items',
    headers: H.automation,
    payload: { source: 'test', items: [] },
  });
  await h.runtime.cycle();
}

let signalSeq = 0;
export function candidate(h: Harness, overrides: Record<string, unknown> = {}) {
  const entry = 20_000.25;
  return {
    accountId: 'paper-demo',
    signal: {
      id: `sig-${++signalSeq}-${Date.now()}`,
      strategyId: 'paper-pipeline-test',
      symbol: 'MNQ',
      direction: 'LONG',
      setupState: 'QUALIFIED',
      entryType: 'MARKET',
      entry,
      stop: entry - 10,
      target: entry + 20,
      detectedAt: h.clock.now().toISOString(),
      rationale: ['integration test signal'],
      ...overrides,
    },
  };
}
