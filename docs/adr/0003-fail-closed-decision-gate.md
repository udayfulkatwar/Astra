# ADR-0003: Fail-closed decision gate over frozen snapshots

**Status:** Accepted · **Date:** 2026-09-27

## Context

The spec's absolute safety principle: a trade requires every mandatory layer to pass; any
UNKNOWN/ERROR/STALE/TIMEOUT/INVALID/UNAVAILABLE result means NO TRADE (§3, §10, §49).

## Decision

- All inputs are gathered first into an immutable `DecisionContext` where every external value is
  an `Observed<T>` (explicit status). Gathering has timeouts; a timeout yields `TIMEOUT`, not a
  default value.
- Gate checks are pure, synchronous functions over that snapshot, each returning
  `PASS | FAIL | UNKNOWN | ERROR`. Exceptions are caught and become `ERROR`.
- The verdict is `APPROVED` only if **every** mandatory check returns `PASS`. The pipeline refuses
  to approve if any required layer (DATA, MARKET, STRATEGY, CALENDAR, RISK, PROP_FIRM, POSITION,
  EXECUTION, SYSTEM) has no registered check — misconfiguration cannot silently skip a layer.
- All checks run (no short-circuit) so the decision lists every reason.
- The decision (snapshot, check results, config hash) is persisted before it is returned; if
  persistence fails the verdict becomes `REJECTED`.
- Approvals expire (configurable, default 30 s) and are single-use.

## Consequences

- - Decisions are reproducible and fully explainable from the stored snapshot.
- - AI can only add restrictions (logical AND), never remove them.
- − A single flaky optional feed can block trading → intended; health dashboards make the cause visible.
