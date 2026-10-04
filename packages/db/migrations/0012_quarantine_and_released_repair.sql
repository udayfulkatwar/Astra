-- Corrective migration (ADR-0027 §8, S001-R3). 0010 and 0011 are applied history and are never edited.
--
-- 1. exposure_quarantines: a durable, account-wide block on NEW entries, shared by every process
--    through the exposure ledger. Rows are evidence: never deleted, never rewritten; the only
--    permitted change is a single clearing (no clearing rule exists in the application yet, so an
--    active quarantine blocks until an operator-audited reconciliation is built).
-- 2. Released reservations are re-checked against CUMULATIVE closure coverage. 0011 skipped every
--    order that had any reservation row, including rows an earlier candidate released prematurely
--    (e.g. filled 3, closed 1). A consistent, uncovered, unambiguous one is reinstated (its prior
--    release is kept in order_events); anything inconsistent or colliding quarantines the account
--    and its tombstone is left untouched.
-- 3. Legacy FILLED orders with no recorded fill (0011 held their full quantity but labelled them
--    FILLED, i.e. "known") become UNKNOWN (unresolved: polled at startup, never resent) and
--    quarantine their account.
-- Fully proven closures (cumulative closures cover the fill) are left exactly as they are.
-- Nothing here contacts a broker; migrations run before the runtime starts.

CREATE TABLE exposure_quarantines (
  id              text PRIMARY KEY,
  account_id      text NOT NULL,
  client_order_id text,
  reason          text NOT NULL,
  evidence        jsonb NOT NULL,
  created_at      timestamptz NOT NULL,
  cleared_at      timestamptz,
  clear_reason    text,
  CHECK ((cleared_at IS NULL) = (clear_reason IS NULL))
);
-- One active quarantine per order: repeated contradictory evidence is idempotent.
CREATE UNIQUE INDEX exposure_quarantines_active_order
  ON exposure_quarantines (account_id, client_order_id)
  WHERE cleared_at IS NULL AND client_order_id IS NOT NULL;
CREATE INDEX exposure_quarantines_active_account
  ON exposure_quarantines (account_id) WHERE cleared_at IS NULL;

CREATE FUNCTION astra_quarantine_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'exposure_quarantines rows are evidence and cannot be deleted';
  END IF;
  IF OLD.cleared_at IS NOT NULL
     OR NEW.id <> OLD.id OR NEW.account_id <> OLD.account_id
     OR NEW.client_order_id IS DISTINCT FROM OLD.client_order_id
     OR NEW.reason <> OLD.reason OR NEW.evidence <> OLD.evidence OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'exposure_quarantines rows are evidence: only an active row may be cleared, once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER exposure_quarantines_evidence BEFORE UPDATE OR DELETE ON exposure_quarantines
  FOR EACH ROW EXECUTE FUNCTION astra_quarantine_evidence();

-- 2. Released reservations whose order still carries exposure that closures do not cover, or whose
--    order record contradicts the release.
CREATE TEMP TABLE _released_open ON COMMIT DROP AS
SELECT r.id AS reservation_id, r.account_id, r.client_order_id, r.symbol, r.released_at, r.release_reason,
       o.status, o.quantity, o.filled_quantity,
       CASE WHEN o.filled_quantity > 0 THEN o.filled_quantity ELSE o.quantity END AS exposed,
       COALESCE((SELECT SUM(c.quantity) FROM closed_trades c
                  WHERE c.account_id = r.account_id AND c.client_order_id = r.client_order_id), 0) AS closed,
       -- Consistent: the order ended with a positive fill, and the release did not claim that the
       -- order was never transmitted or ended with nothing filled.
       (o.status IN ('FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED') AND o.filled_quantity > 0
        AND r.release_reason NOT LIKE 'not transmitted:%'
        AND r.release_reason NOT LIKE '%with nothing filled%') AS consistent
  FROM exposure_reservations r
  JOIN orders o ON o.client_order_id = r.client_order_id
 WHERE r.released_at IS NOT NULL
   AND o.status <> 'SHADOW'
   AND (o.filled_quantity > 0 OR o.status NOT IN ('REJECTED', 'CANCELLED', 'EXPIRED'));

