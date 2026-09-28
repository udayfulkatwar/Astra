/** System configuration (config/astra.yaml): engineering parameters, not trading rules. */
import { COMPONENT_IDS, SessionDefinitionSchema, type ComponentId } from '@astra/core';
import { DecisionPolicySchema } from '@astra/decision';
import { StructureParamsSchema } from '@astra/market-structure';
import { MonitorPolicySchema, ProtectionPolicySchema } from '@astra/risk';
import { z } from 'zod';

const componentStaleness = z.object(
  Object.fromEntries(COMPONENT_IDS.map((c) => [c, z.number().int().positive()])) as Record<
    ComponentId,
    z.ZodNumber
  >,
);

export const SystemConfigSchema = z.object({
  version: z.literal(1),
  decision: DecisionPolicySchema,
  /** Named trading sessions (spec §56); strategies reference them by id. */
  sessions: z
    .array(SessionDefinitionSchema)
    .refine((list) => new Set(list.map((s) => s.id)).size === list.length, {
      message: 'session ids must be unique',
    }),
  health: z.object({
    /** A component whose last report is older than this (ms) is UNKNOWN. */
    staleAfterMs: componentStaleness,
  }),
  assembler: z.object({
    /** Hard timeout for each data provider when assembling a decision. */
    providerTimeoutMs: z.number().int().positive().max(30_000),
  }),
  execution: z.object({
    confirmationTimeoutMs: z.number().int().positive(),
    confirmationPollIntervalMs: z.number().int().positive(),
    /**
     * Modes in which the automation role may execute an approval immediately. LIVE is never
     * allowed here: live orders always require an operator (controlled live, spec §60 phase 10).
     */
    autoExecuteModes: z.array(z.enum(['PAPER', 'SHADOW'])),
  }),
  tracking: z.object({
    lateObservationThresholdMs: z.number().int().positive(),
  }),
  monitors: z.object({
    /** Interval of the in-core safety loop (health probes, account sync, halts, expiries). */
    haltMonitorIntervalMs: z.number().int().positive(),
    /** Minimum interval between persisted account snapshots (history), per account. */
    snapshotPersistIntervalMs: z.number().int().positive(),
    /** Position monitor alert levels (DEFAULTS when omitted); it warns, never acts. */
    positions: MonitorPolicySchema.optional(),
  }),
  /** Market-data quality and bar settings. Omitted → the @astra/market-data defaults. */
  marketData: z
    .object({
      /** How long a symbol's quotes are INVALID after an abnormal price jump (default 60 s). */
      suspectCooldownMs: z.number().int().positive().optional(),
      /** Completed bars kept in memory per instrument, source and timeframe (default 1000). */
      maxBarsPerSeries: z.number().int().min(15).max(10_000).optional(),
      /** A bar closes this long after its period ends when no newer quote arrives (default 2 s). */
      barCloseGraceMs: z.number().int().nonnegative().max(60_000).optional(),
    })
    .optional(),
  /**
   * Automatic protective closing (ADR-0014; owner-authorised). Omitted → DEFAULTS (enabled).
   */
  protection: ProtectionPolicySchema.optional(),
  /**
   * Economic-calendar provider polling (ADR-0011). Omitted → no provider: windows arrive only by
   * push (n8n → POST /api/v1/calendar/window), or from the SIMULATED schedule in simulation mode.
   */
  calendar: z
    .object({
      /** Provider adapter; real ones are added once the owner chooses a provider. */
      provider: z.enum(['none']).default('none'),
      pollIntervalMs: z.number().int().min(10_000).default(300_000),
      timeoutMs: z.number().int().positive().max(60_000).default(10_000),
      lookbackHours: z.number().int().min(0).max(168).default(24),
      lookaheadHours: z.number().int().min(1).max(720).default(168),
    })
    .strict()
    .optional(),
  /**
   * News intelligence (ADR-0019). Omitted → defaults and no provider: items arrive by push
   * (n8n → POST /api/v1/news/items) or from the SIMULATED feed in simulation mode.
   */
  news: z
    .object({
      /** Provider adapter; real ones are added once the owner chooses a provider. */
      provider: z.enum(['none']).default('none'),
      pollIntervalMs: z.number().int().min(10_000).default(60_000),
      timeoutMs: z.number().int().positive().max(60_000).default(10_000),
      /** How far back the first poll after a start reaches. */
      lookbackHours: z.number().int().min(1).max(72).default(6),
      /** Items older than this are dropped from memory (they stay in the database). */
      retentionHours: z.number().int().min(1).max(720).default(48),
      /** DEFAULTS: how long a HIGH / MEDIUM-impact item keeps news risk HIGH / ELEVATED. */
      risk: z
        .object({
          highImpactMinutes: z.number().int().min(1).max(1_440).default(30),
          mediumImpactMinutes: z.number().int().min(1).max(1_440).default(15),
        })
        .strict()
        .default({ highImpactMinutes: 30, mediumImpactMinutes: 15 }),
      /** Words that tie a headline to an instrument (in addition to its event currencies). */
      instrumentKeywords: z
        .record(z.string(), z.array(z.string().trim().min(2).max(60)).max(50))
        .default({}),
    })
    .strict()
    .optional(),
  /**
   * Market-structure detection definitions (swings, BOS/CHoCH, liquidity, gaps — ADR-0010).
   * Omitted → the @astra/market-structure defaults. DEFAULTS to review with the strategy (Phase 5).
   */
  structure: StructureParamsSchema.optional(),
  /**
   * SIMULATED feeds for paper testing (only when ASTRA_SIMULATION=true). Start prices are
   * simulation seeds, NOT market data; SIMULATED data is refused in SHADOW and LIVE.
   */
  simulation: z
    .object({
      quoteIntervalMs: z.number().int().positive(),
      instruments: z.record(
        z.string(),
        z.object({
          startPrice: z.number().positive(),
          volatilityTicks: z.number().positive(),
          spreadTicks: z.number().positive(),
        }),
      ),
    })
    .optional(),
});
export type SystemConfig = z.infer<typeof SystemConfigSchema>;
