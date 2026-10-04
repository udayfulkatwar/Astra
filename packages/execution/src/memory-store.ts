/**
 * In-memory ExecutionStore with the same atomicity guarantees as the database implementation.
 * Used by tests and by the paper-trading simulator. Several gateways may share one instance to
 * model several processes sharing one database; every multi-step mutation below is synchronous
 * (no await between its check and its write), which is what makes it atomic here.
 */
import { AstraError, newId } from '@astra/core';
import { applyOrderState, confirmedClosures } from './reservations';
import {
  isTerminal,
  type AccountExposure,
  type ApprovalRecord,
  type ApprovalState,
  type BrokerOrderState,
  type ExecutionStore,
  type ExposureReservation,
  type OrderEvent,
  type OrderRecord,
  type ReserveResult,
} from './types';

interface Ledger {
  version: number;
  readonly active: Map<string, ExposureReservation>; // by clientOrderId
}

export class InMemoryExecutionStore implements ExecutionStore {
  readonly approvals = new Map<string, ApprovalRecord>();
  readonly orders = new Map<string, OrderRecord>();
  readonly events: OrderEvent[] = [];
  readonly rejections: {
    approvalId: string;
    accountId: string | null;
    reasons: string[];
    at: string;
  }[] = [];
  /** Released reservations with their evidence (audit). */
  readonly released: { clientOrderId: string; reason: string; at: string }[] = [];
  /** Orders whose resulting position has a recorded closure (the journal's evidence). */
  readonly closedOrderIds = new Set<string>();
  private readonly ledgers = new Map<string, Ledger>();

  addApproval(a: ApprovalRecord): void {
    this.approvals.set(a.approvalId, a);
  }

  private ledger(accountId: string): Ledger {
    let l = this.ledgers.get(accountId);
    if (!l) {
      l = { version: 0, active: new Map() };
      this.ledgers.set(accountId, l);
    }
    return l;
  }

  getApproval(approvalId: string): Promise<ApprovalRecord | null> {
    return Promise.resolve(this.approvals.get(approvalId) ?? null);
  }

  transitionApproval(approvalId: string, to: Exclude<ApprovalState, 'PENDING'>): Promise<boolean> {
    const a = this.approvals.get(approvalId);
    if (!a || a.state !== 'PENDING') return Promise.resolve(false);
    this.approvals.set(approvalId, { ...a, state: to });
    return Promise.resolve(true);
  }

  createOrder(order: OrderRecord): Promise<void> {
    for (const o of this.orders.values()) {
      if (o.approvalId === order.approvalId || o.clientOrderId === order.clientOrderId) {
        return Promise.reject(
          new AstraError('CONFLICT', `order already exists for approval ${order.approvalId}`),
        );
      }
    }
    this.orders.set(order.clientOrderId, order);
    return Promise.resolve();
  }

  updateOrder(clientOrderId: string, s: BrokerOrderState): Promise<void> {
    const o = this.orders.get(clientOrderId);
    if (!o) return Promise.reject(new AstraError('NOT_FOUND', `order ${clientOrderId} not found`));
    this.orders.set(clientOrderId, {
      ...o,
      status: s.status,
      brokerOrderId: s.brokerOrderId ?? o.brokerOrderId,
      filledQuantity: s.filledQuantity,
      averageFillPrice: s.averageFillPrice,
      rejectReason: s.rejectReason,
      updatedAt: s.updatedAt,
    });
    const ledger = this.ledger(o.accountId);
    const r = ledger.active.get(clientOrderId);
    if (r) {
      const u = applyOrderState(r, s);
      if (u.release) {
        this.release(ledger, r, u.release, s.updatedAt);
      } else {
        ledger.active.set(clientOrderId, { ...r, ...u });
        ledger.version++;
      }
    }
    return Promise.resolve();
  }

  private release(ledger: Ledger, r: ExposureReservation, reason: string, at: string): void {
    ledger.active.delete(r.clientOrderId);
    ledger.version++;
    this.released.push({ clientOrderId: r.clientOrderId, reason, at });
  }

  appendOrderEvent(event: OrderEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }

  workingOrders(accountId: string, symbol: string): Promise<OrderRecord[]> {
    return Promise.resolve(
      [...this.orders.values()].filter(
        (o) => o.accountId === accountId && o.symbol === symbol && !isTerminal(o.status),
      ),
    );
  }

  accountExposure(accountId: string): Promise<AccountExposure> {
    const l = this.ledger(accountId);
    return Promise.resolve({ accountId, version: l.version, reservations: [...l.active.values()] });
  }

