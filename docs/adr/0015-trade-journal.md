# ADR-0015: Trade journal — append-only, plan vs actual, observed excursions only

**Status:** Accepted · **Date:** 2026-09-27

## Context

Learning from trades (Phase 8) needs one trustworthy record per closed trade linking what ASTRA
decided with what actually happened. The no-fabrication rule applies: statistics must not be
inflated by estimated prices or back-filled data.

## Decision

- **Pure `@astra/journal`** (isomorphic): `ExcursionTracker` (best / worst exit-side price from
  observed quotes while a position is open; PARTIAL coverage when tracking began more than 5 s
  after the entry), `buildJournalEntry`, `journalStats` / `journalSummary`.
- **Entry** = decision (planned risk, config hash) + ASTRA order (plan: entry, stop, target,
  quantity) + the broker's closed trade (fill, exit, reason, gross P&L) + excursions: entry and
  exit slippage in ticks, costs from the instrument's configured commission (labelled
  `INSTRUMENT_SPEC`), net P&L, initial risk from the actual entry to the planned stop, R,
  MFE / MAE in money and R, outcome (breakeven within one tick of zero), duration, and whether it
  exited at its own stop or target. Trades without an ASTRA order are `EXTERNAL` (no plan, no R).
  Unknown values are null.
- **Recording:** the core's account sync calls the journal once per newly recorded closed trade;
  entries go to `trade_journal` (migration 0004), **append-only** (update / delete refused by
  trigger). A journaling failure is logged and raised; it never disturbs sync or trading.
- **Statistics** are descriptive over recorded trades only (n always shown): win rate, average R
  (expectancy), net / gross P&L, profit factor, max losing streak, exited-as-planned share;
  grouped by strategy, instrument and exit reason. `GET /api/v1/journal`,
  `GET /api/v1/journal/summary`; dashboard _Trade Journal_ (also in the demo).

## Consequences

- - Every closed trade is auditable against its plan; slippage and plan adherence are measurable.
- − Excursions are only as fine as the quote feed; they are not recovered after a restart
  (the entry then records `PARTIAL` or no excursion).
- − Commission comes from configuration until a live broker reports actual costs.
