/** Account tracking state, snapshot history, closed trades and activity (from ASTRA's records). */
import type { AccountActivity, AccountSnapshot, Direction } from '@astra/core';
import {
  AccountTrackingSchema,
  mergeAccountTracking,
  type AccountState,
  type AccountTracking,
} from '@astra/prop-firm';
import type { Sql } from '../client';
import { iso, jsonb } from '../client';

export interface ClosedTradeRecord {
  readonly id: string;
  readonly accountId: string;
  readonly clientOrderId: string | null;
  readonly symbol: string;
  readonly direction: Direction;
  readonly quantity: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly exitReason: string;
  readonly realizedPnl: number;
  readonly openedAt: string;
  readonly closedAt: string;
}

/** Order statuses that count as a trade taken (transmitted or recorded in SHADOW). */
const COUNTED = [
  'PENDING_SUBMIT',
  'SUBMITTED',
  'ACCEPTED',
  'PARTIALLY_FILLED',
  'FILLED',
  'SHADOW',
  'UNKNOWN',
];

export class AccountRepository {
  constructor(private readonly sql: Sql) {}

  async getTracking(accountId: string): Promise<AccountTracking | null> {
    const rows = await this.sql<
      { state: unknown }[]
    >`select state from account_tracking where account_id = ${accountId}`;
    return rows[0] ? AccountTrackingSchema.parse(rows[0].state) : null;
  }

  /**
   * Persists tracking MONOTONICALLY: under a row lock the incoming state is merged with whatever
   * is stored (another process may have written newer data), so peaks never decrease and an older
   * observation never replaces a newer one. Returns the state now stored.
   */
  async saveTracking(t: AccountTracking): Promise<AccountTracking> {
    return this.sql.begin(async (tx) => {
      await tx`
        insert into account_tracking (account_id, state, updated_at)
        values (${t.accountId}, ${jsonb(tx, t)}, ${t.updatedAt})
        on conflict (account_id) do nothing`;
      const rows = await tx<{ state: unknown }[]>`
        select state from account_tracking where account_id = ${t.accountId} for update`;
      const merged = mergeAccountTracking(AccountTrackingSchema.parse(rows[0]!.state), t);
      await tx`
        update account_tracking set state = ${jsonb(tx, merged)}, updated_at = ${merged.updatedAt}
         where account_id = ${t.accountId}`;
      return merged;
    });
  }

  async appendSnapshot(
    snapshot: AccountSnapshot,
    state: AccountState | null,
    health: string | null,
    recordedAt: string,
  ): Promise<void> {
    await this.sql`
      insert into account_snapshots (account_id, as_of, snapshot, state, health, recorded_at)
      values (${snapshot.accountId}, ${snapshot.asOf}, ${jsonb(this.sql, snapshot)}, ${jsonb(this.sql, state)}, ${health}, ${recordedAt})`;
  }

  async latestSnapshot(accountId: string): Promise<{
    snapshot: AccountSnapshot;
    state: AccountState | null;
    health: string | null;
    recordedAt: string;
  } | null> {
    const rows = await this.sql<
      {
        snapshot: AccountSnapshot;
        state: AccountState | null;
        health: string | null;
        recorded_at: Date;
      }[]
    >`
      select snapshot, state, health, recorded_at from account_snapshots
       where account_id = ${accountId} order by as_of desc, seq desc limit 1`;
    const r = rows[0];
    return r
      ? { snapshot: r.snapshot, state: r.state, health: r.health, recordedAt: iso(r.recorded_at)! }
      : null;
  }

  /** Idempotent: re-recording the same trade id is a no-op. Returns true if newly recorded. */
  async recordClosedTrade(t: ClosedTradeRecord): Promise<boolean> {
    const rows = await this.sql`
      insert into closed_trades (id, account_id, client_order_id, symbol, direction, quantity, entry_price,
        exit_price, exit_reason, realized_pnl, opened_at, closed_at)
      values (${t.id}, ${t.accountId}, ${t.clientOrderId}, ${t.symbol}, ${t.direction}, ${t.quantity},
        ${t.entryPrice}, ${t.exitPrice}, ${t.exitReason}, ${t.realizedPnl}, ${t.openedAt}, ${t.closedAt})
      on conflict (id) do nothing
      returning id`;
    return rows.length > 0;
  }

  async closedTrades(accountId: string, limit = 50): Promise<ClosedTradeRecord[]> {
    const rows = await this.sql<
      {
        id: string;
        account_id: string;
        client_order_id: string | null;
        symbol: string;
        direction: Direction;
        quantity: string;
        entry_price: string;
        exit_price: string;
        exit_reason: string;
        realized_pnl: string;
        opened_at: Date;
        closed_at: Date;
      }[]
    >`select * from closed_trades where account_id = ${accountId} order by closed_at desc limit ${limit}`;
    return rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      clientOrderId: r.client_order_id,
      symbol: r.symbol,
      direction: r.direction,
      quantity: Number(r.quantity),
      entryPrice: Number(r.entry_price),
      exitPrice: Number(r.exit_price),
      exitReason: r.exit_reason,
      realizedPnl: Number(r.realized_pnl),
      openedAt: iso(r.opened_at)!,
      closedAt: iso(r.closed_at)!,
    }));
  }

  /**
   * Trades taken in the trading-day window and the current losing streak within that window
   * (owner decision 2026-09-28: the streak starts fresh at each trading-day reset).
   */
  async activity(
    accountId: string,
    window: { key: string; start: string; end: string },
  ): Promise<AccountActivity> {
    const bySymbol = await this.sql<{ symbol: string; n: string }[]>`
      select symbol, count(*) as n from orders
       where account_id = ${accountId} and created_at >= ${window.start} and created_at < ${window.end}
         and status in ${this.sql(COUNTED)}
       group by symbol`;
    const entriesBySymbol = Object.fromEntries(bySymbol.map((r) => [r.symbol, Number(r.n)]));
    // Net R of today's journaled trades, most recent first (journal R is null when unknown).
    const journaled = await this.sql<{ r: string | null }[]>`
      select entry->'result'->>'rMultiple' as r from trade_journal
       where account_id = ${accountId} and closed_at >= ${window.start} and closed_at < ${window.end}
       order by closed_at desc limit 100`;
    const recent = await this.sql<{ realized_pnl: string }[]>`
      select realized_pnl from closed_trades
       where account_id = ${accountId} and closed_at >= ${window.start} and closed_at < ${window.end}
       order by closed_at desc limit 100`;
    let streak = 0;
    for (const r of recent) {
      if (Number(r.realized_pnl) < 0) streak++;
      else break;
    }
    return {
      tradingDayKey: window.key,
      tradesToday: Object.values(entriesBySymbol).reduce((a, b) => a + b, 0),
      consecutiveLosses: streak,
      entriesBySymbol,
      // A trade closed but not yet journaled has an unknown R (it is the most recent).
      closedTodayR: [
        ...Array<null>(Math.max(0, recent.length - journaled.length)).fill(null),
        ...journaled.map((j) => (j.r === null ? null : Number(j.r))),
      ],
    };
  }
}
