-- Phase 4 news intelligence (ADR-0019): every accepted news item with its classification as
-- recorded (classifier version kept). Items are inserted once and never edited; the in-memory
-- service keeps a rolling window and restores it from here after a restart.
CREATE TABLE news_items (
  item_key     text        PRIMARY KEY,
  source       text        NOT NULL,
  source_kind  text        NOT NULL CHECK (source_kind IN ('LIVE', 'SIMULATED', 'HISTORICAL', 'MANUAL')),
  published_at timestamptz NOT NULL,
  received_at  timestamptz NOT NULL,
  headline     text        NOT NULL,
  category     text        NOT NULL,
  impact       text        NOT NULL CHECK (impact IN ('HIGH', 'MEDIUM', 'LOW')),
  affected     text[]      NOT NULL,
  classifier   text        NOT NULL,
  news         jsonb       NOT NULL
);

CREATE INDEX news_items_published ON news_items (published_at DESC);
