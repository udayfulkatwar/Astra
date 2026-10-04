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
  /** LIMIT: fill at this price or better. */
  readonly limitPrice?: number;
  /** LIMIT: the broker cancels the order if it is not filled by then. */
  readonly expiresAt?: string;
  readonly stopLoss: number;
  readonly takeProfit: number;
}

/**
 * A LIMIT order the broker has accepted and is holding (status ACCEPTED): a known, confirmed
 * state — it fills, expires or is cancelled later.
 */
export const isWorking = (s: { status: OrderStatus }): boolean => s.status === 'ACCEPTED';

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
  /** LIMIT: when the unfilled order is cancelled. null for MARKET. */
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OrderEvent {
  readonly clientOrderId: string;
  readonly at: string;
  readonly type: string;
  readonly detail: Record<string, unknown>;
}

/**
 * Durable, account-wide exposure claimed by an entry order that may still open (or has opened) a
 * position (ADR-0027). It spans every symbol and is created in the SAME atomic step that consumes
 * the approval and creates the order. It is released only on authoritative evidence — never
 * because time passed or a lease ran out.
 */
export interface ExposureReservation {
  readonly reservationId: string;
  readonly accountId: string;
  readonly clientOrderId: string;
  readonly approvalId: string;
  readonly strategyId: string;
  readonly symbol: string;
  readonly direction: Direction;
  readonly entry: number;
  readonly stop: number;
  readonly target: number;
  /** Approved quantity. */
  readonly quantity: number;
  /**
   * Quantity still counted: the approved quantity while the order may still fill (or its state is
   * unknown); the filled quantity once the unfilled remainder is authoritatively gone.
   */
  readonly reservedQuantity: number;
  readonly filledQuantity: number;
  readonly averageFillPrice: number | null;
  readonly orderStatus: OrderStatus;
  /** The submit call may have started (written before the broker is contacted). */
  readonly dispatched: boolean;
  readonly reservedAt: string;
}

/**
 * A durable, account-wide block on NEW entries (ADR-0027 §8): broker evidence contradicted an order
 * whose reservation had already been released (e.g. REJECTED with nothing filled, then FILLED), or
 * a migration found legacy exposure it could not represent safely. Every gateway and process sees
 * it through the shared ledger; `reserveAndConsume` refuses while one is active. It never expires
 * and nothing in ASTRA clears it automatically (no audited clearing rule exists yet).
 */
export interface AccountQuarantine {
  readonly quarantineId: string;
  readonly accountId: string;
  /** The order whose evidence caused it (null for an account-level legacy finding). */
  readonly clientOrderId: string | null;
  readonly reason: string;
  readonly createdAt: string;
}

/** The active reservations of one account with the ledger version they were read at. */
export interface AccountExposure {
  readonly accountId: string;
  /** Bumped by every change to the account's reservations (optimistic concurrency token). */
  readonly version: number;
  readonly reservations: readonly ExposureReservation[];
  /** Active quarantines: while any exists, no new entry may be reserved or transmitted. */
  readonly quarantines: readonly AccountQuarantine[];
}

export type ReserveFailure =
  | 'ACCOUNT_QUARANTINED'
  | 'LEDGER_CHANGED'
  | 'APPROVAL_NOT_PENDING'
  | 'APPROVAL_EXPIRED'
  | 'SYMBOL_EXPOSED'
  | 'DUPLICATE_ORDER'
  | 'OWNER_FENCE';

export type ReserveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ReserveFailure; readonly reason: string };

export interface OrderUpdateResult {
  /** null = the evidence was consistent and applied. */
  readonly contradiction: string | null;
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
  /**
   * Applies broker evidence. Fills only ever grow and the lifecycle only moves forward: evidence
   * that contradicts what is known is NOT applied as stated — the order becomes UNKNOWN, its
   * reservation is kept, and `contradiction` says why (callers must halt/poll, never assume).
   * An order with NO active reservation (released, or never reserved) is judged against its
   * recorded end state (the tombstone, never modified): anything but a consistent repeat — a late
   * fill, a different ending, a working state, UNKNOWN — durably quarantines the account in the
   * same transaction (ledger version bumped) and is reported as a contradiction.
   */
  updateOrder(clientOrderId: string, state: BrokerOrderState): Promise<OrderUpdateResult>;
  appendOrderEvent(event: OrderEvent): Promise<void>;
  /** Non-terminal orders for the account and symbol. */
  workingOrders(accountId: string, symbol: string): Promise<OrderRecord[]>;
  /** Active reservations of the account (all symbols) and the ledger version they were read at. */
  accountExposure(accountId: string): Promise<AccountExposure>;
  /**
   * ONE atomic step under the account's shared lock: the account must not be quarantined, the
   * ledger version must still equal
   * `expectedVersion`, the approval must still be PENDING and unexpired at `at`, and the account
   * must hold no active reservation for the symbol; then the approval is consumed and the order,
   * its reservation and the SUBMIT_REQUESTED intent are written together — or nothing is.
   */
  reserveAndConsume(req: {
    order: OrderRecord;
    expectedVersion: number;
    at: string;
    intent: Record<string, unknown>;
    /**
     * Session fence of the single paper owner (R004). A database that holds an owner row for the
     * order's adapter refuses (OWNER_FENCE) unless this is that row's DIRTY session, judged under
     * a row lock so an ownership change during the wait also refuses. Other stores ignore it.
     */
    owner?: string;
  }): Promise<ReserveResult>;
  /**
   * Durably records that the submit call is about to start. Must throw if it cannot, or if the
   * account is quarantined.
   */
  markDispatching(clientOrderId: string, at: string, owner?: string): Promise<void>;
  /**
   * Marks an order the broker was never contacted for as REJECTED and releases its reservation.
   * Only the gateway, which knows it did not call the adapter, or restart reconciliation of an
   * order that was never marked dispatched, may call this.
   */
  releaseUntransmitted(
    clientOrderId: string,
    reason: string,
    at: string,
    opts?: { onlyIfUndispatched?: boolean },
  ): Promise<boolean>;
  /**
   * Releases ended reservations whose cumulative recorded closure quantity (same clientOrderId)
   * covers everything the order filled. Partial closures retain the reservation; position
   * visibility alone never releases (positions carry no order id).
   * Returns how many were released.
   */
  reconcileReservations(accountId: string, at: string): Promise<number>;
  /** Audit trail for an execution request that was refused before anything was transmitted. */
  recordRejection(req: {
    approvalId: string;
    accountId: string | null;
    reasons: readonly string[];
    at: string;
  }): Promise<void>;
}
