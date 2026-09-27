import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../src/migrate';
import { AuditRepository } from '../src/repositories/audit';
import { SystemStateRepository } from '../src/repositories/system';
import { createTestDb, dbAvailable, type TestDb } from './helpers';

const available = await dbAvailable();

describe.skipIf(!available)('migrations', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.cleanup();
  });

  it('is idempotent', async () => {
    expect((await migrate(db.sql)).applied).toEqual([]);
  });

  it('refuses to run when an applied migration was modified', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'astra-mig-'));
    try {
      cpSync(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
      writeFileSync(join(dir, '0001_initial.sql'), '-- tampered\n', { flag: 'a' });
      await expect(migrate(db.sql, dir)).rejects.toThrow(/checksum mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts in PAPER, never LIVE', async () => {
    const s = await new SystemStateRepository(db.sql).get();
    expect(s.mode).toBe('PAPER');
  });
});

describe.skipIf(!available)('audit log', () => {
  let db: TestDb;
  let audit: AuditRepository;
  beforeAll(async () => {
    db = await createTestDb();
    audit = new AuditRepository(db.sql);
  });
  afterAll(async () => {
    await db.cleanup();
  });

  const entry = (i: number) => ({
    actor: { type: 'SYSTEM' as const, id: 'test' },
    category: 'TEST',
    action: 'APPEND',
    entityType: 'thing',
    entityId: `t${i}`,
    payload: { i, nested: { b: 2, a: [1, 2.5, 'x'] } },
    at: new Date(Date.UTC(2026, 8, 28, 14, 0, i)).toISOString(),
  });

  it('chains entries and verifies the chain', async () => {
    const a = await audit.append(entry(1));
    const b = await audit.append(entry(2));
    expect(b.prevHash).toBe(a.hash);
    expect(await audit.verifyChain()).toMatchObject({ ok: true, checked: 2 });
  });

  it('keeps the chain linear under concurrent appends', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => audit.append(entry(10 + i))));
    const v = await audit.verifyChain();
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(22);
  });

  it('rejects UPDATE, DELETE and TRUNCATE', async () => {
    await expect(db.sql`update audit_log set action = 'X'`).rejects.toThrow(/append-only/);
    await expect(db.sql`delete from audit_log`).rejects.toThrow(/append-only/);
    await expect(db.sql`truncate audit_log`).rejects.toThrow(/append-only/);
  });

  it('detects tampering even by the table owner', async () => {
    await db.sql`alter table audit_log disable trigger audit_log_append_only`;
    await db.sql`update audit_log set payload = '{"i": 999}'::jsonb where seq = 2`;
    await db.sql`alter table audit_log enable trigger audit_log_append_only`;
    const v = await audit.verifyChain();
    expect(v).toMatchObject({ ok: false, brokenAtSeq: 2 });
  });
});

describe.skipIf(!available)('system state', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.cleanup();
  });

  it('changes mode with optimistic concurrency and audits it', async () => {
    const repo = new SystemStateRepository(db.sql);
    const s = await repo.get();
    const next = await repo.setMode({
      mode: 'HALTED',
      actor: { type: 'HUMAN', id: 'owner' },
      reason: 'test',
      expectedVersion: s.version,
      at: '2026-09-28T14:00:00.000Z',
    });
    expect(next).toMatchObject({
      mode: 'HALTED',
      version: s.version + 1,
      changedBy: 'HUMAN:owner',
    });
    await expect(
      repo.setMode({
        mode: 'PAPER',
        actor: { type: 'HUMAN', id: 'owner' },
        reason: 'stale',
        expectedVersion: s.version,
        at: '2026-09-28T14:01:00.000Z',
      }),
    ).rejects.toThrow(/concurrently/);
    const [a] = await new AuditRepository(db.sql).list({ category: 'SYSTEM' });
    expect(a).toMatchObject({ action: 'MODE_CHANGED', actorId: 'owner' });
  });
});
