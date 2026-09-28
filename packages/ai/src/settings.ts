/** `ai:` block of config/astra.yaml. Engineering parameters and DEFAULTS; no secrets (env-var names only). */
import { z } from 'zod';
import { AI_EFFORTS } from './types';

const EnvVarNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'an environment variable NAME');

export const AiRouteSchema = z
  .object({
    /** Provider id: `anthropic`, or `simulated` (rule-based stand-in, simulation mode only). */
    provider: z.enum(['anthropic', 'simulated']),
    model: z.string().min(1),
    effort: z.enum(AI_EFFORTS).optional(),
    maxOutputTokens: z.number().int().min(256).max(64_000),
    timeoutMs: z.number().int().min(1_000).max(300_000),
  })
  .strict();
export type AiRoute = z.infer<typeof AiRouteSchema>;

/** USD per million tokens. */
export const AiPriceSchema = z
  .object({
    inputPerMTok: z.number().nonnegative(),
    outputPerMTok: z.number().nonnegative(),
    cacheReadPerMTok: z.number().nonnegative(),
    cacheWritePerMTok: z.number().nonnegative(),
  })
  .strict();
export type AiPrice = z.infer<typeof AiPriceSchema>;

export const AiSettingsSchema = z
  .object({
    enabled: z.boolean(),
    providers: z
      .object({
        anthropic: z
          .object({
            /** NAME of the environment variable that holds the API key. */
            apiKeyEnv: EnvVarNameSchema,
            maxRetries: z.number().int().min(0).max(3).default(1),
            /** Re-run a declined request on Anthropic's recommended fallback model, server-side. */
            serverSideFallbacks: z.boolean().default(true),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({}),
    /** In simulation mode, route every task to the SIMULATED stand-in (explicit opt-in). */
    standInWhenSimulating: z.boolean().default(false),
    routes: z.object({ TRADE_ANALYSIS: AiRouteSchema, POST_TRADE_REVIEW: AiRouteSchema }).strict(),
    /** DEFAULTS: a call is refused when its worst-case cost would pass the daily limit (UTC day). */
    budget: z
      .object({
        dailyCostUsd: z.number().positive(),
        dailyCalls: z.number().int().positive(),
        /** AI health turns DEGRADED from this fraction of either limit. */
        degradeAt: z.number().gt(0).max(1).default(0.8),
      })
      .strict(),
    /** List prices to VERIFY; a model without a price is never called (budget can't be enforced). */
    prices: z.record(z.string(), AiPriceSchema),
    tradeAnalysis: z
      .object({
        /** Complete bars of the signal's timeframe included in the brief. */
        recentBars: z.number().int().min(0).max(200).default(30),
        maxHeadlines: z.number().int().min(0).max(50).default(10),
      })
      .strict()
      .default({ recentBars: 30, maxHeadlines: 10 }),
    postTradeReview: z
      .object({
        /** Review every newly journaled trade automatically (costs a call per trade). */
        auto: z.boolean().default(false),
      })
      .strict()
      .default({ auto: false }),
  })
  .strict();
export type AiSettings = z.infer<typeof AiSettingsSchema>;
