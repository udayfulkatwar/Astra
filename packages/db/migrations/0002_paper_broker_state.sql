-- Persisted paper-broker accounts so paper trading survives restarts (spec §20 recovery).
CREATE TABLE paper_broker_state (
  adapter_id  text NOT NULL,
  account_ref text NOT NULL,
  state       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL,
  PRIMARY KEY (adapter_id, account_ref)
);
