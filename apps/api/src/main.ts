/**
 * ASTRA Core entry point. Invalid environment or configuration stops the process before it can
 * accept requests; a database outage does NOT — the service starts fail-closed and retries.
 */
import { resolve } from 'node:path';
import { loadAstraConfig } from '@astra/config';
import { systemClock } from '@astra/core';
import { createDb } from '@astra/db';
import { buildApp } from './app';
import { loadEnv } from './env';
import { createLogger } from './logger';
import { AstraRuntime } from './runtime/runtime';

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger(env.ASTRA_LOG_LEVEL);
  const config = loadAstraConfig(resolve(env.ASTRA_CONFIG_DIR));
  log.info(
    {
      configHash: config.hash,
      live: env.ASTRA_LIVE_TRADING_AUTHORIZED,
      simulation: env.ASTRA_SIMULATION,
    },
    'configuration loaded',
  );
  if (env.ASTRA_LIVE_TRADING_AUTHORIZED) {
    log.warn(
      'ASTRA_LIVE_TRADING_AUTHORIZED=true: live execution is possible when every other live factor is satisfied',
    );
  }

  const sql = createDb({ url: env.DATABASE_URL, applicationName: 'astra-api' });
  const runtime = new AstraRuntime({
    config,
    sql,
    clock: systemClock,
    log,
    runMigrations: env.ASTRA_RUN_MIGRATIONS,
    migrationsDir: env.ASTRA_MIGRATIONS_DIR ? resolve(env.ASTRA_MIGRATIONS_DIR) : undefined,
    liveTradingAuthorized: env.ASTRA_LIVE_TRADING_AUTHORIZED,
    simulation: env.ASTRA_SIMULATION,
    startLoops: true,
  });
  const app = await buildApp({
    runtime,
    logger: log,
    tokens: {
      operator: env.ASTRA_OPERATOR_TOKEN,
      automation: env.ASTRA_AUTOMATION_TOKEN,
      viewer: env.ASTRA_VIEWER_TOKEN,
    },
    corsOrigins: env.ASTRA_CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  });

  await app.listen({ host: env.ASTRA_HTTP_HOST, port: env.ASTRA_HTTP_PORT });
  await runtime.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await runtime.stop();
      await sql.end({ timeout: 5 });
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console -- logger may not exist yet (invalid env/config)
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
