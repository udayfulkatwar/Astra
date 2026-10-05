/**
 * Stage 1 integration: migrations 0010–0015 are immutable (pinned content hashes), and the 0015
 * (R004) upgrade over a database that already holds pre-R004 paper state keeps that state, adds
 * the owner table EMPTY, and the first owner start treats the legacy evidence as UNCLEAN and
 * quarantines before readiness. Fresh installs are covered by every PostgreSQL suite (they migrate
 * a new schema); a fresh paper install with no evidence is NONE (paper-owner.test.ts).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/client';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../src/migrate';
import { PaperOwnerRepository } from '../src/repositories/paper';
import { TEST_DB_URL, dbAvailable } from './helpers';

const available = await dbAvailable();

/** SHA-256 of the accepted migration files; a changed applied migration must never ship. */
const PINNED: Record<string, string> = {
  '0010_exposure_reservations.sql':
    'af0a2cd1e01908e5a62c17fbb3a7f96a3a9387696d95add00493b580601c0e18',
  '0011_reserve_unclosed_fills.sql':
    '7c5712b818666c4fd710af9d67be611421d7b8f89448f1c7fe42f7bb25f1205a',
  '0012_quarantine_and_released_repair.sql':
    '279832cda58c18dc60a41b063f85218aa2fd8b6453b45dff29fa07546eb36dcb',
  '0013_tombstone_conservative_quarantine.sql':
    '7c61cd44dde36f32274cf408710d6a05c1befd00c0706a50205b7ad847f67ba0',
  '0014_unproven_reinstatement_quarantine.sql':
    'e8748841cfab16efecea54518a3cd12d11a395eae49291743e34983bba7ce4e4',
  '0015_paper_single_owner.sql': '4ab9d5d456e98f08eaa386348287f15ddddcfff3d8b500b1323e29da8da40c32',
};

describe('migrations 0010–0015 are immutable', () => {
  for (const [name, hash] of Object.entries(PINNED)) {
    it(name, () => {
      const got = createHash('sha256')
        .update(readFileSync(join(DEFAULT_MIGRATIONS_DIR, name)))
        .digest('hex');
      expect(got).toBe(hash);
    });
  }
});

describe.skipIf(!available)('upgrade 0014 → 0015 over pre-R004 paper state', () => {
  it('keeps the legacy snapshot, adds an empty owner table, and the first owner start quarantines', async () => {
    const schema = `mig15_${Math.random().toString(36).slice(2, 8)}`;
    const admin = postgres(TEST_DB_URL, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`create schema ${schema}`);
    const sql = createDb({ url: TEST_DB_URL, schema, maxConnections: 4, applicationName: 'mig15' });
    try {
      const old = mkdtempSync(join(tmpdir(), 'astra-mig15-'));
      for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR))
        if (f < '0015') copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(old, f));
      expect((await migrate(sql, old)).applied.at(-1)).toBe(
        '0014_unproven_reinstatement_quarantine.sql',
      );
      // a paper snapshot written by a pre-R004 process (no revision, no owner)
      await sql`insert into paper_broker_state (adapter_id, account_ref, state, updated_at)
                values ('paper', 'PAPER-A', ${sql.json({ balance: 50000, currency: 'USD', positions: [], orders: [], closed: [] })}, now())`;
      const upgraded = await migrate(sql); // the real directory: 0015 and any LATER migrations are new
      const expected = readdirSync(DEFAULT_MIGRATIONS_DIR)
        .filter((f) => f >= '0015' && f.endsWith('.sql'))
        .sort();
      expect(expected[0]).toBe('0015_paper_single_owner.sql');
      expect(upgraded.applied).toEqual(expected);
      const legacy = await sql<{ revision: string; session_id: string | null }[]>`
        select revision, session_id from paper_broker_state where adapter_id = 'paper'`;
      expect(legacy[0]).toMatchObject({ revision: '0', session_id: null });
      expect(await sql`select 1 from paper_owner`).toHaveLength(0);
      const owner = await new PaperOwnerRepository(sql).acquire({
        adapterId: 'paper',
        sessionId: 'S1',
        accountIds: ['acct-a'],
        at: new Date().toISOString(),
      });
      expect(owner.prior).toBe('UNCLEAN'); // legacy evidence cannot be proven clean
      const q = await sql<{ reason: string }[]>`
        select reason from exposure_quarantines where account_id = 'acct-a' and cleared_at is null`;
      expect(q[0]?.reason).toMatch(/legacy paper state/);
      await owner.release();
      expect((await migrate(sql)).applied).toEqual([]); // idempotent
    } finally {
      await sql.end({ timeout: 5 });
      await admin.unsafe(`drop schema if exists ${schema} cascade`);
      await admin.end();
    }
  });
});
