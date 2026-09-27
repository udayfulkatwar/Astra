# ADR-0014: Automatic protective closing

**Status:** Accepted (owner authorisation, 2026-09-27) · Supersedes ADR-0012's "it never acts"

## Context

The position monitor (ADR-0012) warns. The owner authorised ASTRA to close positions by itself
when hard rules demand it — before a prop-firm limit is breached, when a position is unprotected,
and at the firm's mandatory flat time. Closing is an execution action, so it must be deterministic,
auditable, idempotent and must not make things worse when the execution path itself is suspect.

## Decision

- **Triggers** (pure `ProtectionEvaluator` in `@astra/risk`, on monitor views; one action per
  position, most important first):
  1. `LIMIT_PROXIMITY` — a hard limit (daily loss, max drawdown incl. a trailing threshold) is
     `flattenAtLimitUsagePct` (default 90 %) used **at the current mark** → close every position;
     block the account first with an ACCOUNT kill switch (until the next trading day for the daily
     limit, manual clear for drawdown).
  2. `FLAT_BY` / `WEEKLY_CLOSE` — within `flattenMinutesBeforeFlat` (default 2) of the profile's
     mandatory flat time, or of the weekly close when weekend holding is prohibited → close every
     position; a position opened before the last such deadline was held through it → close it.
  3. `UNPROTECTED` — no stop for `unprotectedGraceMs` (default 10 s) → close that position.
- **Execution:** `BrokerAdapter.closePosition` (new port method: market close + cancel its
  protective orders, idempotent on `clientCloseId`) via `ExecutionGateway.protectiveClose`, under
  the account's execution lock. Risk-reducing, so it is **not** blocked by mode or GLOBAL /
  ACCOUNT / STRATEGY / INSTRUMENT kill switches — but **never** sent while an EXECUTION kill switch
  is active (the execution path is suspect → a human acts), never in SHADOW or BACKTEST (nothing
  is transmitted there). An unknown outcome halts execution for the account like an unconfirmed
  order. A rejected close is retried with a new id up to `maxCloseAttempts` (default 3), then
  reported as GAVE_UP — manual action required.
- **Record:** every attempt is a CRITICAL system event (`PROTECTIVE_CLOSE_*`) and an audit entry
  (category PROTECTION); the paper broker records the exit as `PROTECTIVE`. Skips and give-ups
  are reported once, not every cycle. Status and recent actions:
  `GET /api/v1/monitor/positions` → `protection`; dashboard Position Monitor.
- **Config:** `protection` in `config/astra.yaml` (enabled by the owner; every level adjustable).

## Consequences

- - Breach-bound accounts are flattened and locked before the firm's rule is crossed; naked
    positions and positions held through a mandatory flat time do not survive.
- - Same code path in the core and the demo; deterministic and fully audited.
- − A market close at 90 % can realise a loss that a recovery would have avoided — the owner
  chose protection over that chance. Fast gaps can still breach between two cycles (2 s).
- − Real brokers must implement `closePosition` faithfully (reduce-only, cancel brackets); this is
  part of each LIVE adapter's acceptance.
