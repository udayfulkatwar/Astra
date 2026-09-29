/**
 * Deployment environment (secrets and host settings). Never logged; never sent to clients.
 * Trading rules are NOT configured here — see config/.
 */
import { errorMessage } from '@astra/core';
import { z } from 'zod';
import { parseFeedList } from './runtime/feeds';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const token = z
  .string()
  .min(32, 'must be at least 32 characters (generate with: openssl rand -hex 32)');

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ASTRA_HTTP_HOST: z.string().default('0.0.0.0'),
  ASTRA_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Defaults to the nearest `config/` (containing astra.yaml) found walking up from the cwd. */
  ASTRA_CONFIG_DIR: z.string().min(1).optional(),
  ASTRA_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url(),
  ASTRA_RUN_MIGRATIONS: bool.default(true),
  /** Directory of SQL migrations. Required for the bundled build (dist/), optional with tsx. */
  ASTRA_MIGRATIONS_DIR: z.string().min(1).optional(),
  ASTRA_OPERATOR_TOKEN: token,
  ASTRA_AUTOMATION_TOKEN: token,
  ASTRA_VIEWER_TOKEN: token.optional(),
  ASTRA_CORS_ORIGINS: z.string().default('http://localhost:5173'),
  /** One of six factors required for live execution (ADR-0008). Default false. */
  ASTRA_LIVE_TRADING_AUTHORIZED: bool.default(false),
  /** Enables SIMULATED market/calendar feeds for paper testing (never accepted in SHADOW/LIVE). */
  ASTRA_SIMULATION: bool.default(false),
  /**
   * Free chart feeds to run, comma-separated (ADR-0026): `yahoo`. Empty → none. Prices for
   * charts only — never tradable quotes. Needs outbound internet access.
   */
  ASTRA_FEEDS: z
    .string()
    .default('')
    .transform((v, ctx) => {
      try {
        return parseFeedList(v);
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: errorMessage(err) });
        return z.NEVER;
      }
    }),
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Report which variables are wrong without echoing their values.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid environment:\n  - ${issues.join('\n  - ')}`);
  }
  const env = parsed.data;
  const tokens = [
    env.ASTRA_OPERATOR_TOKEN,
    env.ASTRA_AUTOMATION_TOKEN,
    env.ASTRA_VIEWER_TOKEN,
  ].filter(Boolean);
  if (new Set(tokens).size !== tokens.length)
    throw new Error('invalid environment: role tokens must be distinct');
  if (env.ASTRA_SIMULATION && env.ASTRA_FEEDS.length > 0) {
    throw new Error(
      'invalid environment: ASTRA_SIMULATION and ASTRA_FEEDS cannot be combined (simulated and real prices would mix) — set ASTRA_FEEDS= (empty) to simulate',
    );
  }
  return env;
}