  reserveAndConsume(req: {
    order: OrderRecord;
    expectedVersion: number;
    at: string;
    intent: Record<string, unknown>;
  }): Promise<ReserveResult> {
    const { order, at } = req;
    const ledger = this.ledger(order.accountId);
    const fail = (code: Exclude<ReserveResult, { ok: true }>['code'], reason: string) =>
      Promise.resolve<ReserveResult>({ ok: false, code, reason });
    if (ledger.version !== req.expectedVersion)
      return fail('LEDGER_CHANGED', 'account exposure changed while the order was being validated');
    const a = this.approvals.get(order.approvalId);
    if (!a || a.state !== 'PENDING')
      return fail('APPROVAL_NOT_PENDING', 'approval already consumed');
    if (!(Date.parse(at) < Date.parse(a.expiresAt)))
      return fail('APPROVAL_EXPIRED', `approval expired at ${a.expiresAt}`);
    for (const r of ledger.active.values()) {
      if (r.symbol === order.symbol)
        return fail(
          'SYMBOL_EXPOSED',
          `${order.symbol} already has reserved exposure (${r.clientOrderId})`,
        );
    }
    for (const o of this.orders.values()) {
      if (o.approvalId === order.approvalId || o.clientOrderId === order.clientOrderId)
        return fail('DUPLICATE_ORDER', `order already exists for approval ${order.approvalId}`);
    }
    this.approvals.set(order.approvalId, { ...a, state: 'CONSUMED' });
    this.orders.set(order.clientOrderId, order);
    ledger.active.set(order.clientOrderId, {
      reservationId: newId('reservation'),
      accountId: order.accountId,
      clientOrderId: order.clientOrderId,
      approvalId: order.approvalId,
      strategyId: order.strategyId,
      symbol: order.symbol,
      direction: order.direction,
      entry: order.plannedEntry,
      stop: order.stopLoss,
      target: order.takeProfit,
      quantity: order.quantity,
      reservedQuantity: order.quantity,
      filledQuantity: 0,
      averageFillPrice: null,
      orderStatus: order.status,
      dispatched: false,
      reservedAt: at,
    });
    ledger.version++;
    this.events.push({
      clientOrderId: order.clientOrderId,
      at,
      type: 'SUBMIT_REQUESTED',
      detail: req.intent,
    });
    return Promise.resolve({ ok: true });
  }

  markDispatching(clientOrderId: string, at: string): Promise<void> {
    const o = this.orders.get(clientOrderId);
    const ledger = o ? this.ledger(o.accountId) : undefined;
    const r = ledger?.active.get(clientOrderId);
    if (!ledger || !r)
      return Promise.reject(
        new AstraError('NOT_FOUND', `no active reservation for ${clientOrderId}`),
      );
    ledger.active.set(clientOrderId, { ...r, dispatched: true });
    ledger.version++;
    this.events.push({ clientOrderId, at, type: 'SUBMIT_DISPATCHING', detail: {} });
    return Promise.resolve();
  }

  releaseUntransmitted(
    clientOrderId: string,
    reason: string,
    at: string,
    opts: { onlyIfUndispatched?: boolean } = {},
  ): Promise<boolean> {
    const o = this.orders.get(clientOrderId);
    if (!o) return Promise.reject(new AstraError('NOT_FOUND', `order ${clientOrderId} not found`));
    const ledger = this.ledger(o.accountId);
    const r = ledger.active.get(clientOrderId);
    if (!r || (opts.onlyIfUndispatched && r.dispatched)) return Promise.resolve(false);
    this.orders.set(clientOrderId, {
      ...o,
      status: 'REJECTED',
      rejectReason: reason,
      updatedAt: at,
    });
    this.release(ledger, r, `not transmitted: ${reason}`, at);
    this.events.push({ clientOrderId, at, type: 'NOT_TRANSMITTED', detail: { reason } });
    return Promise.resolve(true);
  }

  reconcileReservations(accountId: string, at: string): Promise<number> {
    const ledger = this.ledger(accountId);
    const done = confirmedClosures([...ledger.active.values()], this.closedOrderIds);
    for (const t of done) this.release(ledger, t.reservation, t.reason, at);
    return Promise.resolve(done.length);
  }

  recordRejection(req: {
    approvalId: string;
    accountId: string | null;
    reasons: readonly string[];
    at: string;
  }): Promise<void> {
    this.rejections.push({ ...req, reasons: [...req.reasons] });
    return Promise.resolve();
  }
}
