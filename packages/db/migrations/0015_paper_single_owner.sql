-- R004: single-owner PAPER crash/restart safety (ADR-0027 §9). Additive; 0010-0014 untouched.
--
-- paper_owner: ONE row per paper adapter. A process becomes the owner only while it holds a
-- session-level advisory lock on a dedicated connection AND commits a DIRTY session row (the ACK)
-- BEFORE it mutates or reads any paper state. The row stays DIRTY for the whole life of the
-- session and becomes CLEAN only in a transaction that verifies the final checkpoint revisions of
-- every paper account. A new session that finds anything but a CLEAN row with matching
-- checkpoints treats the previous session as unclean and quarantines every paper account in the
-- same transaction (an active quarantine blocks new entries in the gateway AND in the database
-- reserve/dispatch steps; no automatic clearing exists). Lock loss alone never admits a takeover
-- without that quarantine.
--
-- paper_broker_state gains a monotonically increasing revision and the owning session: a save is
-- accepted only from the DIRTY owner session and only with a newer revision (stale or foreign
-- writes are refused, never absorbed).
CREATE TABLE paper_owner (
  adapter_id  text PRIMARY KEY,
  session_id  text NOT NULL,
  state       text NOT NULL CHECK (state IN ('DIRTY', 'CLEAN')),
  checkpoints jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

ALTER TABLE paper_broker_state
  ADD COLUMN revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN session_id text;
