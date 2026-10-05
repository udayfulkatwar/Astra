/**
 * P002 offline increment on a REAL PostgreSQL: the durable bridge journal, the fake-only transport
 * and the bridge runner. Everything here is OFFLINE: no MT5 SDK, no terminal, no network, no
 * runtime registration. The fake's statuses are an abstract test model, not MT5 return codes, and
 * its write-boundary fence proves bridge LOGIC against the model, not a real terminal.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BridgeOwnerError,
  FakeTerminal,
  OfflineBridge,
  encodeAccountRef,
  parseCommand,
  payloadHash,
  type BridgeCommand,
  type BridgeJournal,
  type BridgeTransport,
  type Fence,
} from '@astra/execution';
import { createDb } from '../src/client';
import { PgBridgeJournal } from '../src/repositories/bridge-journal';
import { TEST_DB_URL, createTestDb, dbAvailable, type TestDb } from './helpers';

const available = await dbAvailable();
const ACCOUNT = encodeAccountRef('Demo-Server', '9007199254740993');
const NOW = new Date('2026-10-05T10:00:10.000Z');
const GUARD = { nowIso: '2026-10-05T10:00:10.000Z' };
const rt = (now: Date = NOW, permitted: () => boolean | Promise<boolean> = () => true) => ({
  clock: () => now,
  entryPermitted: permitted,
});
const CTX = rt();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const wire = (over: Record<string, unknown> = {}) => ({
  v: 1,
  op: 'SUBMIT',
  commandId: 'c1',
  accountRef: ACCOUNT,
  issuedAt: '2026-10-05T10:00:00.000Z',
  expiresAt: '2026-10-05T10:00:30.000Z',
  payload: { symbol: 'US30', side: 'BUY', lots: '0.10', stopLoss: '38000', takeProfit: '39000' },
  ...over,
});
const close = (commandId: string, over: Record<string, unknown> = {}) =>
  wire({
    op: 'CLOSE',
    commandId,
    payload: { positionIdentifier: '9007199254740993', lots: null },
    ...over,
  });
const cmd = (raw: unknown): BridgeCommand => {
  const p = parseCommand(raw);
  if (!p.ok) throw new Error(p.errors.join(';'));
  return p.command;
};

describe.skipIf(!available)('P002 offline bridge journal (PostgreSQL, fake transport only)', () => {
  let db: TestDb;
  let journal: PgBridgeJournal;
  let fence: Fence;
  let terminal: FakeTerminal;
  let bridge: OfflineBridge;
  beforeEach(async () => {
    db = await createTestDb();
    journal = new PgBridgeJournal(db.sql);
    fence = await journal.acquireOwner(ACCOUNT, 'bridge-A');
    terminal = new FakeTerminal();
    bridge = new OfflineBridge(journal, terminal, fence);
  });
  afterEach(async () => {
    await db.cleanup();
  });
  const count = async (table: string) =>
    Number((await db.sql.unsafe(`select count(*)::int as n from ${table}`))[0]?.n);
  const stateOf = async (id: string) => (await journal.get(ACCOUNT, id))?.state;

  describe('validation before any write', () => {
    it('malformed fields, NaN, unknown operations and non-canonical accounts write nothing and never reach the transport', async () => {
      for (const bad of [
        wire({ op: 'MODIFY' }),
        wire({
          payload: { symbol: 'US30', side: 'BUY', lots: NaN, stopLoss: '1', takeProfit: '2' },
        }),
        wire({ accountRef: 'mt5:["Demo-Server", "1"]' }),
        wire({ extra: true }),
        'garbage',
      ]) {
        expect((await bridge.execute(bad, CTX)).kind).toBe('INVALID');
      }
      expect(await count('bridge_command')).toBe(0);
      expect(terminal.invocations).toHaveLength(0);
    });
  });

  describe('atomic client-id + payload uniqueness', () => {
    it('20 concurrent begins of one id and payload create exactly one intent', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => journal.begin(fence, cmd(wire()))),
      );
      expect(results.filter((r) => r.kind === 'NEW')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'REPLAY')).toHaveLength(19);
      expect(await count('bridge_command')).toBe(1);
    });

    it('the same id with a different payload is refused and never reaches the transport', async () => {
      expect((await bridge.execute(wire(), CTX)).kind).toBe('RESOLVED');
      const changed = wire({
        payload: {
          symbol: 'US30',
          side: 'SELL',
          lots: '0.10',
          stopLoss: '38000',
          takeProfit: '39000',
        },
      });
      expect((await bridge.execute(changed, CTX)).kind).toBe('CONFLICT');
      expect(terminal.invocations).toHaveLength(1);
    });

    it('the same id and payload replays the stored result without a second invocation', async () => {
      const first = await bridge.execute(wire(), CTX);
      const retimed = wire({ expiresAt: '2026-10-05T10:05:00.000Z' }); // timing differs, payload same
      const again = await bridge.execute(retimed, CTX);
      expect(first.kind).toBe('RESOLVED');
      expect(again).toEqual(first);
      expect(terminal.invocations).toHaveLength(1);
    });

    it('the marker is a compare-and-swap: of 20 concurrent callers exactly one wins and may invoke', async () => {
      await journal.begin(fence, cmd(wire()));
      const wins = await Promise.all(
        Array.from({ length: 20 }, () =>
          journal.markSendMayHaveStarted(fence, ACCOUNT, 'c1', GUARD),
        ),
      );
      expect(wins.filter((w) => w === 'WON')).toHaveLength(1);
      expect(wins.filter((w) => w === 'LOST_RACE')).toHaveLength(19);
    });

    it('two bridges sharing one fence racing the same command invoke the terminal at most once', async () => {
      const t2 = new FakeTerminal();
      const b2 = new OfflineBridge(new PgBridgeJournal(db.sql), t2, fence);
      const [a, b] = await Promise.all([bridge.execute(wire(), CTX), b2.execute(wire(), CTX)]);
      expect(terminal.invocations.length + t2.invocations.length).toBe(1);
      expect([a.kind, b.kind]).toContain('RESOLVED');
    });
  });

  describe('durable SEND_MAY_HAVE_STARTED before the transport', () => {
    it('the marker is already committed (visible on another connection) when the transport is called', async () => {
      const observer = createDb({ url: TEST_DB_URL, schema: db.schema, maxConnections: 1 });
      try {
        let seen: string | undefined;
        const spy: BridgeTransport = {
          async invoke(command, f, boundary) {
            const rows = await observer<{ state: string }[]>`
              select state from bridge_command where command_id = ${command.commandId}`;
            seen = rows[0]?.state;
            return terminal.invoke(command, f, boundary);
          },
        };
        await new OfflineBridge(journal, spy, fence).execute(wire(), CTX);
        expect(seen).toBe('SEND_MAY_HAVE_STARTED');
      } finally {
        await observer.end({ timeout: 2 });
      }
    });

    it('a failed marker persist means the transport is NOT invoked and the row stays an unsent INTENT', async () => {
      const failing: BridgeJournal = Object.create(journal) as BridgeJournal;
      failing.markSendMayHaveStarted = () => Promise.reject(new Error('disk full'));
      const out = await new OfflineBridge(failing, terminal, fence).execute(wire(), CTX);
      expect(out).toEqual({ kind: 'NOT_SENT', reason: 'disk full' });
      expect(terminal.invocations).toHaveLength(0);
      expect(await stateOf('c1')).toBe('INTENT');
    });

    it('the marker is irreversible, rows are never deleted and payloads never change (database guard)', async () => {
      await bridge.execute(wire(), CTX);
      await expect(db.sql`update bridge_command set state = 'INTENT'`).rejects.toThrow(
        /illegal bridge_command transition/,
      );
      await expect(db.sql`delete from bridge_command`).rejects.toThrow(/never deleted/);
      await expect(db.sql`update bridge_command set payload_hash = 'x'`).rejects.toThrow(
        /immutable/,
      );
      await expect(db.sql`update bridge_command set state = 'UNKNOWN'`).rejects.toThrow(
        /illegal bridge_command transition/,
      );
    });
  });

  describe('unknown outcomes are preserved and never blindly resent', () => {
    it.each([
      ['a thrown error before any effect', { kind: 'THROW_BEFORE_EFFECT' } as const],
      ['a lost reply after the effect', { kind: 'THROW_AFTER_EFFECT' } as const],
      ['a malformed reply', { kind: 'RAW', reply: { status: 'WAT' } } as const],
      ['a reply with an extra key', { kind: 'RAW', reply: { status: 'NOT_FOUND', x: 1 } } as const],
      ['a wrong-operation reply (NOT_FOUND for a SUBMIT)', { kind: 'NOT_FOUND' } as const],
    ])('%s is UNKNOWN, replays as UNKNOWN and is never resent', async (_n, behavior) => {
      terminal.script('c1', behavior);
      const first = await bridge.execute(wire(), CTX);
      expect(first.kind).toBe('UNKNOWN');
      expect(await stateOf('c1')).toBe('UNKNOWN');
      const second = await bridge.execute(wire(), CTX);
      expect(second.kind).toBe('UNKNOWN');
      expect(terminal.invocations).toHaveLength(1);
    });

    it('a result write that fails leaves SEND_MAY_HAVE_STARTED and the command is still never resent', async () => {
      const flaky: BridgeJournal = Object.create(journal) as BridgeJournal;
      flaky.recordResult = () => Promise.reject(new Error('connection lost'));
      await new OfflineBridge(flaky, terminal, fence).execute(wire(), CTX);
      expect(await stateOf('c1')).toBe('SEND_MAY_HAVE_STARTED');
      expect((await bridge.execute(wire(), CTX)).kind).toBe('UNKNOWN');
      expect(terminal.invocations).toHaveLength(1);
    });

    it('does not touch exposure reservations (they stay with ADR-0027 evidence, not this journal)', async () => {
      const before = await count('exposure_reservations');
      terminal.script('c1', { kind: 'THROW_AFTER_EFFECT' });
      await bridge.execute(wire(), CTX);
      expect(await count('exposure_reservations')).toBe(before);
    });
  });

  describe('restart: a NEW connection pool reads only persisted state', () => {
    it('reopened store preserves a dispatched UNKNOWN and refuses to resend it', async () => {
      terminal.script('c1', { kind: 'THROW_AFTER_EFFECT' });
      await bridge.execute(wire(), CTX);
      await db.sql.end({ timeout: 2 });
      const reopened = createDb({ url: TEST_DB_URL, schema: db.schema, maxConnections: 2 });
      try {
        const j2 = new PgBridgeJournal(reopened);
        const rec = await j2.get(ACCOUNT, 'c1');
        expect(rec?.state).toBe('UNKNOWN');
        const t2 = new FakeTerminal();
        const out = await new OfflineBridge(j2, t2, fence).execute(wire(), CTX);
        expect(out.kind).toBe('UNKNOWN');
        expect(t2.invocations).toHaveLength(0);
      } finally {
        await reopened.end({ timeout: 2 });
      }
      // afterEach cleanup uses db.sql (ended): re-create so cleanup can drop the schema.
      db = { ...db, sql: createDb({ url: TEST_DB_URL, schema: db.schema, maxConnections: 1 }) };
    });
  });

  describe('subprocess crash and concurrent-store cases (state crosses real process boundaries)', () => {
    const tsxLoader = resolve(import.meta.dirname, '../node_modules/tsx/dist/esm/index.mjs');
    const child = resolve(import.meta.dirname, 'support/bridge-child.ts');
    const run = (mode: string, command: unknown, f: Fence) =>
      new Promise<{ code: number | null; signal: string | null; out: string }>((resolveRun) => {
        // Direct node child (not the tsx wrapper) so a SIGKILL of the child is observable as such.
        const p = spawn(process.execPath, ['--import', tsxLoader, child], {
          cwd: resolve(import.meta.dirname, '..'),
          env: {
            ...process.env,
            CHILD_MODE: mode,
            CHILD_DB_URL: TEST_DB_URL,
            CHILD_SCHEMA: db.schema,
            CHILD_ACCOUNT: f.accountRef,
            CHILD_OWNER: f.ownerId,
            CHILD_EPOCH: f.epoch,
            CHILD_COMMAND: JSON.stringify(command),
          },
        });
        let out = '';
        p.stdout.on('data', (d: Buffer) => (out += d.toString()));
        p.on('close', (code, signal) => resolveRun({ code, signal, out }));
      });

    it('a process killed after the intent but before the marker leaves a safe INTENT that the next owner may send once', async () => {
      const r = await run('crash-after-begin', wire(), fence);
      expect(r.signal).toBe('SIGKILL');
      expect(await stateOf('c1')).toBe('INTENT');
      // The old process is dead: an explicit, evidence-carrying takeover (no handoff by expiry).
      const next = await journal.takeover(ACCOUNT, 'bridge-B', {
        oldWriterCannotAct: true,
        note: 'process SIGKILLed',
      });
      await journal.completeReconcile(ACCOUNT, next);
      const t2 = new FakeTerminal();
      const out = await new OfflineBridge(journal, t2, next).execute(wire(), CTX);
      expect(out.kind).toBe('RESOLVED');
      expect(t2.invocations).toHaveLength(1);
    });

    it('a process killed after the marker leaves SEND_MAY_HAVE_STARTED: the next owner NEVER resends', async () => {
      const r = await run('crash-after-marker', wire(), fence);
      expect(r.signal).toBe('SIGKILL');
      expect(await stateOf('c1')).toBe('SEND_MAY_HAVE_STARTED');
      const next = await journal.takeover(ACCOUNT, 'bridge-B', {
        oldWriterCannotAct: true,
        note: 'process SIGKILLed',
      });
      await journal.completeReconcile(ACCOUNT, next);
      const t2 = new FakeTerminal();
      const out = await new OfflineBridge(journal, t2, next).execute(wire(), CTX);
      expect(out.kind).toBe('UNKNOWN');
      expect(t2.invocations).toHaveLength(0);
      expect(await stateOf('c1')).toBe('SEND_MAY_HAVE_STARTED');
    });

    it('three concurrent processes executing the same command invoke their fake terminals exactly once in total', async () => {
      const runs = await Promise.all([1, 2, 3].map(() => run('execute', wire(), fence)));
      const reports = runs.map(
        (r) => JSON.parse(r.out.trim()) as { kind: string; invocations: number },
      );
      expect(reports.reduce((n, r) => n + r.invocations, 0)).toBe(1);
      expect(reports.some((r) => r.kind === 'RESOLVED')).toBe(true);
      expect(await stateOf('c1')).toBe('RESOLVED');
    }, 60_000);

    it('a stale-fence process is refused by the database and invokes nothing', async () => {
      await journal.takeover(ACCOUNT, 'bridge-B', { oldWriterCannotAct: true, note: 'test' });
      const r = await run('execute', wire(), fence); // still holds the OLD epoch
      expect(r.code).not.toBe(0);
      expect(await count('bridge_command')).toBe(0);
    }, 60_000);
  });

  describe('ownership: no handoff by expiry; fence checked inside the write', () => {
    it('a second claimant is BUSY however old the owner row is', async () => {
      await db.sql`update bridge_owner set updated_at = now() - interval '30 days'`;
      await expect(journal.acquireOwner(ACCOUNT, 'bridge-B')).rejects.toMatchObject({
        code: 'BUSY',
      });
    });

    it('takeover requires explicit evidence and then needs reconciliation before entries', async () => {
      await expect(
        journal.takeover(ACCOUNT, 'bridge-B', {
          oldWriterCannotAct: false as unknown as true,
          note: 'x',
        }),
      ).rejects.toBeInstanceOf(BridgeOwnerError);
      await expect(
        journal.takeover(ACCOUNT, 'bridge-B', { oldWriterCannotAct: true, note: '  ' }),
      ).rejects.toBeInstanceOf(BridgeOwnerError);
      const next = await journal.takeover(ACCOUNT, 'bridge-B', {
        oldWriterCannotAct: true,
        note: 'evidence',
      });
      expect(next.epoch).toBe('2');
      const b2 = new OfflineBridge(journal, terminal, next);
      expect(await b2.execute(wire({ commandId: 'e1' }), CTX)).toEqual({
        kind: 'REFUSED',
        reason: 'reconciliation required',
      });
      await journal.completeReconcile(ACCOUNT, next);
      expect((await b2.execute(wire({ commandId: 'e2' }), CTX)).kind).toBe('RESOLVED');
    });

    it('a stale bridge is refused inside the transaction, before any intent, marker or result, and never invokes', async () => {
      await journal.takeover(ACCOUNT, 'bridge-B', { oldWriterCannotAct: true, note: 'evidence' });
      await expect(bridge.execute(wire(), CTX)).rejects.toMatchObject({ code: 'LOST' });
      expect(terminal.invocations).toHaveLength(0);
      expect(await count('bridge_command')).toBe(0);
    });

    it('a stale fence is also refused at the marker and result writes (ownership change mid-command)', async () => {
      await journal.begin(fence, cmd(wire()));
      await journal.takeover(ACCOUNT, 'bridge-B', { oldWriterCannotAct: true, note: 'evidence' });
      await expect(
        journal.markSendMayHaveStarted(fence, ACCOUNT, 'c1', GUARD),
      ).rejects.toMatchObject({
        code: 'LOST',
      });
      expect(await stateOf('c1')).toBe('INTENT');
    });

    it('FAKE write-boundary fence: a lower epoch reaching the fake terminal directly is refused (model only, not a real terminal)', async () => {
      const next = await journal.takeover(ACCOUNT, 'bridge-B', {
        oldWriterCannotAct: true,
        note: 'evidence',
      });
      await journal.completeReconcile(ACCOUNT, next);
      await new OfflineBridge(journal, terminal, next).execute(wire({ commandId: 'n1' }), CTX);
      const oldBoundary = bridge.boundaryFor(cmd(wire({ commandId: 'old' })), CTX);
      const reply = await terminal.invoke(cmd(wire({ commandId: 'old' })), fence, oldBoundary);
      expect(reply).toMatchObject({ status: 'BOUNDARY_REFUSED', reason: 'stale owner fence' });
      expect(terminal.effects).not.toContain('old');
    });
  });

  describe('entry gates apply to entries only; protective intents stay durable', () => {
    it('an expired entry is REFUSED (persisted, never sent) while an expired protective close still runs', async () => {
      const late = rt(new Date('2026-10-05T11:00:00.000Z'));
      expect(await bridge.execute(wire({ commandId: 'e1' }), late)).toEqual({
        kind: 'REFUSED',
        reason: 'entry command expired',
      });
      expect(await stateOf('e1')).toBe('REFUSED');
      const closed = await bridge.execute(close('p1'), late);
      expect(closed).toMatchObject({ kind: 'RESOLVED', result: { closeStatus: 'CLOSED' } });
      expect(terminal.invocations.map((i) => i.command.commandId)).toEqual(['p1']);
    });

    it('entry permission denied refuses entries but never blocks a protective cancel or close', async () => {
      const denied = rt(NOW, () => false);
      expect((await bridge.execute(wire({ commandId: 'e1' }), denied)).kind).toBe('REFUSED');
      expect((await bridge.execute(close('p1'), denied)).kind).toBe('RESOLVED');
      const cancel = wire({ op: 'CANCEL', commandId: 'p2', payload: { orderId: '77' } });
      expect((await bridge.execute(cancel, denied)).kind).toBe('RESOLVED');
    });

    it('while reconciliation is required a protective intent stays a durable pending INTENT and is drained afterwards, across a restart', async () => {
      const next = await journal.takeover(ACCOUNT, 'bridge-B', {
        oldWriterCannotAct: true,
        note: 'evidence',
      });
      const b2 = new OfflineBridge(journal, terminal, next);
      expect(await b2.execute(close('p1'), CTX)).toEqual({
        kind: 'PENDING',
        reason: 'reconciliation required',
      });
      expect(terminal.invocations).toHaveLength(0);
      expect((await journal.pendingProtective(ACCOUNT)).map((r) => r.commandId)).toEqual(['p1']);

      // Restart: a fresh pool and bridge see the persisted pending intent.
      const reopened = createDb({ url: TEST_DB_URL, schema: db.schema, maxConnections: 2 });
      try {
        const j2 = new PgBridgeJournal(reopened);
        const b3 = new OfflineBridge(j2, terminal, next);
        expect(await b3.drainProtective(ACCOUNT, CTX)).toEqual([
          { kind: 'PENDING', reason: 'reconciliation required' },
        ]);
        await j2.completeReconcile(ACCOUNT, next);
        const drained = await b3.drainProtective(ACCOUNT, CTX);
        expect(drained).toHaveLength(1);
        expect(drained[0]?.kind).toBe('RESOLVED');
        expect(terminal.invocations).toHaveLength(1);
        expect(await b3.drainProtective(ACCOUNT, CTX)).toEqual([]);
      } finally {
        await reopened.end({ timeout: 2 });
      }
    });
  });

  describe('close results', () => {
    it('a partial close is never reported CLOSED and its quantities are preserved across a reopen', async () => {
      terminal.script('p1', { kind: 'PARTIAL', doneLots: '0.04', remainingLots: '0.06' });
      const out = await bridge.execute(
        close('p1', { payload: { positionIdentifier: '5', lots: '0.10' } }),
        CTX,
      );
      expect(out).toMatchObject({
        kind: 'RESOLVED',
        result: { closeStatus: 'PARTIAL', transport: { doneLots: '0.04', remainingLots: '0.06' } },
      });
      const rec = await new PgBridgeJournal(db.sql).get(ACCOUNT, 'p1');
      expect(rec?.result?.closeStatus).toBe('PARTIAL');
    });

    it('DONE with remaining lots is PARTIAL; DONE proving zero remaining is CLOSED; an unproven remainder is UNKNOWN', async () => {
      terminal.script('p1', { kind: 'DONE', remainingLots: '0.02' });
      expect(await bridge.execute(close('p1'), CTX)).toMatchObject({
        result: { closeStatus: 'PARTIAL' },
      });
      terminal.script('p2', { kind: 'DONE', remainingLots: '0' });
      expect(await bridge.execute(close('p2'), CTX)).toMatchObject({
        result: { closeStatus: 'CLOSED' },
      });
      const lax: BridgeTransport = {
        invoke: () => Promise.resolve({ status: 'DONE', ref: '1', remainingLots: null }),
      };
      expect((await new OfflineBridge(journal, lax, fence).execute(close('p3'), CTX)).kind).toBe(
        'UNKNOWN',
      );
    });

    it('NOT_FOUND for a close is unsupported in the model: UNKNOWN, never proven closure', async () => {
      terminal.script('p1', { kind: 'NOT_FOUND' });
      const out = await bridge.execute(close('p1'), CTX);
      expect(out).toMatchObject({ kind: 'UNKNOWN', result: { note: 'close outcome unproven' } });
    });

    it('incoherent quantities are not outcomes: partial against a request that names other lots, DONE above the asked remainder', async () => {
      terminal.script('p1', { kind: 'PARTIAL', doneLots: '0.04', remainingLots: '0.07' });
      expect(
        (
          await bridge.execute(
            close('p1', { payload: { positionIdentifier: '5', lots: '0.10' } }),
            CTX,
          )
        ).kind,
      ).toBe('UNKNOWN');
      terminal.script('p2', { kind: 'DONE', remainingLots: '0.50' });
      expect(
        (
          await bridge.execute(
            close('p2', { payload: { positionIdentifier: '5', lots: '0.10' } }),
            CTX,
          )
        ).kind,
      ).toBe('UNKNOWN');
      terminal.script('s1', { kind: 'PARTIAL', doneLots: '0.04', remainingLots: '0.06' });
      expect(await bridge.execute(wire({ commandId: 's1' }), CTX)).toMatchObject({
        kind: 'RESOLVED',
        result: { transport: { status: 'PARTIAL' } },
      });
    });
  });

  describe('CEO review repairs: detached snapshot, clock/gate, persistence, boundary, account-bound fence', () => {
    it('a caller mutating the raw command during the begin await changes neither what is sent nor what is hashed', async () => {
      const slow: BridgeJournal = Object.create(journal) as BridgeJournal;
      slow.begin = async (f, c) => {
        await sleep(60);
        return journal.begin(f, c);
      };
      const raw = wire();
      const p = new OfflineBridge(slow, terminal, fence).execute(raw, CTX);
      (raw.payload as Record<string, string>).lots = '99';
      raw.accountRef = encodeAccountRef('Other', '7');
      raw.expiresAt = '2030-01-01T00:00:00.000Z';
      expect((await p).kind).toBe('RESOLVED');
      const sent = terminal.invocations[0]?.command;
      expect(sent && 'lots' in sent.payload && sent.payload.lots).toBe('0.10');
      const rec = await journal.get(ACCOUNT, 'c1');
      expect(rec && payloadHash(rec.command)).toBe(rec?.payloadHash);
      expect(rec?.command.expiresAt).toBe('2026-10-05T10:00:30.000Z');
    });

    it('impossible calendar dates and invalid times are rejected before any write', async () => {
      for (const t of [
        '2026-02-30T10:00:00.000Z',
        '2025-02-29T10:00:00.000Z',
        '2026-04-31T10:00:00.000Z',
        '2026-13-01T10:00:00.000Z',
        '2026-01-01T24:00:00.000Z',
        '2026-01-01T10:60:00.000Z',
        '2026-01-01T10:00:60.000Z',
        '0000-01-01T10:00:00.000Z',
      ])
        expect(
          (await bridge.execute(wire({ issuedAt: t, expiresAt: '2030-01-01T00:00:00.000Z' }), CTX))
            .kind,
        ).toBe('INVALID');
      expect(
        (
          await bridge.execute(
            wire({ issuedAt: '2024-02-29T10:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z' }),
            rt(new Date('2026-10-05T10:00:10Z')),
          )
        ).kind,
      ).toBe('RESOLVED');
      expect(await count('bridge_command')).toBe(1);
    });

    it('oversized or non-plain inputs are bounded before heavy parsing', async () => {
      const big = 'x'.repeat(200_000);
      for (const bad of [
        wire({ accountRef: 'mt5:' + big }),
        wire({ payload: { orderId: '9'.repeat(50_000) }, op: 'CANCEL' }),
        wire({ commandId: big }),
        Object.assign(Object.create({ inherited: 1 }) as object, wire()),
      ])
        expect((await bridge.execute(bad, CTX)).kind).toBe('INVALID');
      expect(await count('bridge_command')).toBe(0);
    });

    it.each([
      ['an invalid (NaN) clock', () => rt(new Date(NaN))],
      ['entryPermitted undefined', () => rt(NOW, (() => undefined) as unknown as () => boolean)],
      ['entryPermitted truthy but not true', () => rt(NOW, (() => 1) as unknown as () => boolean)],
      [
        'entryPermitted throwing',
        () =>
          rt(NOW, () => {
            throw new Error('gate down');
          }),
      ],
      ['an issuedAt in the future', () => rt(new Date('2026-10-05T09:00:00.000Z'))],
    ])('entries are refused on %s and never sent', async (_n, mk) => {
      expect((await bridge.execute(wire(), mk())).kind).toBe('REFUSED');
      expect(terminal.invocations).toHaveLength(0);
      expect(await stateOf('c1')).toBe('REFUSED');
    });

    it('an entry that expires while the marker is waiting is not applied by the fake (boundary re-read); the committed marker stays conservative', async () => {
      let t = new Date('2026-10-05T10:00:10.000Z');
      const delayed: BridgeJournal = Object.create(journal) as BridgeJournal;
      delayed.markSendMayHaveStarted = async (...a) => {
        await sleep(40);
        t = new Date('2026-10-05T11:00:00.000Z'); // expiry passes DURING the wait
        return journal.markSendMayHaveStarted(...a);
      };
      const out = await new OfflineBridge(delayed, terminal, fence).execute(wire(), {
        clock: () => t,
        entryPermitted: () => true,
      });
      expect(terminal.effects).toHaveLength(0);
      expect(out.kind).toBe('UNKNOWN'); // marker committed at the instant it was read; the boundary re-read refuses
      expect(await stateOf('c1')).toBe('UNKNOWN');
    });

    it('permission revoked after the marker commits: the fake boundary refuses, no effect, state UNKNOWN and never resent', async () => {
      let allowed = true;
      const gate = () => allowed;
      const spy: BridgeTransport = {
        async invoke(c, f, b) {
          allowed = false; // revoked while the call is in flight
          return terminal.invoke(c, f, b);
        },
      };
      const out = await new OfflineBridge(journal, spy, fence).execute(wire(), rt(NOW, gate));
      expect(out.kind).toBe('UNKNOWN');
      expect(terminal.effects).toHaveLength(0);
      expect(await stateOf('c1')).toBe('UNKNOWN');
      expect((await bridge.execute(wire(), CTX)).kind).toBe('UNKNOWN');
      expect(terminal.invocations).toHaveLength(1);
    });

    it('reconcile-required set between the owner read and the marker blocks the ENTRY inside the atomic step but not a protective close', async () => {
      const racing: BridgeJournal = Object.create(journal) as BridgeJournal;
      const realOwner = journal.ownerState.bind(journal);
      racing.ownerState = async (a) => {
        const s = await realOwner(a);
        await db.sql`update bridge_owner set reconcile_required = true`; // flips right after the read
        return s;
      };
      const out = await new OfflineBridge(racing, terminal, fence).execute(wire(), CTX);
      expect(out).toEqual({ kind: 'REFUSED', reason: 'entry blocked at the marker' });
      expect(terminal.invocations).toHaveLength(0);
      await db.sql`update bridge_owner set reconcile_required = false`;
      await bridge.execute(close('p1'), CTX);
      expect(terminal.effects).toEqual(['p1']);
    });

    it('a result that cannot be persisted is reported UNKNOWN on the first call and on replay, never RESOLVED', async () => {
      const flaky: BridgeJournal = Object.create(journal) as BridgeJournal;
      flaky.recordResult = () => Promise.reject(new Error('connection lost'));
      const first = await new OfflineBridge(flaky, terminal, fence).execute(wire(), CTX);
      expect(first.kind).toBe('UNKNOWN');
      expect(await stateOf('c1')).toBe('SEND_MAY_HAVE_STARTED');
      expect((await bridge.execute(wire(), CTX)).kind).toBe('UNKNOWN');
      expect(terminal.invocations).toHaveLength(1);
    });

    it('a RESOLVED row with no stored result (corruption) replays as UNKNOWN, not a fabricated result', async () => {
      await bridge.execute(wire(), CTX);
      await db.sql`alter table bridge_command disable trigger bridge_command_guard`;
      await db.sql`update bridge_command set result = null`;
      await db.sql`alter table bridge_command enable trigger bridge_command_guard`;
      const again = await bridge.execute(wire(), CTX);
      expect(again).toMatchObject({
        kind: 'UNKNOWN',
        result: { note: 'corrupt: resolved without a result' },
      });
    });

    it('a delayed OLD writer is refused at the fake boundary after a DB takeover, before any new write', async () => {
      const oldTerminal = new FakeTerminal();
      const delayed: BridgeTransport = {
        async invoke(c, f, b) {
          await sleep(80);
          return oldTerminal.invoke(c, f, b);
        },
      };
      const p = new OfflineBridge(journal, delayed, fence).execute(wire(), CTX);
      await sleep(30);
      await journal.takeover(ACCOUNT, 'bridge-B', { oldWriterCannotAct: true, note: 'evidence' });
      const out = await p;
      expect(oldTerminal.effects).toHaveLength(0);
      expect(out.kind).toBe('UNKNOWN');
    });

    it('the same owner id and epoch number never authorises another account (fence is account-bound)', async () => {
      const other = encodeAccountRef('Demo-Server', '2');
      const fenceB = await journal.acquireOwner(other, 'bridge-A'); // same ownerId, same epoch '1'
      expect(fenceB.epoch).toBe(fence.epoch);
      expect(fenceB.ownerId).toBe(fence.ownerId);
      await expect(journal.begin(fence, cmd(wire({ accountRef: other })))).rejects.toMatchObject({
        code: 'LOST',
      });
      await expect(
        new OfflineBridge(journal, terminal, fence).execute(wire({ accountRef: other }), CTX),
      ).rejects.toMatchObject({ code: 'LOST' });
      expect(terminal.invocations).toHaveLength(0);
      // The fake refuses a mismatched fence too.
      const reply = await terminal.invoke(cmd(wire({ accountRef: other })), fence, {
        check: () => Promise.resolve({ ok: true }),
      });
      expect(reply).toEqual({ status: 'FENCED' });
      expect(terminal.effects).toHaveLength(0);
    });
  });
});
