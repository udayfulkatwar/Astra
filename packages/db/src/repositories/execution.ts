/** ExecutionStore backed by PostgreSQL. Uniqueness is enforced by the schema, not by hope. */
import { AstraError, type Direction, type EntryType, type TradingMode } from '@astra/core';
import type { ApprovedOrderPlan } from '@astra/decision';
import { applyOrderState, confirmedClosures } from '@astra/execution';
import type {
  AccountExposure,
  ApprovalRecord,
  ApprovalState,
  BrokerOrderState,
  ExecutionStore,
  ExposureReservation,
  OrderEvent,
  OrderRecord,
  OrderStatus,
  OrderUpdateResult,
  ReserveResult,
} from '@astra/execution';
import type { Queryable, Sql } from '../client';
import { iso, jsonb, num } from '../client';
import { appendAuditInTx } from './audit';

interface OrderRow {
  id: string;
  client_order_id: string;
  approval_id: string;
  decision_id: string;
  account_id: string;
  strategy_id: string;
  signal_id: string;
  adapter_id: string | null;
  mode: TradingMode;
  symbol: string;
  direction: Direction;
  quantity: string;
  entry_type: EntryType;
  planned_entry: string;
  stop_loss: string;
  take_profit: string;
  status: OrderStatus;
  broker_order_id: string | null;
  filled_quantity: string;
  average_fill_price: string | null;
  reject_reason: string | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapOrder(r: OrderRow): OrderRecord {
  return {
    orderId: r.id,
    clientOrderId: r.client_order_id,
    approvalId: r.approval_id,
    decisionId: r.decision_id,
    accountId: r.account_id,
    strategyId: r.strategy_id,
    signalId: r.signal_id,
    adapterId: r.adapter_id,
    mode: r.mode,
    symbol: r.symbol,
    direction: r.direction,
    quantity: Number(r.quantity),
    entryType: r.entry_type,
    plannedEntry: Number(r.planned_entry),
    stopLoss: Number(r.stop_loss),
    takeProfit: Number(r.take_profit),
    status: r.status,
    brokerOrderId: r.broker_order_id,
    filledQuantity: Number(r.filled_quantity),
    averageFillPrice: num(r.average_fill_price),
    rejectReason: r.reject_reason,
    expiresAt: iso(r.expires_at),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

interface ReservationRow {
  id: string;
  account_id: string;
  client_order_id: string;
  approval_id: string;
  strategy_id: string;
  symbol: string;
  direction: Direction;
  entry: string;
  stop: string;
  target: string;
  quantity: string;
  reserved_quantity: string;
  filled_quantity: string;
  average_fill_price: string | null;
  order_status: OrderStatus;
  dispatched_at: Date | null;
  reserved_at: Date;
}

function mapReservation(r: ReservationRow): ExposureReservation {
  return {
    reservationId: r.id,
    accountId: r.account_id,
    clientOrderId: r.client_order_id,
    approvalId: r.approval_id,
    strategyId: r.strategy_id,
    symbol: r.symbol,
    direction: r.direction,
    entry: Number(r.entry),
    stop: Number(r.stop),
    target: Number(r.target),
    quantity: Number(r.quantity),
    reservedQuantity: Number(r.reserved_quantity),
    filledQuantity: Number(r.filled_quantity),
    averageFillPrice: num(r.average_fill_price),
    orderStatus: r.order_status,
    dispatched: r.dispatched_at !== null,
    reservedAt: iso(r.reserved_at)!,
  };
}

const TERMINAL = ['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'SHADOW'];

/**
 * Serialisation point of an account's exposure across every process sharing this database: the
 * ledger row lock. Always taken BEFORE any order/reservation row lock (fixed order → no deadlock).
 * Returns the ledger version.
 */
async function lockLedger(tx: Queryable, accountId: string, at: string): Promise<number> {
  await tx`
    insert into account_exposure_ledger (account_id, version, updated_at)
    values (${accountId}, 0, ${at}) on conflict (account_id) do nothing`;
  const rows = await tx<{ version: string }[]>`
    select version from account_exposure_ledger where account_id = ${accountId} for update`;
  return Number(rows[0]!.version);
}

async function bumpLedger(tx: Queryable, accountId: string, at: string): Promise<void> {
  await tx`
    update account_exposure_ledger set version = version + 1, updated_at = ${at}
     where account_id = ${accountId}`;
}

async function accountOf(tx: Queryable, clientOrderId: string): Promise<string> {
  const rows = await tx<{ account_id: string }[]>`
    select account_id from orders where client_order_id = ${clientOrderId}`;
  if (!rows[0]) throw new AstraError('NOT_FOUND', `order ${clientOrderId} not found`);
  return rows[0].account_id;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

async function transitionApprovalInTx(
  tx: Queryable,
  approvalId: string,
  to: Exclude<ApprovalState, 'PENDING'>,
  at: string,
): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    update trade_decisions set approval_state = ${to}, approval_state_changed_at = ${at}
     where approval_id = ${approvalId} and approval_state = 'PENDING'
    returning id`;
  if (rows.length === 0) return false;
  await appendAuditInTx(tx, {
    actor: { type: 'SYSTEM', id: 'execution-gateway' },
    category: 'EXECUTION',
    action: `APPROVAL_${to}`,
    entityType: 'trade_decision',
    entityId: rows[0]!.id,
    payload: { approvalId, to },
    at,
  });
  return true;
}

async function insertOrderInTx(tx: Queryable, o: OrderRecord): Promise<void> {
  await tx`
    insert into orders (id, client_order_id, approval_id, decision_id, account_id, strategy_id, signal_id,
      adapter_id, mode, symbol, direction, quantity, entry_type, planned_entry, stop_loss, take_profit,
      status, broker_order_id, filled_quantity, average_fill_price, reject_reason, expires_at, created_at, updated_at)
    values (${o.orderId}, ${o.clientOrderId}, ${o.approvalId}, ${o.decisionId}, ${o.accountId}, ${o.strategyId},
      ${o.signalId}, ${o.adapterId}, ${o.mode}, ${o.symbol}, ${o.direction}, ${o.quantity}, ${o.entryType},
      ${o.plannedEntry}, ${o.stopLoss}, ${o.takeProfit}, ${o.status}, ${o.brokerOrderId}, ${o.filledQuantity},
      ${o.averageFillPrice}, ${o.rejectReason}, ${o.expiresAt}, ${o.createdAt}, ${o.updatedAt})`;
  await appendAuditInTx(tx, {
    actor: { type: 'SYSTEM', id: 'execution-gateway' },
    category: 'EXECUTION',
    action: 'ORDER_CREATED',
    entityType: 'order',
    entityId: o.clientOrderId,
    payload: { ...o },
    at: o.createdAt,
  });
}

export class ExecutionRepository implements ExecutionStore {
  constructor(private readonly sql: Sql) {}

  async getApproval(approvalId: string): Promise<ApprovalRecord | null> {
    const rows = await this.sql<
      {
        id: string;
        account_id: string;
        strategy_id: string;
        signal_id: string;
        mode: TradingMode;
        order_plan: ApprovedOrderPlan;
        approval_id: string;
        approval_expires_at: Date;
        approval_state: ApprovalState;
      }[]
    >`
      select id, account_id, strategy_id, signal_id, mode, order_plan, approval_id, approval_expires_at, approval_state
        from trade_decisions where approval_id = ${approvalId} and status = 'APPROVED'`;
    const r = rows[0];
    if (!r) return null;
    return {
      approvalId: r.approval_id,
      decisionId: r.id,
      accountId: r.account_id,
      strategyId: r.strategy_id,
      signalId: r.signal_id,
      mode: r.mode,
      orderPlan: r.order_plan,
      expiresAt: iso(r.approval_expires_at)!,
      state: r.approval_state,
    };
  }

  async transitionApproval(
    approvalId: string,
    to: Exclude<ApprovalState, 'PENDING'>,
    at: string,
  ): Promise<boolean> {
    return this.sql.begin((tx) => transitionApprovalInTx(tx, approvalId, to, at));
  }

  async createOrder(o: OrderRecord): Promise<void> {
    try {
      await this.sql.begin((tx) => insertOrderInTx(tx, o));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AstraError('CONFLICT', `an order already exists for approval ${o.approvalId}`);
      }
      throw err;
    }
  }

  async updateOrder(clientOrderId: string, s: BrokerOrderState): Promise<OrderUpdateResult> {
    return this.sql.begin(async (tx) => {
      const accountId = await accountOf(tx, clientOrderId);
      await lockLedger(tx, accountId, s.updatedAt);
      const rows = await tx<ReservationRow[]>`
        select * from exposure_reservations where client_order_id = ${clientOrderId} and released_at is null for update`;
      const u = rows[0] ? applyOrderState(mapReservation(rows[0]), s) : null;
      const status = u ? u.orderStatus : s.status;
      const filled = u ? u.filledQuantity : s.filledQuantity;
      const avg = u ? u.averageFillPrice : s.averageFillPrice;
      const reason = u?.contradiction
        ? `contradictory broker evidence: ${u.contradiction}`
        : s.rejectReason;
      await tx`
        update orders set status = ${status}, broker_order_id = coalesce(${s.brokerOrderId}, broker_order_id),
               filled_quantity = ${filled}, average_fill_price = ${avg},
               reject_reason = ${reason}, updated_at = ${s.updatedAt}
         where client_order_id = ${clientOrderId}`;
      if (!u) return { contradiction: null };
      await tx`
        update exposure_reservations
           set reserved_quantity = ${u.reservedQuantity}, filled_quantity = ${u.filledQuantity},
               average_fill_price = ${u.averageFillPrice}, order_status = ${u.orderStatus},
               released_at = ${u.release ? s.updatedAt : null}, release_reason = ${u.release}
         where client_order_id = ${clientOrderId}`;
      if (u.contradiction)
        await tx`
          insert into order_events (client_order_id, at, type, detail)
          values (${clientOrderId}, ${s.updatedAt}, 'STATE_CONTRADICTORY',
                  ${jsonb(tx, { reason: u.contradiction, incoming: { ...s } })})`;
      await bumpLedger(tx, accountId, s.updatedAt);
      return { contradiction: u.contradiction };
    });
  }

  async appendOrderEvent(e: OrderEvent): Promise<void> {
    await this.sql`
      insert into order_events (client_order_id, at, type, detail)
      values (${e.clientOrderId}, ${e.at}, ${e.type}, ${jsonb(this.sql, e.detail)})`;
  }

  async workingOrders(accountId: string, symbol: string): Promise<OrderRecord[]> {
    const rows = await this.sql<OrderRow[]>`
      select * from orders where account_id = ${accountId} and symbol = ${symbol}
         and status not in ${this.sql(TERMINAL)}`;
    return rows.map(mapOrder);
  }

  async accountExposure(accountId: string): Promise<AccountExposure> {
    return this.sql.begin('isolation level repeatable read read only', async (tx) => {
      const ledger = await tx<{ version: string }[]>`
        select version from account_exposure_ledger where account_id = ${accountId}`;
      const rows = await tx<ReservationRow[]>`
        select * from exposure_reservations where account_id = ${accountId} and released_at is null
         order by reserved_at`;
      return {
        accountId,
        version: ledger[0] ? Number(ledger[0].version) : 0,
        reservations: rows.map(mapReservation),
      };
    });
  }

  async reserveAndConsume(req: {
    order: OrderRecord;
    expectedVersion: number;
    at: string;
    intent: Record<string, unknown>;
  }): Promise<ReserveResult> {
    const { order: o, at } = req;
    const refuse = (code: Exclude<ReserveResult, { ok: true }>['code'], reason: string) =>
      ({ ok: false, code, reason }) as const;
    try {
      return await this.sql.begin(async (tx): Promise<ReserveResult> => {
        const version = await lockLedger(tx, o.accountId, at);
        if (version !== req.expectedVersion)
          return refuse(
            'LEDGER_CHANGED',
            'account exposure changed while the order was being validated',
          );
        const approvals = await tx<{ approval_state: string; approval_expires_at: Date }[]>`
          select approval_state, approval_expires_at from trade_decisions
           where approval_id = ${o.approvalId} for update`;
        const a = approvals[0];
        if (!a || a.approval_state !== 'PENDING')
          return refuse(
            'APPROVAL_NOT_PENDING',
            'approval already consumed (duplicate execution prevented)',
          );
        if (!(Date.parse(at) < a.approval_expires_at.getTime()))
          return refuse('APPROVAL_EXPIRED', `approval expired at ${iso(a.approval_expires_at)}`);
        const held = await tx<{ client_order_id: string }[]>`
          select client_order_id from exposure_reservations
           where account_id = ${o.accountId} and symbol = ${o.symbol} and released_at is null`;
        if (held[0])
          return refuse(
            'SYMBOL_EXPOSED',
            `${o.symbol} already has reserved exposure (${held[0].client_order_id})`,
          );
        await transitionApprovalInTx(tx, o.approvalId, 'CONSUMED', at);
        await insertOrderInTx(tx, o);
        await tx`
          insert into exposure_reservations (id, account_id, client_order_id, approval_id, strategy_id, symbol,
            direction, entry, stop, target, quantity, reserved_quantity, filled_quantity, order_status, reserved_at)
          values (${`rsv_${o.orderId}`}, ${o.accountId}, ${o.clientOrderId}, ${o.approvalId}, ${o.strategyId},
            ${o.symbol}, ${o.direction}, ${o.plannedEntry}, ${o.stopLoss}, ${o.takeProfit}, ${o.quantity},
            ${o.quantity}, 0, ${o.status}, ${at})`;
        await tx`
          insert into order_events (client_order_id, at, type, detail)
          values (${o.clientOrderId}, ${at}, 'SUBMIT_REQUESTED', ${jsonb(tx, req.intent)})`;
        await appendAuditInTx(tx, {
          actor: { type: 'SYSTEM', id: 'execution-gateway' },
          category: 'EXECUTION',
          action: 'EXPOSURE_RESERVED',
          entityType: 'order',
          entityId: o.clientOrderId,
          payload: {
            accountId: o.accountId,
            symbol: o.symbol,
            quantity: o.quantity,
            ledgerVersion: version + 1,
          },
          at,
        });
        await bumpLedger(tx, o.accountId, at);
        return { ok: true };
      });
    } catch (err) {
      if (isUniqueViolation(err))
        return refuse('DUPLICATE_ORDER', `an order already exists for approval ${o.approvalId}`);
      throw err;
    }
  }

  async markDispatching(clientOrderId: string, at: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const accountId = await accountOf(tx, clientOrderId);
      await lockLedger(tx, accountId, at);
      const rows = await tx`
        update exposure_reservations set dispatched_at = ${at}
         where client_order_id = ${clientOrderId} and released_at is null returning id`;
      if (rows.length === 0)
        throw new AstraError(
          'CONFLICT',
          `no active reservation for ${clientOrderId}: not dispatching`,
        );
      await tx`
        insert into order_events (client_order_id, at, type, detail)
        values (${clientOrderId}, ${at}, 'SUBMIT_DISPATCHING', ${jsonb(tx, {})})`;
      await bumpLedger(tx, accountId, at);
    });
  }

  async releaseUntransmitted(
    clientOrderId: string,
    reason: string,
    at: string,
    opts: { onlyIfUndispatched?: boolean } = {},
  ): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const accountId = await accountOf(tx, clientOrderId);
      await lockLedger(tx, accountId, at);
      const only = opts.onlyIfUndispatched === true;
      const rows = await tx`
        update exposure_reservations set released_at = ${at}, release_reason = ${`not transmitted: ${reason}`}
         where client_order_id = ${clientOrderId} and released_at is null
           and (${only} = false or dispatched_at is null)
        returning id`;
      if (rows.length === 0) return false;
      await tx`
        update orders set status = 'REJECTED', reject_reason = ${reason}, updated_at = ${at}
         where client_order_id = ${clientOrderId}`;
      await tx`
        insert into order_events (client_order_id, at, type, detail)
        values (${clientOrderId}, ${at}, 'NOT_TRANSMITTED', ${jsonb(tx, { reason })})`;
      await appendAuditInTx(tx, {
        actor: { type: 'SYSTEM', id: 'execution-gateway' },
        category: 'EXECUTION',
        action: 'EXPOSURE_RELEASED_UNTRANSMITTED',
        entityType: 'order',
        entityId: clientOrderId,
        payload: { reason },
        at,
      });
      await bumpLedger(tx, accountId, at);
      return true;
    });
  }

  async reconcileReservations(accountId: string, at: string): Promise<number> {
    return this.sql.begin(async (tx) => {
      await lockLedger(tx, accountId, at);
      const rows = await tx<ReservationRow[]>`
        select * from exposure_reservations where account_id = ${accountId} and released_at is null`;
      const active = rows.map(mapReservation);
      const ids = active.map((r) => r.clientOrderId);
      const closed =
        ids.length === 0
          ? []
          : await tx<{ client_order_id: string; closed: string }[]>`
              select client_order_id, sum(quantity) as closed from closed_trades
               where account_id = ${accountId} and client_order_id in ${tx(ids)}
               group by client_order_id`;
      const done = confirmedClosures(
        active,
        new Map(closed.map((c) => [c.client_order_id, Number(c.closed)])),
      );
      for (const t of done) {
        await tx`
          update exposure_reservations set released_at = ${at}, release_reason = ${t.reason}
           where client_order_id = ${t.reservation.clientOrderId}`;
        await appendAuditInTx(tx, {
          actor: { type: 'SYSTEM', id: 'execution-gateway' },
          category: 'EXECUTION',
          action: 'EXPOSURE_RELEASED',
          entityType: 'order',
          entityId: t.reservation.clientOrderId,
          payload: { reason: t.reason, symbol: t.reservation.symbol },
          at,
        });
      }
      if (done.length > 0) await bumpLedger(tx, accountId, at);
      return done.length;
    });
  }

  async recordRejection(req: {
    approvalId: string;
    accountId: string | null;
    reasons: readonly string[];
    at: string;
  }): Promise<void> {
    await this.sql.begin((tx) =>
      appendAuditInTx(tx, {
        actor: { type: 'SYSTEM', id: 'execution-gateway' },
        category: 'EXECUTION',
        action: 'EXECUTION_REFUSED',
        entityType: 'approval',
        entityId: req.approvalId,
        payload: { accountId: req.accountId, reasons: [...req.reasons], transmitted: false },
        at: req.at,
      }),
    );
  }

  /** Every non-terminal order of an account (startup reconciliation). */
  async workingOrdersForAccount(accountId: string): Promise<OrderRecord[]> {
    const rows = await this.sql<OrderRow[]>`
      select * from orders where account_id = ${accountId} and status not in ${this.sql(TERMINAL)}`;
    return rows.map(mapOrder);
  }

  /** Orders placed for a signal (one per account that approved it). */
  async ordersForSignal(signalId: string): Promise<OrderRecord[]> {
    const rows = await this.sql<OrderRow[]>`
      select * from orders where signal_id = ${signalId} order by created_at`;
    return rows.map(mapOrder);
  }

  async orderByClientId(clientOrderId: string): Promise<OrderRecord | null> {
    const rows = await this.sql<OrderRow[]>`
      select * from orders where client_order_id = ${clientOrderId}`;
    return rows[0] ? mapOrder(rows[0]) : null;
  }

  async listOrders(params: { accountId?: string; limit?: number } = {}): Promise<OrderRecord[]> {
    const rows = await this.sql<OrderRow[]>`
      select * from orders where (${params.accountId ?? null}::text is null or account_id = ${params.accountId ?? null})
      order by created_at desc limit ${Math.min(params.limit ?? 50, 200)}`;
    return rows.map(mapOrder);
  }

  async orderEvents(clientOrderId: string): Promise<OrderEvent[]> {
    const rows = await this.sql<
      { client_order_id: string; at: Date; type: string; detail: Record<string, unknown> }[]
    >`
      select client_order_id, at, type, detail from order_events where client_order_id = ${clientOrderId} order by seq`;
    return rows.map((r) => ({
      clientOrderId: r.client_order_id,
      at: iso(r.at)!,
      type: r.type,
      detail: r.detail,
    }));
  }
}
