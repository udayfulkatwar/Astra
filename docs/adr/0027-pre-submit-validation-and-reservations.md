# ADR-0027: Fresh pre-submit validation and durable account-wide exposure reservations

**Status:** Accepted · **Date:** 2026-10-04 · **Task:** S001 (amended by S001-R3: §4 tracking, §8, migration 0012)

## Context

An approval is a statement about one moment. Between approval and broker submission it can wait
for the account lock, for a broker snapshot and for persistence, during which a kill switch, the
mode, an authorization, the quote, the calendar, the account's equity or another symbol's order can
change. The baseline gateway checked expiry/mode/kill switches/authorization BEFORE the lock,
checked working orders and positions only for the same symbol, then consumed the approval and sent
a fixed quantity. Different symbols (and different gateway instances) could spend one allowance
twice, and an in-process mutex cannot prevent that across processes.

## Decision

1. **Control plane, repeated.** `ExecutionGateway.control` judges expiry (invalid timestamps
   refuse), LIMIT expiry, mode/policy, kill switches, account status, the current adapter and both
   live authorizations from CURRENT state. It runs after the account lock, after the broker
   snapshot, after revalidation, and twice more right before the adapter call (the last with no
   `await` before `submitOrder`). The approval is re-read each time. Every refusal is audited
   (`EXECUTION_REFUSED`) and transmits nothing.
2. **Entry revalidation by the existing engines.** `revalidateApprovedEntry` (decision package)
   re-assembles the ORIGINAL stored candidate with the same assembler and `DecisionEngine`: fresh
   executable quote/spread, calendar and news, health/readiness, the broker snapshot just read,
   tracking advanced from that snapshot (`AccountService.freshTracking`), live activity, and the
   stored AI analysis judged by the gate's own validity/freshness check (no new AI call). It also
   requires the same `configHash` and an unchanged signal/plan. It only confirms or refuses: the
   permitted size must be at least the approved size and the approved size is what is sent. The
   dependency is REQUIRED (no optional callback); errors and timeouts refuse.
   The duplicate check exempts only the current decision, in SQL (`id <> $current`), so an exempted
   row cannot mask another approval for the same signal (the schema independently forbids two
   approved decisions per account + signal).
3. **Durable account-wide reservations.** `account_exposure_ledger` (one row per account, locked
   `FOR UPDATE`, with a `version`) is the serialisation point shared by every process. The gate
   runs on `broker snapshot + reservations injected as pending orders`
   (`snapshotWithReservations`), so every existing open-risk, position-count, correlation and firm
   rule counts reserved exposure across all symbols with no parallel risk engine.
   `reserveAndConsume` then, in ONE transaction: checks the ledger version is still the one the
   gate read (else `LEDGER_CHANGED`, bounded retry with a fresh gate), the approval is still
   PENDING and unexpired, and no active reservation exists for the symbol; consumes the approval,
   creates the order, the reservation and the `SUBMIT_REQUESTED` intent plus audit entries, or
   nothing. No transaction is held across broker I/O.
