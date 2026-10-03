-- Phase 4 calendar persistence (Task 002): accepted economic-calendar windows are append-only.
-- The original observation timestamp is kept so restart restoration never makes stale data fresh.
CREATE TABLE calendar_windows (
  id          bigserial   PRIMARY KEY,
  source      text        NOT NULL,
  source_kind text        NOT NULL CHECK (source_kind IN ('LIVE', 'SIMULATED', 'HISTORICAL', 'MANUAL')),
  as_of       timestamptz NOT NULL,
  from_at     timestamptz NOT NULL,
  to_at       timestamptz NOT NULL,
  window_payload jsonb    NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (to_at > from_at)
);

CREATE INDEX calendar_windows_latest ON calendar_windows (as_of DESC, id DESC);
CREATE INDEX calendar_windows_coverage ON calendar_windows (from_at, to_at);
