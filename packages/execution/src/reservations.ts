/**
 * Pure reservation rules shared by every ExecutionStore implementation and by the gateway, so the
 * in-memory and PostgreSQL stores cannot drift apart (ADR-0027).
 */
import type { AccountSnapshot, WorkingOrder } from '@astra/core';
import type { BrokerOrderState, ExposureReservation, OrderStatus } from './types';

/** Order ended: nothing more can fill. */
const ENDED: ReadonlySet<OrderStatus> = new Set(['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED']);

export const orderHasEnded = (status: OrderStatus): boolean => ENDED.has(status);

/** Orders whose broker state is not confirmed: their exposure and fills are not known. */
export const isUncertain = (r: ExposureReservation): boolean =>
  r.orderStatus === 'UNKNOWN' ||
  r.orderStatus === 'PENDING_SUBMIT' ||
  r.orderStatus === 'SUBMITTED' ||
  r.dispatched === false;

export interface ReservationUpdate {
  readonly reservedQuantity: number;
  readonly filledQuantity: number;
  readonly averageFillPrice: number | null;
  readonly orderStatus: OrderStatus;
  /** Release reason when this broker state is authoritative proof the exposure is gone. */
  readonly release: string | null;
}

/**
 * What a broker order state does to its reservation. An ended order keeps only its filled
 * quantity (that exposure now lives in a position and stays reserved until the position is
 * confirmed or closed); an order that ended with nothing filled releases outright.
 */
export function applyOrderState(
  r: Pick<ExposureReservation, 'quantity' | 'filledQuantity' | 'averageFillPrice'>,
  s: BrokerOrderState,
): ReservationUpdate {
  const filled = Math.max(s.filledQuantity, 0);
  if (orderHasEnded(s.status)) {
    return {
      reservedQuantity: filled,
      filledQuantity: filled,
      averageFillPrice: s.averageFillPrice ?? r.averageFillPrice,
      orderStatus: s.status,
      release: filled === 0 ? `broker ${s.status} with nothing filled` : null,
    };
  }
  return {
    reservedQuantity: r.quantity,
    filledQuantity: filled,
    averageFillPrice: s.averageFillPrice ?? r.averageFillPrice,
    orderStatus: s.status,
    release: null,
  };
}

/**
 * Ended reservations whose exposure is authoritatively gone: the resulting position's closure is
 * recorded against THIS order's clientOrderId. A broker position carries no originating order id,
 * so a position that is visible — or absent from one (possibly transient) snapshot — is never
 * evidence: the reservation is retained, conservatively, until closure is linked.
 */
export function confirmedClosures(
  reservations: readonly ExposureReservation[],
  closedOrderIds: ReadonlySet<string>,
): { reservation: ExposureReservation; reason: string }[] {
  return reservations
    .filter((r) => orderHasEnded(r.orderStatus) && closedOrderIds.has(r.clientOrderId))
    .map((reservation) => ({
      reservation,
      reason: 'closure of the resulting position is recorded for this order',
    }));
}

/**
 * The broker snapshot plus every reserved-but-not-yet-visible exposure, as pending orders, so the
 * existing risk and prop-firm engines count it (open risk, position counts, correlation, firm
 * caps). Only an order the broker itself lists by clientOrderId is deduplicated. A visible
 * position is NOT netted against a reservation (it cannot be tied to its order), so a filled
 * order is counted twice until its closure is recorded — conservative refusal beats invented
 * headroom.
 */
export function snapshotWithReservations(
  snapshot: AccountSnapshot,
  reservations: readonly ExposureReservation[],
): { snapshot: AccountSnapshot; added: number } {
  const known = new Set((snapshot.workingOrders ?? []).map((o) => o.clientOrderId));
  const extra: WorkingOrder[] = [];
  for (const r of reservations) {
    if (known.has(r.clientOrderId)) continue;
    const quantity = r.reservedQuantity;
    if (quantity <= 0) continue;
    extra.push({
      clientOrderId: r.clientOrderId,
      symbol: r.symbol,
      direction: r.direction,
      quantity,
      limitPrice: r.averageFillPrice ?? r.entry,
      stopPrice: r.stop,
      targetPrice: r.target,
      placedAt: r.reservedAt,
      expiresAt: r.reservedAt,
      strategyId: r.strategyId,
    });
  }
  if (extra.length === 0) return { snapshot, added: 0 };
  return {
    snapshot: {
      ...snapshot,
      pendingOrders: snapshot.pendingOrders + extra.length,
      workingOrders: [...(snapshot.workingOrders ?? []), ...extra],
    },
    added: extra.length,
  };
}
