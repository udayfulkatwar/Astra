# ADR-0013: The gate prices the trailing intraday-equity path

**Status:** Accepted (owner decision, 2026-09-27) · Supersedes the "gate use" consequence of ADR-0012

## Context

With a TRAILING_INTRADAY_EQUITY drawdown, open profit raises the threshold. ADR-0012 made the
position monitor price the worst path — run (almost) to the target, then reverse to the stop — but
the gate still sized and approved new trades against "every stop hit now". The owner decided the
gate must use the path as well, accepting stricter sizing.

## Decision

- `trailingExposure` and `trailingConsumption` / `maxQuantityWithinTrailingPath` in
  `@astra/prop-firm` are the single implementation, used by the gate, sizing, the survival check
  and the monitor.
- While the threshold is **unlocked**, a new trade consumes its stop loss **plus** the threshold
  rise its run-up to target can cause, bounded by what is left to the lock level:
  - prop-firm rule `drawdown-worst-case` checks the path (details `mode: TRAILING_PATH`);
  - position sizing adds a QUANTITY cap `trailing-drawdown-path` (the drawdown buffer share of
    the path remaining, after the survival buffer and the health multiplier);
  - the survival-buffer check re-verifies the path independently.
- Unknown path risk (an open position without a target and a threshold that never locks, or no
  instrument spec) → the rule is UNKNOWN and sizing refuses: no trade. A locked threshold falls
  back to the plain worst case. Other drawdown types are unchanged.

## Consequences

- - A trade can no longer be approved that a run to target followed by a stop-out would breach.
- − Sizing is materially smaller on unlocked trailing accounts (a 2 R target adds 2 R of
  threshold rise), especially early in an evaluation.
