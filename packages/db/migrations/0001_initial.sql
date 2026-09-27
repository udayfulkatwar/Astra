-- ASTRA initial schema (Phase 1 foundation + Phase 3 safety core).
-- All timestamps are timestamptz (UTC). Money and quantities are numeric (exact).
-- Append-only tables are protected by triggers: history cannot be rewritten.

-- ---------------------------------------------------------------------------------------------
-- Integrity helpers
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION astra_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ASTRA: table % is append-only (% forbidden)', TG_TABLE_NAME, TG_OP;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Configuration versions: every distinct configuration ever loaded (hash → canonical content).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE config_versions (
  hash            text PRIMARY KEY,
  content         jsonb NOT NULL,
  first_loaded_at timestamptz NOT NULL,
  last_loaded_at  timestamptz NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- System state: the global trading mode (single row, optimistic versioning).
-- The database never starts in LIVE.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE system_state (
  id         smallint PRIMARY KEY CHECK (id = 1),
  mode       text NOT NULL CHECK (mode IN ('BACKTEST', 'PAPER', 'SHADOW', 'LIVE', 'HALTED')),
  version    integer NOT NULL CHECK (version > 0),
  changed_at timestamptz NOT NULL,
  changed_by text NOT NULL,
  reason     text NOT NULL
);
INSERT INTO system_state (id, mode, version, changed_at, changed_by, reason)
VALUES (1, 'PAPER', 1, now(), 'system:migration', 'initial state');

