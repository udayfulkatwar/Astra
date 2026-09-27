/**
 * Migration runner (ADR-0002). Applies migrations/NNNN_name.sql in order inside ONE
 * transaction guarded by a transaction-scoped advisory lock (so concurrent instances cannot
 * migrate simultaneously). Each file's SHA-256 is recorded; if an already-applied file has
 * changed, the runner refuses to continue — history is never silently rewritten.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AstraError } from '@astra/core';
import type { Sql } from './client';

export const DEFAULT_MIGRATIONS_DIR = resolve(fileURLToPath(import.meta.url), '../../migrations');
const LOCK_KEY = 0x4a57_2a00; // arbitrary constant: "ASTRA migrations"

export interface MigrationFile {
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
}

export function readMigrations(dir = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

export async function migrate(
  sql: Sql,
  dir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<{ applied: string[] }> {
  const files = readMigrations(dir);
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK_KEY})`;
    await tx`
      create table if not exists schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`;
    const rows = await tx<
      { name: string; checksum: string }[]
    >`select name, checksum from schema_migrations`;
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const [name] of applied) {
      if (!files.some((f) => f.name === name)) {
        throw new AstraError('CONFIG_INVALID', `applied migration ${name} is missing from ${dir}`);
      }
    }
    const newlyApplied: string[] = [];
    for (const f of files) {
      const existing = applied.get(f.name);
      if (existing !== undefined) {
        if (existing !== f.checksum) {
          throw new AstraError(
            'CONFIG_INVALID',
            `migration ${f.name} was modified after being applied (checksum mismatch)`,
          );
        }
        continue;
      }
      await tx.unsafe(f.sql);
      await tx`insert into schema_migrations (name, checksum) values (${f.name}, ${f.checksum})`;
      newlyApplied.push(f.name);
    }
    return { applied: newlyApplied };
  });
}