4. **Final gate after the last durable wait.** Persistence (reservation commit, dispatch intent,
   audit) can take time, and a mode/expiry check alone does not prove input freshness. So after
   `markDispatching` the SAME gate runs again on a NEW broker snapshot, ledger read and
   revalidation (the order's own reservation and working record excluded via `ownClientOrderId`),
   and only then does the synchronous control-plane check precede `submitOrder` with no await in
   between. An expired quote, a new blackout, a changed limit or a lower equity during any wait
   therefore refuses, releases the (provably untransmitted) reservation and sends nothing.
   Tracking is advanced from the fresh snapshot and persisted MONOTONICALLY (`saveTracking`
   merges under a row lock; peaks and counters never decrease, an older observation never replaces
   a newer one), so a stale cache in another instance cannot lower a drawdown/daily-loss reference. The merge is
   same-day aware: peaks/counters take the max; within one trading day the day-start references
   NEVER decrease, whatever source claims a lower value (a lower correction would need separately
   evidenced, audited handling, which does not exist), and the label never claims more trust than
   the source that supplied the kept values; a genuine day reset takes the NEW day's references
   (yesterday's floor is never carried over). Completed-day history is unioned by day. Each entry
   carries `basisAt`, the time of the closing observation its P&L was computed from; a side still
   on a day the other already closed contributes the entry its own rollover would record. Two
   different P&L values for one day are resolved ONLY by a strictly later `basisAt` (evidence about
   that day, never which writer's current snapshot is newer) and the loser is kept as a
   `LATER_BASIS` conflict; anything else is `UNRESOLVED`: the higher P&L is kept (stricter
   consistency input), the conflict is persisted and sticky, and `AccountService.tracking()` /
   `freshTracking()` return a non-OK observation, so every new entry is refused. Fresh tracking is
   built from the persisted state.
5. **Dispatch intent.** `markDispatching` durably records that submit is about to start (and fails
   once the reservation is released). Orders reserved but never marked dispatched are provably
   untransmitted: the gateway (final-check failure) or restart reconciliation releases them.
6. **Release only on evidence.** A reservation is released by: broker REJECTED/CANCELLED/EXPIRED
   with nothing ever filled; proof the broker was never contacted (above); or recorded closures
   for the SAME `clientOrderId` whose CUMULATIVE quantity covers everything the order filled (a
   partial closure, e.g. fill 1 → close 1 → 2 more fill, keeps the whole reservation). A partially
   filled order that ended keeps its cumulative fill. Time, leases and a temporarily flat snapshot
   never release. Broker evidence is applied monotonically (`applyOrderState`): fills never
   decrease and the lifecycle never moves backwards; malformed, decreasing, overfilled, stale
   (out-of-order) or self-contradicting evidence (e.g. partial 1 then CANCELLED/FILLED reporting 0) is NOT applied as stated: the cumulative known fill is preserved, the full reservation is
   kept, the order becomes UNKNOWN (`STATE_CONTRADICTORY` event, execution halted by the callers)
   until a consistent authoritative state resolves it. Network uncertainty (`UNKNOWN`, lost
   response, a synchronous or asynchronous adapter failure, post-submit persistence failure) keeps
   the reservation, activates the account EXECUTION kill switch, and new entries refuse while any
   order is unresolved. A lost response is resolved by polling the broker by `clientOrderId`,
   never by resending.
7. **Positions are not netted.** `OpenPosition` carries no originating order id. A visible
   position therefore never reduces or releases a reservation: a filled order is counted twice
   (position + reservation) until its closure is recorded. This is deliberately conservative.
8. **Evidence after release; durable account quarantine (S001-R3).** `updateOrder` reads the
   order's reservation row whether active or released. Evidence for an order with no ACTIVE
   reservation is judged against its tombstone — the released row, never modified (an untransmitted
   release is recorded as REJECTED with nothing filled), or the order record if it was never
   reserved (`evidenceAfterRelease`). A consistent repeat changes nothing. Anything else — a late
   fill, a different ending, any trace of an order released as never transmitted, or UNKNOWN —
   marks the order UNKNOWN with the higher fill, appends `STATE_CONTRADICTORY`, and, once per order,
   inserts an `exposure_quarantines` row, an `ACCOUNT_QUARANTINED` audit entry and a ledger version
   bump, all in the same transaction under the ledger lock; the caller gets a contradiction and
   halts. The released exposure is NOT re-created, so a newer reservation on the same symbol is
   never erased or collided with, and the evidence can never be rolled back by a unique-index
   failure. A quarantine blocks ALL new entries on the account in every process: the gate refuses
   on it before and again after the asynchronous revalidation (bounded re-read of the ledger; in the
   final gate a changed ledger version re-runs the gate, at most three times), `reserveAndConsume`
   and `markDispatching` refuse under the ledger lock, and startup reconciliation keeps the account
   unreconciled and EXECUTION-halted. Quarantine rows are evidence (a trigger forbids delete and any
   rewrite; only a single future clearing may set `cleared_at`). **No clearing rule exists**: nothing
   in ASTRA clears a quarantine, no API offers it, and it never expires; it stays until an
   operator-audited reconciliation on authoritative broker evidence is built (a separate task).

## What is and is not safe

- **Safe (DB-tested, two pools = two processes):** two gateways/hosts on one PostgreSQL cannot
  overspend the shared allowance across symbols; a stale validation commits nothing; one active
  reservation per account + symbol is a DB invariant; UNKNOWN and in-flight state survive restart;
  DB failure before submit sends nothing; DB failure after submit yields UNKNOWN, no resend.
- **Loser behaviour:** a concurrent validator that loses the version race re-validates against the
  winner's reservation, or refuses while the winner's order is still unconfirmed. Spurious refusals
  are accepted; spurious approvals are not.
- **Not solved:** PAPER broker state is in-memory per API process (persisted fire-and-forget), so
  two API processes would hold two different paper brokers; the ledger protects ASTRA's own
  commitments, not a broker it cannot see. Run ONE execution process per paper account.
- **Not solved (blocks LIVE readiness):** a real broker adapter must expose position ↔ order
  linkage or closed-trade records keyed by `clientOrderId`; without it a filled order's
  reservation stays until an operator-audited release exists (not built). Only the paper adapter
  provides closure linkage today. An in-flight commit whose acknowledgement was lost keeps its
  symbol reserved until the next restart reconciliation.
- Evidence arriving after a release (S001-R3, §8) is checked against the tombstone and quarantines
  the account; tested on the in-memory store and on PostgreSQL with two and three pools, including
  submit-REJECTED-then-poll-FILLED in one gateway call, a late fill committed while either
  validation waits, an intervening same-symbol reservation, restart, idempotent repeats and a lost
  acknowledgement after commit.
- Residual (not solved): if the database write of contradictory evidence FAILS (nothing committed)
  the account is halted only by the process-local EXECUTION kill switch, and the released order is
  terminal in ASTRA's records, so after a restart nothing re-polls it; the evidence quarantines the
  account only when it is applied again. The fill then still appears as a broker position, which
  the risk engines count from the snapshot. A periodic re-verification of recently ended orders
  is not built.
- Residual (not solved): the last ledger read precedes the adapter call by one bounded database
  round trip and a synchronous control-plane check; evidence committed inside that window is
  applied after the submit (the quarantine then blocks every later entry). No transaction is held
  across broker I/O by design.
- Residual (not solved): a quarantine and an `UNRESOLVED` completed-day conflict have no audited
  clearing path; they keep the account blocked until one is built.
- Reservation counts the entry/stop exposure through the existing engines; costs are exactly those
  the existing sizing and rules already include. Nothing here relaxes any limit.

## Consequences

Migration `0010` adds the ledger and reservations (and back-fills in-flight orders); `0011`
back-fills ended orders whose fills are not yet covered by recorded closures (unknown legacy fill
→ the full approved quantity is held; two unresolved exposures on one account/symbol make the
migration FAIL so a human reconciles them — it never invents flatness; no order is submitted
while migrations run, which happen before the runtime starts). `0011` skipped any order that had a
reservation row at all, including rows released prematurely by an earlier candidate, and labelled
legacy FILLED-with-no-recorded-fill as FILLED. Corrective `0012` (0010/0011 unchanged) adds
`exposure_quarantines`, re-checks every released row against cumulative closure coverage —
reinstating a consistent, uncovered, unambiguous one (its prior release kept as a
`RESERVATION_REINSTATED` event) and quarantining the account for a contradictory or colliding one
(tombstone untouched) — and turns legacy unknown fills into UNKNOWN orders (polled at startup,
never resent) with an account quarantine. Fully proven closures are left as they are. Gateways
require `revalidate` and `revalidationTimeoutMs`. SHADOW keeps its semantics: re-checked control
plane, recorded, never transmitted, no reservation, no revalidation.
