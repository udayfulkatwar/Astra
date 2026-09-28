# ADR-0021: n8n workflows — generated from tested code, ASTRA computes, n8n delivers

**Status:** Accepted · **Date:** 2026-09-28

## Context

Phase 7 needs n8n workflows for ingestion, signal intake, notifications and reports
(ARCHITECTURE §7). Hand-written workflow JSON is untestable, drifts, and invites secrets and
logic into places nobody reviews. n8n must never decide anything (ADR-0005), and a broken or
unconfigured workflow must never make ASTRA believe a feed is healthy.

## Decision

- **Generated workflows.** A workspace package `@astra/n8n`:
  - Code-node logic lives in `src/nodes/*.ts`: pure functions, strict TypeScript,
    unit-tested.
  - `src/workflows.ts` defines the workflows. The builder transpiles each node module
    (import-free) into the Code node.
  - Tests check that the committed JSON matches the generator, that connections and ids are
    valid, and that every ASTRA call uses the named credential. They also check there are no
    tokens and no environment access in any workflow.
  - They run the generated Code-node JavaScript the way n8n does.
- **ASTRA computes, n8n delivers.**
  - Reports come from a new `GET /api/v1/reports` (daily / weekly, per account's firm trading
    day), built from ASTRA's records:
    - trades, R and P&L;
    - gate approvals / rejections with the most common failed checks;
    - account state now;
    - AI calls and cost;
    - errors, kill switches and components not online.
  - The report is returned as JSON plus ready-to-send text.
  - Alerts poll `GET /api/v1/events?afterSeq=&order=asc` (oldest first after a cursor kept in
    n8n static data), so none are skipped.
- **Fail-closed ingestion.**
  - News (RSS / Atom, parsed without dependencies) and calendar (`astra-window`, or an
    unverified ForexFactory-style mapper) stop the run on any failed fetch, unreadable
    document or bad field.
  - The "(edit me)" source lists ship empty and stop the run with an explanation.
  - A stopped run pushes nothing, so ASTRA's feed goes stale and no new trades are approved.
    Items without a publication time are dropped, never dated by guess.
  - Calendar sources are merged only when they touch, so a gap is never claimed as "no events".
- **Signal webhook.**
  - The alert is reshaped into a candidate and submitted to the gate, and the decision is
    returned to the sender. Header-auth credential; `autoExecute` defaults to false.
  - Retries in the same minute get the same signal id, so the duplicate check refuses them.
- **Notifications.**
  - One Notify sub-workflow delivers to Telegram, Discord and/or email.
  - With no channel enabled it fails loudly, visible in ASTRA.
  - Failures of Alerts / Notify are not re-alerted, to avoid loops.
- **Secrets only in n8n credentials,** referenced by name. Code nodes cannot read the
  environment.

## Consequences

- \+ Every workflow was imported, published and run in a real n8n 2.40.7 against ASTRA:
  - heartbeat;
  - news and calendar pushes accepted;
  - the signal webhook (403 without the secret; a gate decision with it);
  - an alert and a daily report delivered by email;
  - errors reported through the error workflow.
- \+ Workflow logic is reviewed and tested like the rest of ASTRA.
- − Edits made in the n8n editor are not reflected back into the repository; the "(edit me)"
  nodes are the intended exceptions.
- − n8n 2.x runs only published workflows. Notify and the error handler must be published too.
- − Pushed data is MANUAL (PAPER only) until real provider adapters deliver LIVE data.
