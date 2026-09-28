/**
 * ASTRA Core entry point. Invalid environment or configuration stops the process before it can
 * accept requests; a database outage does NOT — the service starts fail-closed and retries.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AiProvider } from '@astra/ai';
import { AnthropicProvider } from '@astra/ai/anthropic';
import { loadAstraConfig, type AstraConfig } from '@astra/config';
import { systemClock } from '@astra/core';
import { createDb } from '@astra/db';
import { buildApp } from './app';
import { loadEnv } from './env';
import { createLogger } from './logger';
import { AstraRuntime } from './runtime/runtime';

/** Nearest directory named `config` containing astra.yaml, searching upward from `start`. */
function findConfigDir(start: string): string {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'config', 'astra.yaml'))) return join(dir, 'config');
    if (dirname(dir) === dir) throw new Error('config/astra.yaml not found; set ASTRA_CONFIG_DIR');
  }
}

/**
 * AI providers whose key is present in the environment variable NAMED in config. The key goes
 * straight to the SDK client; it is never logged, stored or sent anywhere else.
 */
function aiProviders(config: AstraConfig, log: ReturnType<typeof createLogger>) {
  const providers = new Map<string, AiProvider>();
  const anthropic = config.system.ai?.providers.anthropic;
  if (anthropic) {
    const key = process.env[anthropic.apiKeyEnv];
    if (key) {
      providers.set(
        'anthropic',
        new AnthropicProvider({
          apiKey: key,
          maxRetries: anthropic.maxRetries,
          serverSideFallbacks: anthropic.serverSideFallbacks,
        }),
      );
    } else {
      log.warn(
        { envVar: anthropic.apiKeyEnv },
        'AI provider anthropic: API key env var not set — AI analysis unavailable',
      );
    }
  }
  return providers;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger(env.ASTRA_LOG_LEVEL);
  const configDir = env.ASTRA_CONFIG_DIR
    ? resolve(env.ASTRA_CONFIG_DIR)
    : findConfigDir(process.cwd());
  const config = loadAstraConfig(configDir);
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
    aiProviders: aiProviders(config, log),
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
