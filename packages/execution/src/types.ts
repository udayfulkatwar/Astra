/** Execution vocabulary shared by the gateway, adapters and the order store. */
import type { AccountSnapshot, Direction, EntryType, HealthStatus, TradingMode } from '@astra/core';
import type { ApprovedOrderPlan } from '@astra/decision';

export const ORDER_STATUSES = [
  'PENDING_SUBMIT',
  'SUBMITTED',
  'ACCEPTED',
  'PARTIALLY_FILLED',
  'FILLED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
  'SHADOW',
  'UNKNOWN',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TERMINAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'FILLED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
  'SHADOW',
]);

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.has(status);
}

export interface OrderRequest {
  /** Idempotency key: the broker must never create two orders for one clientOrderId. */
  readonly clientOrderId: string;
  readonly accountRef: string;
  readonly symbol: string;
  readonly direction: Direction;
  readonly quantity: number;
  readonly entryType: EntryType;
  readonly stopLoss: number;
  readonly takeProfit: number;
}

export interface BrokerOrderState {
  readonly clientOrderId: string;
  readonly brokerOrderId: string | null;
  readonly status: OrderStatus;
  readonly quantity: number;
  readonly filledQuantity: number;
  readonly averageFillPrice: number | null;
  readonly rejectReason: string | null;
  readonly updatedAt: string;
}

export interface ClosePositionRequest {
  /** Idempotency key: repeating it never closes (or reports) a second time. */
  readonly clientCloseId: string;
  readonly accountRef: string;
  readonly positionId: string;
  readonly reason: string;
}

export interface ClosePositionResult {
  readonly clientCloseId: string;
  readonly positionId: string;
  /** NOT_FOUND: the position is not open (already closed / never existed) — the account is flat in it. */
  readonly status: 'CLOSED' | 'NOT_FOUND' | 'REJECTED';
  readonly exitPrice: number | null;
  readonly realizedPnl: number | null;
  readonly detail: string | null;
  readonly updatedAt: string;
}

export interface AdapterHealth {
  readonly status: HealthStatus;
  readonly detail: string;
}

/** The only component that knows a trading platform. */
export interface BrokerAdapter {
  readonly id: string;
  readonly kind: 'PAPER' | 'LIVE';
  readonly supportedEntryTypes: readonly EntryType[];
  health(): Promise<AdapterHealth>;
  /** Idempotent on clientOrderId. May throw on transport errors (outcome then unknown). */
  submitOrder(req: OrderRequest): Promise<BrokerOrderState>;
  getOrder(accountRef: string, clientOrderId: string): Promise<BrokerOrderState | null>;
  cancelOrder(accountRef: string, clientOrderId: string): Promise<BrokerOrderState>;
  listOpenOrders(accountRef: string): Promise<BrokerOrderState[]>;
  /**
   * Closes an open position at market and cancels its protective orders. Idempotent on
   * clientCloseId. May throw on transport errors (the outcome is then unknown).
   */
  closePosition(req: ClosePositionRequest): Promise<ClosePositionResult>;
  getAccountSnapshot(accountRef: string, accountId: string): Promise<AccountSnapshot>;
}

export type ApprovalState = 'PENDING' | 'CONSUMED' | 'EXPIRED' | 'SHADOW_RECORDED';

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly decisionId: string;
  readonly accountId: string;
  readonly strategyId: string;
  readonly signalId: string;
  readonly mode: TradingMode;
  readonly orderPlan: ApprovedOrderPlan;
  readonly expiresAt: string;
  readonly state: ApprovalState;
}

export interface OrderRecord {
  readonly orderId: string;
  readonly clientOrderId: string;
  readonly approvalId: string;
  readonly decisionId: string;
  readonly accountId: string;
  readonly strategyId: string;
  readonly signalId: string;
  readonly adapterId: string | null;
  readonly mode: TradingMode;
  readonly symbol: string;
  readonly direction: Direction;
  readonly quantity: number;
  readonly entryType: EntryType;
  readonly plannedEntry: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly status: OrderStatus;
  readonly brokerOrderId: string | null;
  readonly filledQuantity: number;
  readonly averageFillPrice: number | null;
  readonly rejectReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OrderEvent {
  readonly clientOrderId: string;
  readonly at: string;
  readonly type: string;
  readonly detail: Record<string, unknown>;
}

/** Persistence port for execution. Implementations must enforce uniqueness atomically. */
export interface ExecutionStore {
  getApproval(approvalId: string): Promise<ApprovalRecord | null>;
  /** Atomically moves PENDING → `to`. Returns false if the approval was not PENDING. */
  transitionApproval(
    approvalId: string,
    to: Exclude<ApprovalState, 'PENDING'>,
    at: string,
  ): Promise<boolean>;
  /** Must throw if an order already exists for the approvalId or clientOrderId. */
  createOrder(order: OrderRecord): Promise<void>;
  updateOrder(clientOrderId: string, state: BrokerOrderState): Promise<void>;
  appendOrderEvent(event: OrderEvent): Promise<void>;
  /** Non-terminal orders for the account and symbol. */
  workingOrders(accountId: string, symbol: string): Promise<OrderRecord[]>;
}
