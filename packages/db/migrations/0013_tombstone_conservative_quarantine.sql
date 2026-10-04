-- Corrective migration (ADR-0027 §8, M001). 0010, 0011 and 0012 are applied history, never edited.
--
-- 0012 judged a released reservation by its ORDER record alone (orders.filled_quantity / status).
-- A legacy candidate could release a reservation prematurely (tombstone FILLED, fill 3, closed 1) and
-- the older updateOrder then overwrote the order (CANCELLED/0, or FILLED/1). 0012 skipped the first
-- (looks like a clean cancel) and treated the second as covered by one closure. The reservation
-- tombstone is the stronger evidence: a fill is never decreased, so the effective exposure of a
-- released order is GREATEST(tombstone fill, order fill).
--
-- This migration quarantines the ACCOUNT durably (new entries refused by reserveAndConsume under the
-- ledger lock) for every released reservation whose evidence is contradictory or unproven:
--   a. tombstone fill is stronger than the order's and closures do not cover the tombstone fill;
--   b. the tombstone is not an ended state (FILLED/CANCELLED/EXPIRED/REJECTED) although it was released
--      by something other than "not transmitted" — UNKNOWN or a working state is never proof of no fill;
--   c. the tombstone is FILLED with no recorded fill (unknown size, not proof of no exposure) and closures
--      do not cover the ordered quantity;
--   d. the order record itself is UNKNOWN (state unresolved after a release).
-- Nothing is reinstated or rewritten: tombstone and order rows are left exactly as found (both are
-- evidence), the quarantine row records both, and a quarantine is never cleared here. Fully proven
-- closures (cumulative closures cover the stronger fill, consistent records) are untouched, as is any
-- newer active reservation. Rows that already carry an active quarantine (0012 or runtime) are skipped,
-- so re-running the statements changes nothing. Nothing here contacts a broker.

CREATE TEMP TABLE _tombstone_conflict ON COMMIT DROP AS
SELECT r.id AS reservation_id, r.account_id, r.client_order_id, r.symbol, r.released_at, r.release_reason,
       r.order_status AS tombstone_status, r.filled_quantity AS tombstone_filled, r.quantity AS tombstone_quantity,
       o.status AS order_status, o.filled_quantity AS order_filled,
       COALESCE((SELECT SUM(c.quantity) FROM closed_trades c
                  WHERE c.account_id = r.account_id AND c.client_order_id = r.client_order_id), 0) AS closed
  FROM exposure_reservations r
  JOIN orders o ON o.client_order_id = r.client_order_id
 WHERE r.released_at IS NOT NULL
   AND o.status <> 'SHADOW'
   AND NOT EXISTS (SELECT 1 FROM exposure_quarantines q
                    WHERE q.account_id = r.account_id AND q.client_order_id = r.client_order_id
                      AND q.cleared_at IS NULL);

DELETE FROM _tombstone_conflict c
 WHERE NOT (
       (c.tombstone_filled > c.order_filled AND c.closed < c.tombstone_filled)
    OR (c.tombstone_status NOT IN ('FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED')
        AND c.release_reason NOT LIKE 'not transmitted:%')
    OR (c.tombstone_status = 'FILLED' AND c.tombstone_filled = 0 AND c.closed < c.tombstone_quantity)
    OR c.order_status = 'UNKNOWN');

-- e. 0012 reinstatements. 0012 reinstated a released reservation when ONLY the order record looked
--    consistent, and then OVERWROTE the tombstone with the order's weaker values (tombstone FILLED 3 /
--    order FILLED 1 / closed 0 became an active FILLED 1). Its RESERVATION_REINSTATED event kept only the
--    order's fill, so the original tombstone fill is irrecoverable and cannot be reconstructed here.
--    Every 0012 reinstatement is therefore treated as UNPROVEN and quarantined (recorded as
--    prior tombstone fill UNKNOWN), unless closures already cover the full ORDERED quantity (the
--    tombstone fill cannot exceed it), or an active quarantine already exists. This deliberately
--    over-blocks a reinstatement that was in fact correct: the account stays blocked until an audited
--    reconciliation exists (no automatic clearing). The reinstated reservation itself, and any newer
--    same-symbol active reservation, stay exactly as they are.
INSERT INTO _tombstone_conflict
SELECT r.id, r.account_id, r.client_order_id, r.symbol, NULL::timestamptz, 'unknown: overwritten by migration 0012 reinstatement',
       'UNKNOWN', NULL::numeric, r.quantity, o.status, o.filled_quantity,
       COALESCE((SELECT SUM(c.quantity) FROM closed_trades c
                  WHERE c.account_id = r.account_id AND c.client_order_id = r.client_order_id), 0)
  FROM exposure_reservations r
  JOIN orders o ON o.client_order_id = r.client_order_id
 WHERE r.client_order_id IN (SELECT e.client_order_id FROM order_events e
                              WHERE e.type = 'RESERVATION_REINSTATED' AND e.detail ->> 'migration' = '0012')
   AND NOT EXISTS (SELECT 1 FROM exposure_quarantines q
                    WHERE q.account_id = r.account_id AND q.client_order_id = r.client_order_id AND q.cleared_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM _tombstone_conflict t WHERE t.reservation_id = r.id)
   AND COALESCE((SELECT SUM(c.quantity) FROM closed_trades c
                  WHERE c.account_id = r.account_id AND c.client_order_id = r.client_order_id), 0) < r.quantity;

INSERT INTO order_events (client_order_id, at, type, detail)
SELECT client_order_id, now(), 'TOMBSTONE_CONTRADICTION_QUARANTINED',
       jsonb_build_object('migration', '0013', 'tombstoneStatus', tombstone_status,
                          'tombstoneFilled', tombstone_filled, 'orderStatus', order_status,
                          'orderFilled', order_filled, 'closed', closed,
                          'releaseReason', release_reason)
  FROM _tombstone_conflict;

INSERT INTO exposure_quarantines (id, account_id, client_order_id, reason, evidence, created_at)
SELECT 'qtn_0013_' || reservation_id, account_id, client_order_id,
       'migration 0013: released reservation of ' || client_order_id || ' (' || symbol || ') is contradicted or unproven: tombstone '
         || tombstone_status || ' filled ' || COALESCE(tombstone_filled::text, 'UNKNOWN') || ', order ' || order_status
         || ' filled ' || order_filled || ', closed ' || closed,
       jsonb_build_object('releasedAt', released_at, 'releaseReason', release_reason,
                          'tombstone', jsonb_build_object('orderStatus', tombstone_status,
                                                          'filledQuantity', tombstone_filled,
                                                          'quantity', tombstone_quantity),
                          'order', jsonb_build_object('status', order_status, 'filledQuantity', order_filled),
                          'closed', closed),
       now()
  FROM _tombstone_conflict
ON CONFLICT DO NOTHING;

INSERT INTO account_exposure_ledger (account_id, version, updated_at)
SELECT DISTINCT account_id, 1, now() FROM _tombstone_conflict
ON CONFLICT (account_id) DO UPDATE SET version = account_exposure_ledger.version + 1, updated_at = now();
