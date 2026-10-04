import postgres from 'postgres';

export type Sql = postgres.Sql;
/** Common base of a pool and a transaction: repositories accept either. */
export type Queryable = postgres.ISql;

export interface DbOptions {
  readonly url: string;
  readonly maxConnections?: number;
  /** Schema to use (tests isolate themselves in a dedicated schema). */
  readonly schema?: string;
  readonly applicationName?: string;
}

const origins = new WeakMap<object, DbOptions>();

/**
 * A separate single-connection client with the same target as `sql`. Session-level state that
 * must live and die with ONE connection (the paper-owner advisory lock) uses this instead of a
 * reserved pool connection, so killing that backend never disturbs the shared pool.
 */
export function dedicatedClient(sql: Sql, applicationName = 'astra-dedicated'): Sql {
  const o = origins.get(sql);
  if (!o) throw new Error('dedicatedClient requires a client created by createDb');
  return createDb({ ...o, maxConnections: 1, applicationName });
}

export function createDb(opts: DbOptions): Sql {
  const sql = createPool(opts);
  origins.set(sql, opts);
  return sql;
}

function createPool(opts: DbOptions): Sql {
  return postgres(opts.url, {
    max: opts.maxConnections ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    // numeric → string by default in postgres.js; repositories convert explicitly.
    connection: {
      application_name: opts.applicationName ?? 'astra',
      ...(opts.schema ? { search_path: opts.schema } : {}),
    },
    onnotice: () => undefined,
  });
}

/** Cheap connectivity probe for health/readiness. */
export async function pingDb(sql: Sql): Promise<boolean> {
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  }
}

export const json = (value: unknown): string => JSON.stringify(value);
/**
 * Typed jsonb parameter. Never pass a pre-stringified JSON string with ::jsonb — postgres.js
 * infers the jsonb type and would encode it a second time (storing a JSON string scalar).
 */
export const jsonb = (q: postgres.ISql, value: unknown): postgres.Parameter | null =>
  value === null || value === undefined ? null : q.json(value as postgres.JSONValue);
export const num = (v: string | number | null): number | null => (v === null ? null : Number(v));
export const iso = (v: Date | string | null): string | null =>
  v === null ? null : (v instanceof Date ? v : new Date(v)).toISOString();
