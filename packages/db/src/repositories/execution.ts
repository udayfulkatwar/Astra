/** ExecutionStore backed by PostgreSQL. Uniqueness is enforced by the schema, not by hope. */
import { AstraError, type Direction, type EntryType, type TradingMode } from '@astra/core';
import type { ApprovedOrderPlan } from '@astra/decision';
import type {
  ApprovalRecord,
  ApprovalState,
  BrokerOrderState,
  ExecutionStore,
  OrderEvent,
  OrderRecord,
  OrderStatus,
} from '@astra/execution';
import type { Sql } from '../client';
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
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

const TERMINAL = ['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'SHADOW'];

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
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
    return this.sql.begin(async (tx) => {
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
    });
  }

  async createOrder(o: OrderRecord): Promise<void> {
    try {
      await this.sql.begin(async (tx) => {
        await tx`
          insert into orders (id, client_order_id, approval_id, decision_id, account_id, strategy_id, signal_id,
            adapter_id, mode, symbol, direction, quantity, entry_type, planned_entry, stop_loss, take_profit,
            status, broker_order_id, filled_quantity, average_fill_price, reject_reason, created_at, updated_at)
          values (${o.orderId}, ${o.clientOrderId}, ${o.approvalId}, ${o.decisionId}, ${o.accountId}, ${o.strategyId},
            ${o.signalId}, ${o.adapterId}, ${o.mode}, ${o.symbol}, ${o.direction}, ${o.quantity}, ${o.entryType},
            ${o.plannedEntry}, ${o.stopLoss}, ${o.takeProfit}, ${o.status}, ${o.brokerOrderId}, ${o.filledQuantity},
            ${o.averageFillPrice}, ${o.rejectReason}, ${o.createdAt}, ${o.updatedAt})`;
        await appendAuditInTx(tx, {
          actor: { type: 'SYSTEM', id: 'execution-gateway' },
          category: 'EXECUTION',
          action: 'ORDER_CREATED',
          entityType: 'order',
          entityId: o.clientOrderId,
          payload: { ...o },
          at: o.createdAt,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AstraError('CONFLICT', `an order already exists for approval ${o.approvalId}`);
      }
      throw err;
    }
  }

  async updateOrder(clientOrderId: string, s: BrokerOrderState): Promise<void> {
    const rows = await this.sql`
      update orders set status = ${s.status}, broker_order_id = coalesce(${s.brokerOrderId}, broker_order_id),
             filled_quantity = ${s.filledQuantity}, average_fill_price = ${s.averageFillPrice},
             reject_reason = ${s.rejectReason}, updated_at = ${s.updatedAt}
       where client_order_id = ${clientOrderId}
      returning id`;
    if (rows.length === 0) throw new AstraError('NOT_FOUND', `order ${clientOrderId} not found`);
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

  /** Every non-terminal order of an account (startup reconciliation). */
  async workingOrdersForAccount(accountId: string): Promise<OrderRecord[]> {
    const rows = await this.sql<OrderRow[]>`
      select * from orders where account_id = ${accountId} and status not in ${this.sql(TERMINAL)}`;
    return rows.map(mapOrder);
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
