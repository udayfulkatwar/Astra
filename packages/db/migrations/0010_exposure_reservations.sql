-- Durable account-wide exposure reservations (ADR-0027).
--
-- A reservation is created in the same transaction that consumes an approval and creates its
-- order. It is released only on authoritative evidence (broker rejection/cancellation of an
-- unfilled order, confirmation of the resulting position in a broker snapshot, recorded closure,
-- or proof that the broker was never contacted) — never because time passed.
-- account_exposure_ledger is the per-account serialisation point: its row is locked
-- (SELECT … FOR UPDATE) by every reservation write, and `version` is the optimistic token a
-- validation must still see at commit.

CREATE TABLE account_exposure_ledger (
  account_id text PRIMARY KEY,
  version    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL
);

CREATE TABLE exposure_reservations (
  id                  text PRIMARY KEY,
  account_id          text NOT NULL,
  client_order_id     text NOT NULL UNIQUE REFERENCES orders (client_order_id),
  approval_id         text NOT NULL UNIQUE,
  strategy_id         text NOT NULL,
  symbol              text NOT NULL,
  direction           text NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  entry               numeric NOT NULL,
  stop                numeric NOT NULL,
  target              numeric NOT NULL,
  quantity            numeric NOT NULL CHECK (quantity > 0),
  reserved_quantity   numeric NOT NULL CHECK (reserved_quantity >= 0),
  filled_quantity     numeric NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
  average_fill_price  numeric,
  order_status        text NOT NULL,
  dispatched_at       timestamptz,
  reserved_at         timestamptz NOT NULL,
  released_at         timestamptz,
  release_reason      text,
  CHECK ((released_at IS NULL) = (release_reason IS NULL))
);
-- One active reservation per account and symbol, enforced by the database itself.
CREATE UNIQUE INDEX exposure_reservations_active_symbol
  ON exposure_reservations (account_id, symbol) WHERE released_at IS NULL;
CREATE INDEX exposure_reservations_account_idx
  ON exposure_reservations (account_id) WHERE released_at IS NULL;

-- Orders already in flight when this migration is applied keep their exposure: reserve them
-- (dispatched: they were created by the previous gateway, which sent them).
INSERT INTO exposure_reservations
  (id, account_id, client_order_id, approval_id, strategy_id, symbol, direction, entry, stop, target,
   quantity, reserved_quantity, filled_quantity, average_fill_price, order_status, dispatched_at, reserved_at)
SELECT 'rsv_migrated_' || o.id, o.account_id, o.client_order_id, o.approval_id, o.strategy_id, o.symbol,
       o.direction, o.planned_entry, o.stop_loss, o.take_profit, o.quantity, o.quantity,
       o.filled_quantity, o.average_fill_price, o.status, o.created_at, o.created_at
  FROM orders o
 WHERE o.status NOT IN ('FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'SHADOW');
INSERT INTO account_exposure_ledger (account_id, version, updated_at)
SELECT DISTINCT account_id, 1, now() FROM exposure_reservations;
