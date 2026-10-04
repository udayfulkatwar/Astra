/**
 * M001 on a REAL PostgreSQL: corrective migration 0013 reconciles released reservations against the
 * STRONGER of the tombstone and the order record. Upgrades are exercised from a 0010-, 0011- and
 * 0012-applied database. Fake data only; no broker, no network.
 */
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import type { OrderRecord } from '@astra/execution';
import { createDb } from '../src/client';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../src/migrate';
import { ExecutionRepository } from '../src/repositories/execution';
import { TEST_DB_URL, dbAvailable } from './helpers';

const available = await dbAvailable();
const AT = '2026-09-28T14:00:05.000Z';
type Db = ReturnType<typeof createDb>;
type From = '0010' | '0011' | '0012';
const LIMIT: Record<From, string> = { '0010': '0011', '0011': '0012', '0012': '0013' };

async function upgradeFrom(applied: From, seed: (sql: Db) => Promise<void>) {
  const schema = `mig13_${applied}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = postgres(TEST_DB_URL, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`create schema ${schema}`);
  const sql = createDb({ url: TEST_DB_URL, schema, maxConnections: 2, applicationName: 'mig13' });
  const old = mkdtempSync(join(tmpdir(), 'astra-mig13-'));
  for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR))
    if (f < LIMIT[applied]) copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(old, f));
  await migrate(sql, old);
  await seed(sql);
  return {
    sql,
    store: new ExecutionRepository(sql),
    async done() {
      await sql.end({ timeout: 5 });
      await admin.unsafe(`drop schema if exists ${schema} cascade`);
      await admin.end();
    },
  };
}

let seq = 0;
interface Legacy {
  account: string;
  symbol: string;
  status: string; // the ORDER record
  qty: number;
  filled: number; // the ORDER record
  closed?: number[];
  tomb?: { released: string | null; status: string; filled: number; reserved?: number };
}
async function legacy(sql: Db, o: Legacy): Promise<string> {
  const id = `t${++seq}`;
  const cid = `astra-apr_${id}`;
  await sql`insert into trade_decisions (id, decided_at, account_id, strategy_id, signal_id, symbol, direction, mode, status,
              reasons, checks, sizing, order_plan, explanation, config_hash, inputs, approval_id, approval_expires_at, approval_state)
            values (${`d_${id}`}, now(), ${o.account}, 's', ${`sg_${id}`}, ${o.symbol}, 'LONG', 'PAPER', 'APPROVED', '[]', '[]', 'null',
                    'null', '{}', 'h', '{}', ${`apr_${id}`}, now(), 'CONSUMED')`;
  await sql`insert into orders (id, client_order_id, approval_id, decision_id, account_id, strategy_id, signal_id, adapter_id, mode,
              symbol, direction, quantity, entry_type, planned_entry, stop_loss, take_profit, status, filled_quantity, created_at, updated_at)
            values (${`o_${id}`}, ${cid}, ${`apr_${id}`}, ${`d_${id}`}, ${o.account}, 's', ${`sg_${id}`}, 'paper', 'PAPER',
                    ${o.symbol}, 'LONG', ${o.qty}, 'MARKET', 20000, 19990, 20030, ${o.status}, ${o.filled}, now(), now())`;
  const t = o.tomb;
  if (t)
    await sql`insert into exposure_reservations (id, account_id, client_order_id, approval_id, strategy_id, symbol, direction,
                entry, stop, target, quantity, reserved_quantity, filled_quantity, order_status, dispatched_at, reserved_at,
                released_at, release_reason)
              values (${`rsv_${id}`}, ${o.account}, ${cid}, ${`apr_${id}`}, 's', ${o.symbol}, 'LONG', 20000, 19990, 20030, ${o.qty},
                      ${t.reserved ?? t.filled}, ${t.filled}, ${t.status}, now(), now(),
                      ${t.released === null ? null : new Date()}, ${t.released})`;
  for (const [i, q] of (o.closed ?? []).entries())
    await sql`insert into closed_trades (id, account_id, client_order_id, symbol, direction, quantity, entry_price, exit_price,
                exit_reason, realized_pnl, opened_at, closed_at)
              values (${`ct_${id}_${i}`}, ${o.account}, ${cid}, ${o.symbol}, 'LONG', ${q}, 1, 1, 'STOP', 0, now(), now())`;
  return cid;
}

async function newEntry(sql: Db, store: ExecutionRepository, account: string, symbol: string) {
  const id = `new${++seq}`;
  await sql`insert into trade_decisions (id, decided_at, account_id, strategy_id, signal_id, symbol, direction, mode, status,
              reasons, checks, sizing, order_plan, explanation, config_hash, inputs, approval_id, approval_expires_at, approval_state)
            values (${`d_${id}`}, now(), ${account}, 's', ${`sg_${id}`}, ${symbol}, 'LONG', 'PAPER', 'APPROVED', '[]', '[]', 'null',
                    'null', '{}', 'h', '{}', ${`apr_${id}`}, '2026-09-28T15:00:00Z', 'PENDING')`;
  const order: OrderRecord = {
    orderId: `o_${id}`,
    clientOrderId: `astra-apr_${id}`,
    approvalId: `apr_${id}`,
    decisionId: `d_${id}`,
    accountId: account,
    strategyId: 's',
    signalId: `sg_${id}`,
    adapterId: 'paper',
    mode: 'PAPER',
    symbol,
    direction: 'LONG',
    quantity: 1,
    entryType: 'MARKET',
    plannedEntry: 20_000,
    stopLoss: 19_990,
    takeProfit: 20_030,
    status: 'PENDING_SUBMIT',
    brokerOrderId: null,
    filledQuantity: 0,
    averageFillPrice: null,
    rejectReason: null,
    expiresAt: null,
    createdAt: AT,
    updatedAt: AT,
  };
  const v = (await store.accountExposure(account)).version;
  return store.reserveAndConsume({ order, expectedVersion: v, at: AT, intent: {} });
}

const PREMATURE = 'prior candidate: flat snapshot';
const NOTHING = 'broker REJECTED with nothing filled';

describe.skipIf(!available)('migration 0013: stronger tombstone evidence quarantines', () => {
  for (const from of ['0010', '0011', '0012'] as const) {
    it(`upgrade from ${from}: both contradictions quarantine durably, evidence is kept, controls stay closed`, async () => {
      let ids: Record<string, string> = {};
      const h = await upgradeFrom(from, async (sql) => {
        ids = {
          // (1) tombstone FILLED/3, order overwritten CANCELLED/0, closed 1
          cancelled0: await legacy(sql, {
            account: 'acct-1',
            symbol: 'NQ',
            status: 'CANCELLED',
            qty: 3,
            filled: 0,
            closed: [1],
            tomb: { released: PREMATURE, status: 'FILLED', filled: 3 },
          }),
          // (2) tombstone FILLED/3, order overwritten FILLED/1, closed 1
          filled1: await legacy(sql, {
            account: 'acct-2',
            symbol: 'NQ',
            status: 'FILLED',
            qty: 3,
            filled: 1,
            closed: [1],
            tomb: { released: PREMATURE, status: 'FILLED', filled: 3 },
          }),
          // (1) again, with a newer same-symbol ACTIVE reservation on the account
          collidedTomb: await legacy(sql, {
            account: 'acct-3',
            symbol: 'ES',
            status: 'CANCELLED',
            qty: 3,
            filled: 0,
            closed: [1],
            tomb: { released: PREMATURE, status: 'FILLED', filled: 3 },
          }),
          collidedActive: await legacy(sql, {
            account: 'acct-3',
            symbol: 'ES',
            status: 'ACCEPTED',
            qty: 1,
            filled: 0,
            tomb: { released: null, status: 'ACCEPTED', filled: 0, reserved: 1 },
          }),
          // control: consistent and fully closed (also with a weaker order record, covered by closures)
          closed: await legacy(sql, {
            account: 'acct-4',
            symbol: 'YM',
            status: 'FILLED',
            qty: 2,
            filled: 2,
            closed: [1, 1],
            tomb: {
              released: 'closures recorded for this order cover its cumulative fill (2 of 2)',
              status: 'FILLED',
              filled: 2,
            },
          }),
          closedWeakerOrder: await legacy(sql, {
            account: 'acct-5',
            symbol: 'YM',
            status: 'CANCELLED',
            qty: 3,
            filled: 0,
            closed: [1, 2],
            tomb: {
              released: 'closures recorded for this order cover its cumulative fill (3 of 3)',
              status: 'FILLED',
              filled: 3,
            },
          }),
          // control: clean rejection, nothing filled anywhere
          rejected: await legacy(sql, {
            account: 'acct-6',
            symbol: 'CL',
            status: 'REJECTED',
            qty: 1,
            filled: 0,
            tomb: { released: NOTHING, status: 'REJECTED', filled: 0, reserved: 0 },
          }),
          // UNKNOWN tombstone with zero recorded fills: release is not proof of no fill
          unknownTomb: await legacy(sql, {
            account: 'acct-7',
            symbol: 'GC',
            status: 'REJECTED',
            qty: 1,
            filled: 0,
            tomb: { released: NOTHING, status: 'UNKNOWN', filled: 0, reserved: 0 },
          }),
          // FILLED tombstone with no recorded fill: unknown size
          filledNoFill: await legacy(sql, {
            account: 'acct-8',
            symbol: 'GC',
            status: 'FILLED',
            qty: 2,
            filled: 0,
            tomb: { released: PREMATURE, status: 'FILLED', filled: 0, reserved: 2 },
          }),
          // already contradictory for 0012 AND 0013: exactly one active quarantine row remains
          both: await legacy(sql, {
            account: 'acct-9',
            symbol: 'ES',
            status: 'FILLED',
            qty: 3,
            filled: 1,
            tomb: { released: NOTHING, status: 'FILLED', filled: 3 },
          }),
        };
      });
      try {
        const tombBefore =
          await h.sql`select * from exposure_reservations where released_at is not null order by id`;
        const orderBefore =
          await h.sql`select client_order_id, status, filled_quantity from orders order by id`;
        await migrate(h.sql);

        const q = async (a: string) => (await h.store.accountExposure(a)).quarantines;
        for (const [acct, key] of [
          ['acct-1', 'cancelled0'],
          ['acct-2', 'filled1'],
          ['acct-3', 'collidedTomb'],
          ['acct-7', 'unknownTomb'],
          ['acct-8', 'filledNoFill'],
          ['acct-9', 'both'],
        ] as const) {
          const qs = await q(acct);
          expect
            .soft(
              qs.map((x) => x.clientOrderId),
              `${acct}/${key}`,
            )
            .toEqual([ids[key]]);
        }
        for (const acct of ['acct-4', 'acct-5', 'acct-6'])
          expect(await q(acct), acct).toHaveLength(0);

        // Evidence is preserved: every released tombstone and every order record is unchanged.
        const tombAfter =
          await h.sql`select * from exposure_reservations where released_at is not null order by id`;
        expect(tombAfter).toEqual(tombBefore);
        const orderAfter =
          await h.sql`select client_order_id, status, filled_quantity from orders order by id`;
        expect(orderAfter).toEqual(orderBefore);
        const t3 = tombAfter.find((t) => t.client_order_id === ids.cancelled0);
        expect(Number(t3?.filled_quantity)).toBe(3); // the stronger evidence never decreases

        // The quarantine records both evidence rows.
        const ev = (await q('acct-1'))[0]!;
        expect(ev.reason).toMatch(/tombstone FILLED filled 3, order CANCELLED filled 0, closed 1/);
        const row = (
          await h.sql<{ evidence: Record<string, unknown> }[]>`
          select evidence from exposure_quarantines where client_order_id = ${ids.cancelled0!}`
        )[0]!;
        expect(row.evidence).toMatchObject({
          tombstone: { orderStatus: 'FILLED', filledQuantity: 3 },
          order: { status: 'CANCELLED', filledQuantity: 0 },
          closed: 1,
        });
        expect((await h.store.orderEvents(ids.cancelled0!)).map((x) => x.type)).toContain(
          'TOMBSTONE_CONTRADICTION_QUARANTINED',
        );

        // A newer same-symbol active reservation is intact.
        const e3 = await h.store.accountExposure('acct-3');
        expect(e3.reservations.map((r) => r.clientOrderId)).toEqual([ids.collidedActive]);
        expect(e3.reservations[0]).toMatchObject({ orderStatus: 'ACCEPTED', reservedQuantity: 1 });

        // Durable refusal: no new entry on any quarantined account; controls still admit.
        for (const [acct, sym] of [
          ['acct-1', 'RTY'],
          ['acct-2', 'RTY'],
          ['acct-3', 'RTY'],
          ['acct-7', 'RTY'],
          ['acct-8', 'RTY'],
          ['acct-9', 'RTY'],
        ] as const) {
          expect(await newEntry(h.sql, h.store, acct, sym), acct).toMatchObject({
            ok: false,
            code: 'ACCOUNT_QUARANTINED',
          });
        }
        for (const acct of ['acct-4', 'acct-5', 'acct-6'])
          expect(await newEntry(h.sql, h.store, acct, 'RTY'), acct).toEqual({ ok: true });

        // Repeat startup/migration, and re-running the 0013 statements themselves, change nothing.
        const snapshot = async () => ({
          quarantines:
            await h.sql`select id, account_id, client_order_id, reason, evidence from exposure_quarantines order by id`,
          ledger:
            await h.sql`select account_id, version from account_exposure_ledger order by account_id`,
          events:
            await h.sql`select client_order_id, type from order_events order by client_order_id, type`,
        });
        const before = await snapshot();
        expect((await migrate(h.sql)).applied).toEqual([]);
        await h.sql.begin(async (tx) => {
          await tx.unsafe(
            readFileSync(
              join(DEFAULT_MIGRATIONS_DIR, '0013_tombstone_conservative_quarantine.sql'),
              'utf8',
            ),
          );
        });
        expect(await snapshot()).toEqual(before);
        const active =
          await h.sql`select count(*)::int as n from exposure_quarantines where client_order_id = ${ids.both!} and cleared_at is null`;
        expect(active[0]?.n).toBe(1);
      } finally {
        await h.done();
      }
    });
  }
});
