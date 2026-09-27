-- Phase 8 trade journal: one immutable entry per closed trade (plan vs actual, costs, R,
-- excursions), built from ASTRA's records when the broker reports the close. The full entry is
-- kept as JSON; the columns support filtering. Entries are append-only (never updated).
CREATE TABLE trade_journal (
  trade_id     text        PRIMARY KEY,
  account_id   text        NOT NULL,
  strategy_id  text        NULL,
  symbol       text        NOT NULL,
  outcome      text        NOT NULL CHECK (outcome IN ('WIN', 'LOSS', 'BREAKEVEN')),
  closed_at    timestamptz NOT NULL,
  entry        jsonb       NOT NULL,
  recorded_at  timestamptz NOT NULL
);

CREATE INDEX trade_journal_account_closed ON trade_journal (account_id, closed_at DESC);
CREATE INDEX trade_journal_strategy_closed ON trade_journal (strategy_id, closed_at DESC);

CREATE TRIGGER trade_journal_append_only
  BEFORE UPDATE OR DELETE ON trade_journal
  FOR EACH ROW EXECUTE FUNCTION astra_forbid_mutation();
