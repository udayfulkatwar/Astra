-- LIMIT entries (ADR-0023): a resting entry order is cancelled at the broker at expires_at.
-- NULL for MARKET orders (they fill or fail at once).
ALTER TABLE orders ADD COLUMN expires_at timestamptz;
