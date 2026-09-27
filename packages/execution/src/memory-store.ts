/**
 * In-memory ExecutionStore with the same atomicity guarantees as the database implementation.
 * Used by tests and by the paper-trading simulator.
 */
import { AstraError } from '@astra/core';
import {
  isTerminal,
  type ApprovalRecord,
  type ApprovalState,
  type BrokerOrderState,
  type ExecutionStore,
  type OrderEvent,
  type OrderRecord,
} from './types';

export class InMemoryExecutionStore implements ExecutionStore {
  readonly approvals = new Map<string, ApprovalRecord>();
  readonly orders = new Map<string, OrderRecord>();
  readonly events: OrderEvent[] = [];

  addApproval(a: ApprovalRecord): void {
    this.approvals.set(a.approvalId, a);
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
    return Promise.resolve();
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
}
