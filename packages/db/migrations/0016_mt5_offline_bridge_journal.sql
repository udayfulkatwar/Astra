-- P002 offline increment: durable journal for the MT5 bridge contract (design: docs/ledger/P002_MT5_ROUTE.md).
-- Additive; 0001-0015 untouched. Offline/fake-transport only: nothing here talks to a terminal or
-- touches exposure_reservations, quarantine or any PAPER table.
--
-- bridge_owner: ONE row per account. The first owner inserts it; any later claim is refused
-- (no handoff by expiry). A takeover is an explicit, evidence-carrying UPDATE that bumps the
-- epoch and sets reconcile_required (entries stay blocked until completeReconcile).
CREATE TABLE bridge_owner (
  account_ref        text PRIMARY KEY,
  owner_id           text NOT NULL,
  epoch              bigint NOT NULL CHECK (epoch >= 1),
  reconcile_required boolean NOT NULL DEFAULT false,
  takeover_note      text,
  updated_at         timestamptz NOT NULL
);

-- bridge_command: one row per (account, client id). The primary key makes "same id" atomic; the
-- stored payload hash makes "same id, different payload" detectable.
CREATE TABLE bridge_command (
  account_ref  text NOT NULL REFERENCES bridge_owner (account_ref),
  command_id   text NOT NULL,
  op           text NOT NULL CHECK (op IN ('SUBMIT', 'CANCEL', 'CLOSE')),
  cls          text NOT NULL CHECK (cls IN ('ENTRY', 'PROTECTIVE')),
  payload_hash text NOT NULL,
  command      jsonb NOT NULL,
  state        text NOT NULL CHECK (state IN ('INTENT', 'SEND_MAY_HAVE_STARTED', 'RESOLVED', 'UNKNOWN', 'REFUSED')),
  result       jsonb,
  owner_id     text NOT NULL,
  epoch        bigint NOT NULL,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  PRIMARY KEY (account_ref, command_id)
);
CREATE INDEX bridge_command_pending ON bridge_command (account_ref, created_at)
  WHERE state = 'INTENT' AND cls = 'PROTECTIVE';

-- Rows are immutable except for forward state transitions. SEND_MAY_HAVE_STARTED is irreversible:
-- it can never return to INTENT, rows are never deleted, and the identity/payload never change.
CREATE FUNCTION bridge_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bridge_command rows are never deleted';
  END IF;
  IF NEW.account_ref <> OLD.account_ref OR NEW.command_id <> OLD.command_id
     OR NEW.op <> OLD.op OR NEW.cls <> OLD.cls OR NEW.payload_hash <> OLD.payload_hash
     OR NEW.command <> OLD.command OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'bridge_command identity and payload are immutable';
  END IF;
  IF NOT (
       (OLD.state = 'INTENT' AND NEW.state IN ('INTENT', 'SEND_MAY_HAVE_STARTED', 'REFUSED'))
    OR (OLD.state = 'SEND_MAY_HAVE_STARTED' AND NEW.state IN ('SEND_MAY_HAVE_STARTED', 'RESOLVED', 'UNKNOWN'))
    OR (OLD.state = NEW.state AND OLD.state IN ('RESOLVED', 'UNKNOWN', 'REFUSED') AND NEW.result IS NOT DISTINCT FROM OLD.result)
  ) THEN
    RAISE EXCEPTION 'illegal bridge_command transition % -> %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bridge_command_guard BEFORE UPDATE OR DELETE ON bridge_command
  FOR EACH ROW EXECUTE FUNCTION bridge_command_guard();
