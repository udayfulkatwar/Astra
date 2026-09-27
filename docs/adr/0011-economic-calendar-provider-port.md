# ADR-0011: Economic calendar — pulled provider port, one validated window, shared blackout rule

**Status:** Accepted · **Date:** 2026-09-27

## Context

The gate already refuses trades when the calendar is missing, stale (`calendarMaxAgeMs`) or does
not cover the blackout window, and when a restricted event is near (`calendar.event-blackout`).
Phase 4 needs the provider side: a slot for a real calendar provider (the owner has not chosen
one), validation, instrument mapping, change detection, and an operator view of event risk that
cannot drift from the gate's decision. No calendar content may be invented.

## Decision

- **New pure package `@astra/calendar`** (depends on `@astra/core` and Luxon; isomorphic,
  lint-enforced):
  - `CalendarAdapter { id, kind, fetch({ from, to }, signal) }` — providers are **pulled**: the
    `CalendarPoller` asks for [now − lookback, now + lookahead] every `pollIntervalMs` with a
    `timeoutMs` (request aborted), never overlapping itself. A failure keeps the previous window,
    which ages into STALE, so trading stops rather than continuing on an unknown calendar.
  - `CalendarService` holds one validated window (newest ingest wins): `CalendarWindowSchema`
    plus unique event ids; invalid data is refused and the previous window kept. Each source is
    bound to one `DataSourceKind`. It maps events to instruments by currency (an instrument's
    optional `eventCurrencies`; without it every currency affects the instrument — fail-safe;
    events without a currency affect all) and reports changes between windows (ADDED, REMOVED,
    RESCHEDULED, IMPACT_CHANGED, ACTUAL_RELEASED) only inside the range both cover. The API
    records them, in order, as system events (restricted impacts as warnings).
  - `eventRiskView` — CLEAR / BLACKOUT (until when, because of what) / UNKNOWN per instrument.
- **One blackout rule.** `assessBlackout` in `@astra/core` is used by the gate check and by the
  event-risk view; an uncovered or non-OK calendar is UNKNOWN, never clear.
- **Health:** CALENDAR is probed from calendar freshness each safety-loop cycle (ONLINE only
  while fresh), like MARKET_DATA.
- **Sources today:** push from n8n (`POST /api/v1/calendar/window`, MANUAL, now also returns the
  changes) and, with `ASTRA_SIMULATION=true`, the `SimulatedCalendarAdapter`: a fixed weekly
  schedule of placeholder releases, every title prefixed "SIMULATED", source kind SIMULATED
  (refused in SHADOW and LIVE). A real provider is added as another adapter once chosen
  (`calendar.provider` in `config/astra.yaml`; credentials by env-var name only).
- **API:** `GET /api/v1/calendar/risk` (event risk under the global rule, calendar metadata,
  poller status) next to `GET /api/v1/calendar/upcoming`.

## Consequences

- - Provider choice is a single adapter; validation, mapping, freshness, health, change events
    and the gate stay unchanged.
- - The operator sees exactly the blackout the gate applies, with the time it clears.
- − Windows are not persisted: after a restart the calendar is UNAVAILABLE until the next poll
  or push (fail-closed). Decision records keep the calendar each decision saw.
- − The event-risk view uses the global rule; strategy and firm rules can only widen it at
  decision time.
- − Currency mapping is only as good as `eventCurrencies`; it is unset by default (all events
  affect all instruments) until the owner reviews it.
