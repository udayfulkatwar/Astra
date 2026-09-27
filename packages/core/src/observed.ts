/**
 * Observed<T> — the only way external DATA enters ASTRA.
 *
 * An observation is either OK (a value with its source and timestamp) or one of the explicit
 * non-OK statuses. There is deliberately no way to express "missing" as a plausible default
 * value: consumers must handle the non-OK branch, and the decision gate treats every non-OK
 * status as "NO NEW TRADE". This is how the no-fabrication rule is enforced by the type system.
 */
import { z } from 'zod';

export const OBSERVATION_STATUSES = [
  'OK',
  'STALE',
  'UNKNOWN',
  'UNAVAILABLE',
  'ERROR',
  'TIMEOUT',
  'INVALID',
] as const;
export type ObservationStatus = (typeof OBSERVATION_STATUSES)[number];
export type NonOkStatus = Exclude<ObservationStatus, 'OK'>;

/**
 * Where data came from. SIMULATED data is legitimate only in BACKTEST/PAPER; the decision gate
 * rejects it in SHADOW/LIVE (see modes.ts).
 */
export const DATA_SOURCE_KINDS = ['LIVE', 'SIMULATED', 'HISTORICAL', 'MANUAL'] as const;
export type DataSourceKind = (typeof DATA_SOURCE_KINDS)[number];

export interface ObservedOk<T> {
  readonly status: 'OK';
  readonly value: T;
  /** Adapter/provider identifier, e.g. "paper-feed" or "provider:xyz". */
  readonly source: string;
  readonly sourceKind: DataSourceKind;
  /** ISO-8601 UTC timestamp of when the value was true at the source. */
  readonly asOf: string;
}

export interface ObservedNotOk {
  readonly status: NonOkStatus;
  readonly reason: string;
  readonly source: string;
  readonly sourceKind?: DataSourceKind;
  readonly asOf?: string;
}

export type Observed<T> = ObservedOk<T> | ObservedNotOk;

export function observed<T>(
  value: T,
  meta: { source: string; sourceKind: DataSourceKind; asOf: string },
): ObservedOk<T> {
  return { status: 'OK', value, source: meta.source, sourceKind: meta.sourceKind, asOf: meta.asOf };
}

export function notObserved(
  status: NonOkStatus,
  reason: string,
  source: string,
  extra: { sourceKind?: DataSourceKind; asOf?: string } = {},
): ObservedNotOk {
  return { status, reason, source, ...extra };
}

export function isObservedOk<T>(o: Observed<T>): o is ObservedOk<T> {
  return o.status === 'OK';
}

/** Human-readable description of a non-OK observation, for decision reasons. */
export function describeNotOk(label: string, o: ObservedNotOk): string {
  return `${label} ${o.status} (source: ${o.source}): ${o.reason}`;
}

export interface FreshnessPolicy {
  /** Maximum allowed age of the observation. */
  readonly maxAgeMs: number;
  /** Tolerated clock skew for timestamps slightly in the future. Beyond this → INVALID. */
  readonly maxFutureSkewMs: number;
}

/**
 * Downgrades an OK observation to STALE (too old) or INVALID (timestamp in the future or
 * unparseable). Non-OK observations pass through unchanged.
 */
export function applyFreshness<T>(o: Observed<T>, now: Date, policy: FreshnessPolicy): Observed<T> {
  if (o.status !== 'OK') return o;
  const asOfMs = Date.parse(o.asOf);
  if (Number.isNaN(asOfMs)) {
    return notObserved('INVALID', `unparseable timestamp "${o.asOf}"`, o.source, {
      sourceKind: o.sourceKind,
    });
  }
  const ageMs = now.getTime() - asOfMs;
  if (ageMs < -policy.maxFutureSkewMs) {
    return notObserved(
      'INVALID',
      `timestamp ${o.asOf} is ${Math.round(-ageMs)}ms in the future (clock skew?)`,
      o.source,
      { sourceKind: o.sourceKind, asOf: o.asOf },
    );
  }
  if (ageMs > policy.maxAgeMs) {
    return notObserved(
      'STALE',
      `age ${Math.round(ageMs)}ms exceeds limit ${policy.maxAgeMs}ms`,
      o.source,
      { sourceKind: o.sourceKind, asOf: o.asOf },
    );
  }
  return o;
}

/** Applies a pure transformation to an OK value; non-OK passes through. */
export function mapObserved<T, U>(o: Observed<T>, fn: (value: T) => U): Observed<U> {
  return o.status === 'OK' ? { ...o, value: fn(o.value) } : o;
}

/**
 * Validates an OK value against a schema. A value that fails validation becomes INVALID —
 * it is never coerced or partially accepted.
 */
export function validateObserved<T>(o: Observed<unknown>, schema: z.ZodType<T>): Observed<T> {
  if (o.status !== 'OK') return o;
  const parsed = schema.safeParse(o.value);
  if (!parsed.success) {
    return notObserved('INVALID', z.prettifyError(parsed.error), o.source, {
      sourceKind: o.sourceKind,
      asOf: o.asOf,
    });
  }
  return { ...o, value: parsed.data };
}

/**
 * Runs an observation-producing function with a hard timeout. Thrown errors become ERROR,
 * timeouts become TIMEOUT. Never throws.
 */
export async function observeWithTimeout<T>(
  source: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<Observed<T>>,
): Promise<Observed<T>> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Observed<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(notObserved('TIMEOUT', `no response within ${timeoutMs}ms`, source));
    }, timeoutMs);
  });
  try {
    const work = fn(controller.signal).catch((err: unknown): Observed<T> =>
      notObserved('ERROR', err instanceof Error ? err.message : String(err), source),
    );
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const ObservedStatusSchema = z.enum(OBSERVATION_STATUSES);
export const DataSourceKindSchema = z.enum(DATA_SOURCE_KINDS);

/** Zod schema for an Observed<T> payload arriving over the wire (e.g. from n8n). */
export function observedSchema<T extends z.ZodType>(valueSchema: T) {
  return z.discriminatedUnion('status', [
    z.object({
      status: z.literal('OK'),
      value: valueSchema,
      source: z.string().min(1),
      sourceKind: DataSourceKindSchema,
      asOf: z.iso.datetime({ offset: true }),
    }),
    z.object({
      status: z.enum(['STALE', 'UNKNOWN', 'UNAVAILABLE', 'ERROR', 'TIMEOUT', 'INVALID']),
      reason: z.string().min(1),
      source: z.string().min(1),
      sourceKind: DataSourceKindSchema.optional(),
      asOf: z.iso.datetime({ offset: true }).optional(),
    }),
  ]);
}
