import { resolve } from 'node:path';
import { loadAstraConfig } from '@astra/config';
import { ManualClock } from '@astra/core';
import { createDb } from '@astra/db';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { AstraRuntime } from '../src/runtime/runtime';
import { H, TOKENS } from './harness';

describe('API — database unavailable at startup', () => {
  it('starts fail-closed: not ready, trading disabled, every decision rejected', async () => {
    const config = loadAstraConfig(resolve(__dirname, '../../../config'));
    const sql = createDb({ url: 'postgres://nobody:nothing@127.0.0.1:1/none', maxConnections: 1 });
    const log = pino({ level: 'silent' });
    const runtime = new AstraRuntime({
      config,
      sql,
      clock: new ManualClock('2026-09-28T14:00:00Z'),
      log,
      runMigrations: true,
      liveTradingAuthorized: false,
      simulation: false,
      startLoops: false,
      initRetryMs: 60_000,
    });
    await runtime.start();
    const app = await buildApp({ runtime, logger: log, tokens: TOKENS, corsOrigins: [] });
    try {
      expect(runtime.isInitialized()).toBe(false);
      expect(runtime.mode.current()).toBe('HALTED');
      const ready = await app.inject({ url: '/readyz' });
      expect(ready.statusCode).toBe(503);
      const status = JSON.parse(
        (await app.inject({ url: '/api/v1/system/status', headers: H.viewer })).body,
      ) as { trading: { enabled: boolean; reasons: string[] } };
      expect(status.trading.enabled).toBe(false);
      expect(status.trading.reasons.join()).toMatch(/not initialized/);

      const r = JSON.parse(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/decisions/evaluate',
            headers: H.automation,
            payload: {
              candidate: {
                accountId: 'paper-demo',
                signal: {
                  id: 's1',
                  strategyId: 'paper-pipeline-test',
                  symbol: 'MNQ',
                  direction: 'LONG',
                  setupState: 'QUALIFIED',
                  entry: 20000,
                  stop: 19990,
                  target: 20020,
                  detectedAt: '2026-09-28T14:00:00Z',
                },
              },
            },
          })
        ).body,
      ) as { decision: { status: string; reasons: string[] }; persisted: boolean };
      expect(r.decision.status).toBe('REJECTED');
      expect(r.persisted).toBe(false);
      expect(r.decision.reasons.join()).toMatch(/could not be persisted/);
    } finally {
      await app.close();
      await runtime.stop();
      await sql.end({ timeout: 1 });
    }
  });
});
