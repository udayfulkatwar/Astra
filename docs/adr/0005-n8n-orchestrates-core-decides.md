# ADR-0005: n8n orchestrates, ASTRA Core decides

**Status:** Accepted · **Date:** 2026-09-27

## Context

The spec names n8n as the automation orchestrator (§6) but also requires deterministic safety
authority (§40) and says n8n failure must not be assumed healthy (§53).

## Decision

- n8n owns _when_ (schedules, event fan-out), data fetching, AI-analysis requests, notifications,
  reports. It talks to ASTRA only through the authenticated `automation` role.
- ASTRA Core owns _whether_: risk, prop-firm rules, kill switches, decisions, execution. n8n never
  talks to brokers and never holds broker credentials.
- Safety-critical monitoring (account state, halts, position monitoring, order confirmation) runs
  in-process inside the core so it continues when n8n is down.
- n8n liveness is a heartbeat; a stale heartbeat makes automation health `UNKNOWN`, which blocks
  new trades (configurable per deployment, on by default).

## Consequences

- - A broken or compromised workflow cannot bypass safety; it can only submit candidates that are
    fully re-validated.
- - Clear split of responsibilities; workflows remain replaceable.
- − Two places to look when debugging a cycle → mitigated by `workflowRunId` correlation in audit.
