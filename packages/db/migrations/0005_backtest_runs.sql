-- Backtest runs (ADR-0016): each run's request and full, deterministic result, kept as recorded.
-- Results are append-only — a run is never edited; a new run gets a new id.
CREATE TABLE backtest_runs (
  run_id       text        PRIMARY KEY,
  created_at   timestamptz NOT NULL,
  created_by   text        NOT NULL,
  account_id   text        NOT NULL,
  symbol       text        NOT NULL,
  strategy_id  text        NOT NULL,
  data_kind    text        NOT NULL CHECK (data_kind IN ('STORED', 'SIMULATED')),
  from_time    timestamptz NOT NULL,
  to_time      timestamptz NOT NULL,
  config_hash  text        NOT NULL,
  request      jsonb       NOT NULL,
  summary      jsonb       NOT NULL,
  result       jsonb       NOT NULL
);

CREATE INDEX backtest_runs_created ON backtest_runs (created_at DESC);

CREATE TRIGGER backtest_runs_append_only
  BEFORE UPDATE OR DELETE ON backtest_runs
  FOR EACH ROW EXECUTE FUNCTION astra_forbid_mutation();