-- ---------------------------------------------------------------------------------------------
-- Audit log: hash-chained, append-only record of every important action (spec §22, §37).
-- hash = sha256(prev_hash || canonical(entry)); verifiable end to end.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE audit_log (
  seq         bigserial PRIMARY KEY,
  id          text NOT NULL UNIQUE,
  at          timestamptz NOT NULL,
  actor_type  text NOT NULL CHECK (actor_type IN ('HUMAN', 'SYSTEM', 'AUTOMATION')),
  actor_id    text NOT NULL,
  category    text NOT NULL,
  action      text NOT NULL,
  entity_type text,
  entity_id   text,
  payload     jsonb NOT NULL,
  prev_hash   text NOT NULL,
  hash        text NOT NULL UNIQUE
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION astra_forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION astra_forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- System events: the live activity stream shown on the dashboard (spec §68).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE system_events (
  seq        bigserial PRIMARY KEY,
  id         text NOT NULL UNIQUE,
  at         timestamptz NOT NULL,
  level      text NOT NULL CHECK (level IN ('DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL')),
  component  text NOT NULL,
  type       text NOT NULL,
  message    text NOT NULL,
  account_id text,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX system_events_at_idx ON system_events (at DESC);
CREATE TRIGGER system_events_append_only BEFORE UPDATE ON system_events
  FOR EACH ROW EXECUTE FUNCTION astra_forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Kill switches: current state + append-only history.
-- target '*' represents "all" (primary keys cannot contain NULL).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE kill_switches (
  scope           text NOT NULL CHECK (scope IN ('GLOBAL', 'ACCOUNT', 'STRATEGY', 'INSTRUMENT', 'EXECUTION', 'AI', 'NEWS')),
  target          text NOT NULL,
  active          boolean NOT NULL,
  reason          text NOT NULL,
  changed_by_type text NOT NULL CHECK (changed_by_type IN ('HUMAN', 'SYSTEM')),
  changed_by_id   text NOT NULL,
  changed_at      timestamptz NOT NULL,
  clear_policy    text NOT NULL CHECK (clear_policy IN ('MANUAL', 'NEXT_TRADING_DAY')),
  auto_clear_at   timestamptz,
  PRIMARY KEY (scope, target)
);

CREATE TABLE kill_switch_events (
  seq             bigserial PRIMARY KEY,
  at              timestamptz NOT NULL,
  scope           text NOT NULL,
  target          text NOT NULL,
  active          boolean NOT NULL,
  reason          text NOT NULL,
  changed_by_type text NOT NULL,
  changed_by_id   text NOT NULL,
  clear_policy    text NOT NULL,
  auto_clear_at   timestamptz
);
CREATE TRIGGER kill_switch_events_append_only BEFORE UPDATE OR DELETE ON kill_switch_events
  FOR EACH ROW EXECUTE FUNCTION astra_forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Component heartbeats (n8n, external feeds) — latest report per component.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE component_heartbeats (
  component   text PRIMARY KEY,
  status      text NOT NULL CHECK (status IN ('ONLINE', 'DEGRADED', 'ERROR', 'UNKNOWN')),
  detail      text NOT NULL,
  reported_at timestamptz NOT NULL,
  reported_by text NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- Trade decisions: every verdict with its full input snapshot and check results.
-- Immutable except for the approval lifecycle columns.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trade_decisions (
  id                        text PRIMARY KEY,
  decided_at                timestamptz NOT NULL,
  account_id                text NOT NULL,
  strategy_id               text NOT NULL,
  signal_id                 text NOT NULL,
  symbol                    text NOT NULL,
  direction                 text NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  mode                      text NOT NULL,
  status                    text NOT NULL CHECK (status IN ('APPROVED', 'REJECTED')),
  reasons                   jsonb NOT NULL,
  checks                    jsonb NOT NULL,
  sizing                    jsonb,
  order_plan                jsonb,
  explanation               jsonb NOT NULL,
  config_hash               text NOT NULL,
  inputs                    jsonb NOT NULL,
  workflow_run_id           text,
  approval_id               text UNIQUE,
  approval_expires_at       timestamptz,
  approval_state            text CHECK (approval_state IN ('PENDING', 'CONSUMED', 'EXPIRED', 'SHADOW_RECORDED')),
  approval_state_changed_at timestamptz,
  CONSTRAINT approval_matches_status CHECK (
    (status = 'APPROVED' AND approval_id IS NOT NULL AND approval_expires_at IS NOT NULL AND approval_state IS NOT NULL)
    OR (status = 'REJECTED' AND approval_id IS NULL AND approval_state IS NULL)
  )
);
CREATE INDEX trade_decisions_decided_at_idx ON trade_decisions (decided_at DESC);
CREATE INDEX trade_decisions_account_idx ON trade_decisions (account_id, decided_at DESC);
-- Database-level duplicate-signal protection: one approval per (account, signal).
CREATE UNIQUE INDEX trade_decisions_one_approval_per_signal
  ON trade_decisions (account_id, signal_id) WHERE status = 'APPROVED';

CREATE FUNCTION astra_decision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ASTRA: trade decisions cannot be deleted';
  END IF;
  IF (to_jsonb(NEW) - 'approval_state' - 'approval_state_changed_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'approval_state' - 'approval_state_changed_at') THEN
    RAISE EXCEPTION 'ASTRA: trade decisions are immutable except for approval state';
  END IF;
  IF OLD.approval_state IS DISTINCT FROM 'PENDING' AND NEW.approval_state IS DISTINCT FROM OLD.approval_state THEN
    RAISE EXCEPTION 'ASTRA: approval state % is final', OLD.approval_state;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trade_decisions_guard BEFORE UPDATE OR DELETE ON trade_decisions
  FOR EACH ROW EXECUTE FUNCTION astra_decision_guard();

-- ---------------------------------------------------------------------------------------------
-- Orders: one per approval (unique approval_id and client_order_id = duplicate protection).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE orders (
  id                 text PRIMARY KEY,
  client_order_id    text NOT NULL UNIQUE,
  approval_id        text NOT NULL UNIQUE REFERENCES trade_decisions (approval_id),
  decision_id        text NOT NULL REFERENCES trade_decisions (id),
  account_id         text NOT NULL,
  strategy_id        text NOT NULL,
  signal_id          text NOT NULL,
  adapter_id         text,
  mode               text NOT NULL,
  symbol             text NOT NULL,
  direction          text NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  quantity           numeric NOT NULL CHECK (quantity > 0),
  entry_type         text NOT NULL,
  planned_entry      numeric NOT NULL,
  stop_loss          numeric NOT NULL,
  take_profit        numeric NOT NULL,
  status             text NOT NULL CHECK (status IN ('PENDING_SUBMIT', 'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'SHADOW', 'UNKNOWN')),
  broker_order_id    text,
  filled_quantity    numeric NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
  average_fill_price numeric,
  reject_reason      text,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL
);
CREATE INDEX orders_account_created_idx ON orders (account_id, created_at DESC);
CREATE INDEX orders_working_idx ON orders (account_id, symbol)
  WHERE status NOT IN ('FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'SHADOW');

CREATE TABLE order_events (
  seq             bigserial PRIMARY KEY,
  client_order_id text NOT NULL REFERENCES orders (client_order_id),
  at              timestamptz NOT NULL,
  type            text NOT NULL,
  detail          jsonb NOT NULL
);
CREATE INDEX order_events_order_idx ON order_events (client_order_id, seq);
CREATE TRIGGER order_events_append_only BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION astra_forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Accounts: tracking state (peaks, day-start values) and snapshot history.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE account_tracking (
  account_id text PRIMARY KEY,
  state      jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE account_snapshots (
  seq         bigserial PRIMARY KEY,
  account_id  text NOT NULL,
  as_of       timestamptz NOT NULL,
  snapshot    jsonb NOT NULL,
  state       jsonb,
  health      text,
  recorded_at timestamptz NOT NULL
);
CREATE INDEX account_snapshots_account_idx ON account_snapshots (account_id, as_of DESC);
CREATE TRIGGER account_snapshots_append_only BEFORE UPDATE ON account_snapshots
  FOR EACH ROW EXECUTE FUNCTION astra_forbid_mutation();

CREATE TABLE closed_trades (
  id              text PRIMARY KEY,
  account_id      text NOT NULL,
  client_order_id text,
  symbol          text NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  quantity        numeric NOT NULL,
  entry_price     numeric NOT NULL,
  exit_price      numeric NOT NULL,
  exit_reason     text NOT NULL,
  realized_pnl    numeric NOT NULL,
  opened_at       timestamptz NOT NULL,
  closed_at       timestamptz NOT NULL
);
CREATE INDEX closed_trades_account_idx ON closed_trades (account_id, closed_at DESC);
