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
  /**
   * Set when the evidence contradicts what is already known (decreasing or malformed fills,
   * status moving backwards, an ended order changing its ending). The reservation is then kept at
   * full size and the order becomes UNKNOWN (unresolved) — contradictory evidence never frees risk.
   */
  readonly contradiction: string | null;
}

const EPS = 1e-9;

/** Forward-only lifecycle rank (clock independent). UNKNOWN is neutral; ended states share the top. */
const STATUS_RANK: Record<OrderStatus, number> = {
  PENDING_SUBMIT: 0,
  SUBMITTED: 1,
  ACCEPTED: 2,
  PARTIALLY_FILLED: 3,
  FILLED: 4,
  REJECTED: 4,
  CANCELLED: 4,
  EXPIRED: 4,
  SHADOW: 4,
  UNKNOWN: -1,
};

/**
 * What a broker order state does to its reservation, given what is already known.
 *
 * - Fills are CUMULATIVE and monotonic: the known fill never decreases, whatever a later state says.
 * - A state is accepted only if it is well-formed (finite, 0 ≤ fill ≤ quantity), does not lower the
 *   fill, does not move the lifecycle backwards, a FILLED order is fully filled, and an ended order
 *   does not change how it ended or gain fills afterwards. Anything else is contradictory/stale:
 *   the reservation is retained at full size, the known fill is preserved (or raised), and the
 *   order becomes UNKNOWN until a consistent authoritative state resolves it.
 * - An ended order then keeps only its cumulative fill (that exposure lives in a position until
 *   closures cover it); an order that ended with nothing ever filled releases outright.
 */
export function applyOrderState(
  r: Pick<ExposureReservation, 'quantity' | 'filledQuantity' | 'averageFillPrice' | 'orderStatus'>,
  s: BrokerOrderState,
): ReservationUpdate {
  const known = r.filledQuantity;
  const wellFormed = Number.isFinite(s.filledQuantity) && s.filledQuantity >= 0;
  // Highest fill ever evidenced (a malformed value never lowers it, a finite overfill raises it).
  const cumulative = Math.max(
    known,
    Number.isFinite(s.filledQuantity) ? Math.max(s.filledQuantity, 0) : 0,
  );
  const avg = s.averageFillPrice ?? r.averageFillPrice;

  const contradict = (why: string): ReservationUpdate => ({
    reservedQuantity: Math.max(r.quantity, cumulative),
    filledQuantity: cumulative,
    averageFillPrice: avg,
    orderStatus: 'UNKNOWN',
    release: null,
    contradiction: why,
  });

  if (s.status === 'UNKNOWN') {
    // Not evidence: keep everything reserved, never lower a known fill.
    return {
      reservedQuantity: Math.max(r.quantity, cumulative),
      filledQuantity: cumulative,
      averageFillPrice: avg,
      orderStatus: 'UNKNOWN',
      release: null,
      contradiction: null,
    };
  }
  if (!wellFormed) return contradict(`malformed fill quantity ${String(s.filledQuantity)}`);
  if (s.filledQuantity > r.quantity + EPS)
    return contradict(`fill ${s.filledQuantity} exceeds the order quantity ${r.quantity}`);
  if (s.filledQuantity < known - EPS)
    return contradict(`fill decreased from ${known} to ${s.filledQuantity}`);
  if (s.status === 'FILLED') {
    // The broker may report a reduced quantity (remainder cancelled); never one above what was ordered.
    if (!Number.isFinite(s.quantity) || s.quantity <= 0 || s.quantity > r.quantity + EPS)
      return contradict(
        `FILLED with reported quantity ${String(s.quantity)} (ordered ${r.quantity})`,
      );
    if (s.filledQuantity <= EPS || s.filledQuantity < s.quantity - EPS)
      return contradict(
        `FILLED with fill ${s.filledQuantity} below the reported quantity ${s.quantity}`,
      );
  }
  if (r.orderStatus !== 'UNKNOWN') {
    if (STATUS_RANK[s.status] < STATUS_RANK[r.orderStatus])
      return contradict(`status moved backwards from ${r.orderStatus} to ${s.status}`);
    if (orderHasEnded(r.orderStatus)) {
      if (s.status !== r.orderStatus)
        return contradict(`order ended as ${r.orderStatus} but is now reported ${s.status}`);
      if (s.filledQuantity > known + EPS)
        return contradict(`fill grew from ${known} to ${s.filledQuantity} after the order ended`);
    }
  }

  const filled = s.filledQuantity;
  if (orderHasEnded(s.status)) {
    return {
      reservedQuantity: filled,
      filledQuantity: filled,
      averageFillPrice: avg,
      orderStatus: s.status,
      release: filled === 0 ? `broker ${s.status} with nothing filled` : null,
      contradiction: null,
    };
  }
  return {
    reservedQuantity: r.quantity,
    filledQuantity: filled,
    averageFillPrice: avg,
    orderStatus: s.status,
    release: null,
    contradiction: null,
  };
}

