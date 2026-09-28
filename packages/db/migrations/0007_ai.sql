-- Phase 6 AI layer (ADR-0020). Every model call — sent or blocked — is logged with its tokens,
-- cost and outcome; analyses keep the brief the model saw; reviews keep their proposals, which a
-- human decides on (ASTRA never applies them). All three tables are append-only.
CREATE TABLE ai_model_calls (
  call_id        text          PRIMARY KEY,
  task           text          NOT NULL CHECK (task IN ('TRADE_ANALYSIS', 'POST_TRADE_REVIEW')),
  subject_id     text          NOT NULL,
  provider       text          NOT NULL,
  provider_kind  text          CHECK (provider_kind IN ('LIVE', 'SIMULATED', 'HISTORICAL', 'MANUAL')),
  model          text          NOT NULL,
  served_model   text,
  status         text          NOT NULL
    CHECK (status IN ('OK', 'INVALID', 'REFUSED', 'TRUNCATED', 'TIMEOUT', 'ERROR', 'BLOCKED')),
  blocked_by     text,
  started_at     timestamptz   NOT NULL,
  latency_ms     integer       NOT NULL CHECK (latency_ms >= 0),
  usage          jsonb,
  cost_usd       numeric(14,6) NOT NULL CHECK (cost_usd >= 0),
  cost_estimated boolean       NOT NULL,
  fallback_used  boolean       NOT NULL,
  error          text
);
CREATE INDEX ai_model_calls_started ON ai_model_calls (started_at DESC);
CREATE TRIGGER ai_model_calls_append_only BEFORE UPDATE OR DELETE ON ai_model_calls
  FOR EACH ROW EXECUTE FUNCTION astra_forbid_mutation();

CREATE TABLE ai_analyses (
  analysis_id  text        PRIMARY KEY,
  signal_id    text        NOT NULL,
  -- Signal id + direction + levels: an analysis never carries over to a changed signal.
  signal_key   text        NOT NULL,
  call_id      text        NOT NULL REFERENCES ai_model_calls (call_id),
  source       text        NOT NULL,
  source_kind  text        NOT NULL CHECK (source_kind IN ('LIVE', 'SIMULATED', 'HISTORICAL', 'MANUAL')),
  produced_at  timestamptz NOT NULL,
  analysis     jsonb       NOT NULL,
  brief        jsonb       NOT NULL
);
CREATE INDEX ai_analyses_signal ON ai_analyses (signal_key, produced_at DESC);
CREATE INDEX ai_analyses_produced ON ai_analyses (produced_at DESC);
CREATE TRIGGER ai_analyses_append_only BEFORE UPDATE OR DELETE ON ai_analyses
  FOR EACH ROW EXECUTE FUNCTION astra_forbid_mutation();

CREATE TABLE ai_reviews (
  review_id   text        PRIMARY KEY,
  trade_id    text        NOT NULL,
  call_id     text        NOT NULL REFERENCES ai_model_calls (call_id),
  produced_at timestamptz NOT NULL,
  review      jsonb       NOT NULL
);
CREATE INDEX ai_reviews_trade ON ai_reviews (trade_id, produced_at DESC);
CREATE INDEX ai_reviews_produced ON ai_reviews (produced_at DESC);
CREATE TRIGGER ai_reviews_append_only BEFORE UPDATE OR DELETE ON ai_reviews
  FOR EACH ROW EXECUTE FUNCTION astra_forbid_mutation();