DELETE FROM _released_open WHERE consistent AND closed >= exposed;

-- A reinstatement is safe only if it is the sole open exposure on its account + symbol.
ALTER TABLE _released_open ADD COLUMN reinstate boolean;
UPDATE _released_open x SET reinstate = x.consistent
   AND NOT EXISTS (SELECT 1 FROM exposure_reservations a
                    WHERE a.account_id = x.account_id AND a.symbol = x.symbol AND a.released_at IS NULL)
   AND (SELECT count(*) FROM _released_open y
         WHERE y.account_id = x.account_id AND y.symbol = x.symbol) = 1;

INSERT INTO order_events (client_order_id, at, type, detail)
SELECT client_order_id, now(), 'RESERVATION_REINSTATED',
       jsonb_build_object('migration', '0012', 'previousReleasedAt', released_at,
                          'previousReleaseReason', release_reason, 'filled', filled_quantity, 'closed', closed)
  FROM _released_open WHERE reinstate;

UPDATE exposure_reservations r
   SET released_at = NULL, release_reason = NULL, reserved_quantity = x.exposed,
       filled_quantity = x.filled_quantity, order_status = x.status
  FROM _released_open x
 WHERE r.id = x.reservation_id AND x.reinstate;

INSERT INTO exposure_quarantines (id, account_id, client_order_id, reason, evidence, created_at)
SELECT 'qtn_0012_' || reservation_id, account_id, client_order_id,
       CASE WHEN consistent
            THEN 'migration 0012: released exposure of ' || client_order_id || ' (' || symbol
                 || ') is not covered by closures and collides with other exposure on the symbol'
            ELSE 'migration 0012: released reservation of ' || client_order_id || ' (' || symbol
                 || ') contradicts its order record (' || status || ', filled ' || filled_quantity || ')'
       END,
       jsonb_build_object('releasedAt', released_at, 'releaseReason', release_reason, 'orderStatus', status,
                          'quantity', quantity, 'filled', filled_quantity, 'closed', closed),
       now()
  FROM _released_open WHERE NOT reinstate;

-- 3. Legacy unknown fills: still held at full size, now unresolved and quarantined.
CREATE TEMP TABLE _unknown_fill ON COMMIT DROP AS
SELECT r.id AS reservation_id, r.account_id, r.client_order_id, r.symbol, o.status, o.filled_quantity
  FROM exposure_reservations r
  JOIN orders o ON o.client_order_id = r.client_order_id
 WHERE r.released_at IS NULL AND r.order_status = 'FILLED' AND r.filled_quantity = 0;

UPDATE exposure_reservations r
   SET order_status = 'UNKNOWN', reserved_quantity = GREATEST(r.reserved_quantity, r.quantity)
  FROM _unknown_fill u WHERE r.id = u.reservation_id;

INSERT INTO order_events (client_order_id, at, type, detail)
SELECT client_order_id, now(), 'LEGACY_FILL_UNKNOWN',
       jsonb_build_object('migration', '0012', 'recordedStatus', status, 'recordedFill', filled_quantity)
  FROM _unknown_fill;

UPDATE orders o
   SET status = 'UNKNOWN',
       reject_reason = 'migration 0012: legacy FILLED order with no recorded fill; state unknown until reconciled'
  FROM _unknown_fill u WHERE o.client_order_id = u.client_order_id;

INSERT INTO exposure_quarantines (id, account_id, client_order_id, reason, evidence, created_at)
SELECT 'qtn_0012_' || reservation_id, account_id, client_order_id,
       'migration 0012: legacy FILLED order ' || client_order_id || ' (' || symbol || ') has no recorded fill',
       jsonb_build_object('recordedStatus', status, 'recordedFill', filled_quantity),
       now()
  FROM _unknown_fill
ON CONFLICT DO NOTHING;

INSERT INTO account_exposure_ledger (account_id, version, updated_at)
SELECT DISTINCT account_id, 1, now() FROM (
  SELECT account_id FROM _released_open UNION SELECT account_id FROM _unknown_fill
) a
ON CONFLICT (account_id) DO UPDATE SET version = account_exposure_ledger.version + 1, updated_at = now();
