-- Back-fill (continuation of 0010, ADR-0027): orders that already ENDED but whose filled exposure is
-- not covered by recorded closures are still open exposure. Reserve them conservatively; never
-- invent flatness. The reservation holds the order's cumulative fill and is released only when the
-- cumulative closed quantity recorded for the same order covers it.
--
--  * FILLED / CANCELLED / EXPIRED / REJECTED with filled_quantity > 0: reserve the fill, unless
--    closures (closed_trades.client_order_id, summed) already cover it.
--  * FILLED with no recorded fill (inconsistent legacy data): the fill is unknown, so the full
--    approved quantity is reserved.
--  * Ambiguity blocks: two unresolved exposures on one account + symbol (or one that collides with
--    an active reservation) cannot be represented by the one-reservation-per-symbol invariant and
--    cannot be netted without evidence, so this migration FAILS and nothing is applied. A human must
--    reconcile those orders first. Migrations run before the runtime starts; no order is submitted
--    while they apply.

CREATE TEMP TABLE _legacy_exposure ON COMMIT DROP AS
SELECT o.id, o.account_id, o.client_order_id, o.approval_id, o.strategy_id, o.symbol, o.direction,
       o.planned_entry, o.stop_loss, o.take_profit, o.quantity, o.status, o.average_fill_price, o.created_at,
       CASE WHEN o.filled_quantity > 0 THEN o.filled_quantity ELSE o.quantity END AS exposed,
       o.filled_quantity,
       COALESCE((SELECT SUM(c.quantity) FROM closed_trades c
                  WHERE c.account_id = o.account_id AND c.client_order_id = o.client_order_id), 0) AS closed
  FROM orders o
 WHERE o.status IN ('FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED')
   AND (o.filled_quantity > 0 OR o.status = 'FILLED')
   AND NOT EXISTS (SELECT 1 FROM exposure_reservations r WHERE r.client_order_id = o.client_order_id);

DELETE FROM _legacy_exposure WHERE closed >= exposed;

DO $$
DECLARE
  clash text;
BEGIN
  SELECT string_agg(account_id || '/' || symbol, ', ') INTO clash FROM (
    SELECT account_id, symbol FROM _legacy_exposure GROUP BY account_id, symbol HAVING count(*) > 1
    UNION
    SELECT l.account_id, l.symbol FROM _legacy_exposure l
      JOIN exposure_reservations r ON r.account_id = l.account_id AND r.symbol = l.symbol AND r.released_at IS NULL
  ) c;
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'ASTRA 0011: unresolved legacy exposure on the same account/symbol (%): reconcile these orders (record closures or resolve them) before migrating', clash;
  END IF;
END $$;

INSERT INTO exposure_reservations
  (id, account_id, client_order_id, approval_id, strategy_id, symbol, direction, entry, stop, target,
   quantity, reserved_quantity, filled_quantity, average_fill_price, order_status, dispatched_at, reserved_at)
SELECT 'rsv_legacy_' || id, account_id, client_order_id, approval_id, strategy_id, symbol, direction,
       planned_entry, stop_loss, take_profit, quantity, exposed, filled_quantity, average_fill_price,
       status, created_at, created_at
  FROM _legacy_exposure;

INSERT INTO account_exposure_ledger (account_id, version, updated_at)
SELECT DISTINCT account_id, 1, now() FROM _legacy_exposure
ON CONFLICT (account_id) DO UPDATE SET version = account_exposure_ledger.version + 1, updated_at = now();
