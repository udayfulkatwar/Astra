/** System configuration (config/astra.yaml): engineering parameters, not trading rules. */
import { COMPONENT_IDS, SessionDefinitionSchema, type ComponentId } from '@astra/core';
import { DecisionPolicySchema } from '@astra/decision';
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
  }),
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
