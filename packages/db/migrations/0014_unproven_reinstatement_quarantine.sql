-- Corrective migration (ADR-0027 §8, M001 review). 0010-0013 are applied history, never edited.
--
-- 0012 reinstated a released reservation and OVERWROTE its tombstone with the order record's weaker
-- values; its RESERVATION_REINSTATED event kept only the order's fill, so the original tombstone fill is
-- irrecoverable. 0013 quarantined those orders unless closures covered the ORDERED quantity. That
-- exception rested on an unsupported assumption: legacy code could record a fill ABOVE the ordered
-- quantity (applyOrderState had no upper bound, 0010 only checks fill >= 0), e.g. tombstone FILLED 4 of
-- ordered 3, erased to 1, later closures 1 + 2 = 3 = ordered while 4 is actually open.
--
-- No independent authoritative evidence of the original fill exists in this schema (orders hold the
-- overwritten value; order_events and the audit log record only that value), so EVERY order that 0012
-- reinstated and that has no active quarantine is quarantined here, whatever closures exist.
-- This deliberately over-blocks reinstatements that were in fact correct: the account stays blocked until
-- an audited reconciliation exists. Nothing is cleared automatically; orders, tombstones, reservations
-- (including newer same-symbol commitments) and existing quarantine rows (0012/0013/runtime) are untouched.
-- Orders with an active quarantine are skipped, so re-running changes nothing.

CREATE TEMP TABLE _reinstated_unproven ON COMMIT DROP AS
SELECT r.id AS reservation_id, r.account_id, r.client_order_id, r.symbol, r.quantity AS ordered,
       r.order_status AS reservation_status, r.filled_quantity AS reservation_filled,
       o.status AS order_status, o.filled_quantity AS order_filled,
       COALESCE((SELECT SUM(c.quantity) FROM closed_trades c
                  WHERE c.account_id = r.account_id AND c.client_order_id = r.client_order_id), 0) AS closed
  FROM exposure_reservations r
  JOIN orders o ON o.client_order_id = r.client_order_id
 WHERE r.client_order_id IN (SELECT e.client_order_id FROM order_events e
                              WHERE e.type = 'RESERVATION_REINSTATED' AND e.detail ->> 'migration' = '0012')
   AND NOT EXISTS (SELECT 1 FROM exposure_quarantines q
                    WHERE q.account_id = r.account_id AND q.client_order_id = r.client_order_id
                      AND q.cleared_at IS NULL);

INSERT INTO order_events (client_order_id, at, type, detail)
SELECT client_order_id, now(), 'REINSTATEMENT_EVIDENCE_UNPROVEN',
       jsonb_build_object('migration', '0014', 'priorTombstoneFill', 'UNKNOWN', 'orderStatus', order_status,
                          'orderFilled', order_filled, 'ordered', ordered, 'closed', closed)
  FROM _reinstated_unproven;

INSERT INTO exposure_quarantines (id, account_id, client_order_id, reason, evidence, created_at)
SELECT 'qtn_0014_' || reservation_id, account_id, client_order_id,
       'migration 0014: ' || client_order_id || ' (' || symbol || ') was reinstated by migration 0012 which erased its original'
         || ' tombstone fill (now ' || reservation_filled || ', closed ' || closed || ' of ordered ' || ordered
         || '); the original fill is UNKNOWN and closures are not proof of coverage',
       jsonb_build_object('priorTombstoneFill', 'UNKNOWN',
                          'reservation', jsonb_build_object('orderStatus', reservation_status, 'filledQuantity', reservation_filled),
                          'order', jsonb_build_object('status', order_status, 'filledQuantity', order_filled),
                          'ordered', ordered, 'closed', closed),
       now()
  FROM _reinstated_unproven
ON CONFLICT DO NOTHING;

INSERT INTO account_exposure_ledger (account_id, version, updated_at)
SELECT DISTINCT account_id, 1, now() FROM _reinstated_unproven
ON CONFLICT (account_id) DO UPDATE SET version = account_exposure_ledger.version + 1, updated_at = now();
