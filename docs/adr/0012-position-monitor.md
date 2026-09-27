# ADR-0012: Position monitor — observe and warn, path-dependent trailing risk, no data never clears

**Status:** Accepted · **Date:** 2026-09-27

## Context

The gate protects the moment a trade is approved; afterwards nothing watched open positions.
Operators need the live distance of every position to its stop and target and of every account
to its hard limits. One risk was known and unmonitored (PROJECT_STATE known issue 4): with a
trailing intraday-equity drawdown, open profit raises the threshold, so a trade that runs up and
then reverses to its stop consumes more buffer than "every stop hit now" suggests.

## Decision

- **Pure evaluation in `@astra/risk`** (`monitorAccount`, `MonitorAlertTracker`), run by the
  core's safety loop after every account sync (and by the in-browser demo). Read model:
  `GET /api/v1/monitor/positions`; dashboard page _Position Monitor_.
- **Marks from fresh quotes only**, at the exit side (LONG → bid, SHORT → ask). Without a fresh
  quote the mark is null and the position is flagged NO_PRICE; the broker's own P&L is shown next
  to it, never substituted.
- **Per position:** P&L at the mark, initial risk, R multiple, share of the stop distance left,
  progress to the target, risk to stop incl. cost allowances; flags UNPROTECTED, NO_PRICE,
  NO_SPEC, NEAR_STOP, NEAR_TARGET.
- **Per account:** worst-case usage of the daily-loss and drawdown limits (from the account-state
  engine) and, for TRAILING_INTRADAY_EQUITY rules, the **trailing path**: every position runs to
  its target (the peak and the threshold rise, up to the lock level), then reverses to its stop.
  A position without a target makes the run-up unbounded; only the lock level then bounds the
  threshold, and without one the path risk is UNKNOWN.
- **Alerts** (system events, component `position-monitor`): raised once per crossing, escalated
  WARN → CRITICAL, cleared only past a hysteresis margin; an alert whose subject disappears
  clears. **Missing data never clears an alert**, and unknown worst-case usage with open
  positions is itself a buffer warning. Levels are `monitors.positions` in `config/astra.yaml`
  (DEFAULTS: stop 25 %, target 80 %, buffer 70 % / 90 %, hysteresis 5 points).
- **It never acts:** no order changes, no closing. Automatic protective actions (e.g. flattening
  before a trailing breach) are an owner decision and a separate change.

## Consequences

- - Every open position and every account buffer is visible and alerting, including the
    trailing-path risk the gate does not yet price.
- - Deterministic and shared between the core and the demo.
- − The gate still sizes new trades against the plain worst case; using the trailing path there
  would be stricter (a 2 R target adds 2 R of threshold rise) and is left to the owner.
- − Alerts are events; outbound notification (Telegram/Discord/email) is Phase 7 via n8n.