/**
 * The recorded end state of an order whose exposure is no longer reserved: its released
 * reservation row (kept unchanged as evidence), or — for an order that was never reserved — the
 * order record itself.
 */
export interface Tombstone {
  readonly quantity: number;
  readonly filledQuantity: number;
  readonly orderStatus: OrderStatus;
  readonly releaseReason: string | null;
}

/**
 * Broker evidence about an order whose exposure was already released (ADR-0027 §8). The release
 * was justified only by the recorded end state, so the only acceptable evidence is a consistent
 * repeat of it. A tombstone that never ended (released as never transmitted, SHADOW) stands for
 * "REJECTED, nothing filled": the broker was never contacted. Anything else — a late fill, a
 * different ending, a working state, or UNKNOWN — means the released exposure may be real.
 * Returns the contradiction, or null for a consistent repeat.
 */
export function evidenceAfterRelease(t: Tombstone, s: BrokerOrderState): string | null {
  const ended = orderHasEnded(t.orderStatus);
  const why = (what: string) =>
    `${what} after its exposure was released${t.releaseReason ? ` (${t.releaseReason})` : ''}`;
  if (s.status === 'UNKNOWN') return why('order state became UNKNOWN');
  const u = applyOrderState(
    {
      quantity: t.quantity,
      filledQuantity: ended ? t.filledQuantity : 0,
      averageFillPrice: null,
      orderStatus: ended ? t.orderStatus : 'REJECTED',
    },
    s,
  );
  return u.contradiction ? why(u.contradiction) : null;
}

/** The fill to record on the order when released evidence is contradictory: never lowered. */
export const contradictedFill = (known: number, s: BrokerOrderState): number =>
  Math.max(known, Number.isFinite(s.filledQuantity) ? Math.max(s.filledQuantity, 0) : 0);

/**
 * Ended reservations whose exposure is authoritatively gone: the CUMULATIVE quantity of closures
 * recorded against THIS order's clientOrderId covers everything the order actually filled
 * (`reservedQuantity` of an ended order = its cumulative fill). A partial closure (fill 1 → close 1,
 * then the remaining 2 fill) keeps the whole reservation: exposure is never freed by a closure
 * that does not account for every filled unit. A broker position carries no originating order id,
 * so a visible — or momentarily absent — position is never evidence either.
 */
export function confirmedClosures(
  reservations: readonly ExposureReservation[],
  closedQuantityByOrderId: ReadonlyMap<string, number>,
): { reservation: ExposureReservation; reason: string }[] {
  const out: { reservation: ExposureReservation; reason: string }[] = [];
  for (const reservation of reservations) {
    if (!orderHasEnded(reservation.orderStatus)) continue;
    const closed = closedQuantityByOrderId.get(reservation.clientOrderId) ?? 0;
    if (reservation.reservedQuantity > 0 && closed >= reservation.reservedQuantity - EPS)
      out.push({
        reservation,
        reason: `closures recorded for this order cover its cumulative fill (${closed} of ${reservation.reservedQuantity})`,
      });
  }
  return out;
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
