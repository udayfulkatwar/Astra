import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { createDb, type Sql } from '../src/client';
import { migrate } from '../src/migrate';

const DEFAULT_URL = 'postgres://astra:astra_dev_only@localhost:5432/astra_test';
export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? DEFAULT_URL;

/** True when a test database is reachable. CI sets TEST_DATABASE_URL, which makes it mandatory. */
export async function dbAvailable(): Promise<boolean> {
  const probe = postgres(TEST_DB_URL, { max: 1, connect_timeout: 3, onnotice: () => undefined });
  try {
    await probe`select 1`;
    return true;
  } catch (err) {
    if (process.env.TEST_DATABASE_URL) throw err;
    return false;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

export interface TestDb {
  readonly sql: Sql;
  readonly schema: string;
  cleanup(): Promise<void>;
}

/** Creates an isolated schema, migrates it, and returns a client bound to it. */
export async function createTestDb(): Promise<TestDb> {
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const admin = postgres(TEST_DB_URL, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`create schema ${schema}`);
  await admin.end();
  const sql = createDb({
    url: TEST_DB_URL,
    schema,
    maxConnections: 5,
    applicationName: 'astra-test',
  });
  await migrate(sql);
  return {
    sql,
    schema,
    async cleanup() {
      await sql.end({ timeout: 5 });
      const a = postgres(TEST_DB_URL, { max: 1, onnotice: () => undefined });
      await a.unsafe(`drop schema if exists ${schema} cascade`);
      await a.end();
    },
  };
}
