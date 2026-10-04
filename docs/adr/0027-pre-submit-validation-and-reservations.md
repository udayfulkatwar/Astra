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
   **4a. Final synchronous guard (F003).** The final gate still ends with one more durable wait (the
   shared-ledger read after revalidation), during which quotes/account inputs age, blackout,
   session or trading-day boundaries cross and providers/health/control can change. Every
   successful `revalidateApprovedEntry` therefore carries a REQUIRED synchronous `finalGuard`
   (`EntryRevalidation.finalGuard`) that keeps the assembled evidence WITH its provenance (each
   observation's own `asOf`/source; every FX quote consulted, kept in `AssemblyProvenance`). After
   ALL awaited work, with no `await` before `adapter.submitOrder`, the gateway runs `control()`,
   verifies the bound adapter identity, `accountRef` and account id are the ones the snapshot and
   reservation were made for, then invokes the guard. The guard (a) refuses an invalid or
   backward clock; (b) requires the same `configHash`; (c) refuses when the profile's trading day
   (`tradingDayWindow(now, profile.tradingDayReset)`) is no longer the captured tracking's day
   (reassemble, never reuse yesterday's reference); (d) re-ages the captured tracking, activity
   and duplicate observations with the account-snapshot limit (existing policy, no new knob) and
   every FX quote with the quote limit, each at its own timestamp; (e) reads the CURRENT
   provider state (`CurrentEvidencePorts`: quote, FX pairs, calendar, news): a provider that is no
   longer OK voids the captured evidence even with a fresh timestamp, and a current OK quote,
   calendar window or news risk REPLACES the captured one (keeping its own `asOf`/source), so a
   calendar revision, a news-risk change or a moved/widened quote is judged by the engine; an FX
   rate whose current value differs from the one the valuation used refuses; (f) re-runs the real
   `DecisionEngine` with the CURRENT clock, mode, kill switches, component health, execution
   readiness, live authorization and those current observations; (g) repeats the original
   plan/quantity matching. Evidence is never re-stamped as newly observed.
   A missing, throwing, asynchronous (thenable) or malformed guard refuses before transmission and
   the reservation is released, or kept for reconciliation if the release itself fails. The
   assembler takes ONE decision time after its last awaited fetch, so a slow later FX fetch cannot
   make an earlier rate look fresh.
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
  round trip; since F003 the time/provider/control side of that window is closed by the
  synchronous final guard (§4a), but ledger evidence (e.g. a late fill) committed inside it is
  still applied after the submit (the quarantine then blocks every later entry). No transaction
  is held across broker I/O by design. The stored AI analysis has no provider to re-read: only
  its age is re-judged. The activity/tracking age limit reuses the account-snapshot limit.
- Residual (not solved): a quarantine and an `UNRESOLVED` completed-day conflict have no audited
  clearing path; they keep the account blocked until one is built.
- Reservation counts the entry/stop exposure through the existing engines; costs are exactly those
  the existing sizing and rules already include. Nothing here relaxes any limit.

## 9. Single-owner PAPER sessions, revisioned snapshots, crash recovery (R004)

Paper state lives in one process's memory and is persisted by snapshots, so a crash can lose a
mutation that the ledger, orders or evidence never saw (a quote-driven fill whose save failed, an
UNKNOWN/kill-switch write lost in an outage) while every order looks terminal or released.

- **Exclusive owner, DIRTY first (migration 0015).** `paper_owner` has one row per paper adapter.
  A process owns paper only while it holds a session advisory lock on its own dedicated
  connection AND has COMMITTED a DIRTY session row (the ACK) — before it restores, mutates or
  reads any paper state or interacts with the broker. A competitor refuses while the lock is
  held. The row stays DIRTY for the whole session.
- **Unclean prior session ⇒ durable block.** A new session that finds anything but a CLEAN row
  with checkpoints equal to the stored snapshot revisions quarantines EVERY paper account in the
  same transaction that installs its own DIRTY row (an active quarantine blocks entries in the
  gateway and in the database `reserveAndConsume`/`markDispatching`, with no kill switch needed).
  A stale snapshot cannot prove no mutation was lost; this is deliberately conservative and has
  no automatic clearing. Losing the lock alone never admits a takeover without that quarantine.
  After an unclean session reconciliation also reads the evidence of ENDED (terminal/released)
  orders from the restored broker and judges it against the tombstones: late evidence quarantines,
  an order the restored broker no longer knows is recorded as `RECOVERY_EVIDENCE_MISSING`;
  nothing is released, re-opened or resent.
- **Ownership is rechecked, not just at startup.** A synchronous owner flag feeds the gateway's
  control check (so the final synchronous entry check sees it), readiness and the paper broker
  (quotes ignored, every interaction rejects). It is refreshed by a keepalive, by `verify()` before
  the durable reserve/dispatch steps and every operation, and by failed fenced writes.
- **Revisioned, immutable snapshots with real ACKs.** Each change captures a deep-copied snapshot
  with a strictly increasing revision; `paper_broker_state.save` accepts it only from the DIRTY
  owner session and only if newer. A failed save is never absorbed: it halts readiness, no later
  revision is ACKed, and `flush()` rejects.
- **Clean stop.** Stop quote/action producers and new actions, drain operations and saves, persist
  a final checkpoint per account, and only after those ACKs mark CLEAN in a transaction that
  re-verifies every checkpoint revision. Any failure leaves DIRTY. A CLEAN commit whose
  acknowledgement is lost may be persisted: the error says so, and the next start verifies the
  matching checkpoints instead of assuming either outcome. No DB/broker atomicity or client ACK
  receipt is claimed.
- `unknown()` reports the real persistence outcome of the UNKNOWN state, evidence and halt writes.
- **Review corrections.** (1) The lock lives on a pinned dedicated connection (no idle close, no
  max-lifetime recycling); `verify()` proves the ORIGINAL backend pid still holds the granted
  advisory lock (`pg_locks`) and the DIRTY row is ours, and any loss — including the connection
  closing, observed at once — latches permanently; a later successful query on a reconnected
  backend never revives it. (2) No owner row is NONE only on a truly empty install: paper
  snapshots, orders or reservations without an ownership record are legacy evidence ⇒ UNCLEAN. (3)
  CLEAN requires the checkpoint account set to EQUAL the stored snapshot set with matching
  revisions and session (a deleted, extra or changed row quarantines; `markClean` refuses a
  mismatch). (4) Durable session fence: `reserveAndConsume`/`markDispatching` take the owner
  session id and refuse unless it is the DIRTY session in `paper_owner`, read FOR SHARE FIRST
  (same lock order as acquire, markClean and snapshot saves: owner row, then ledger/snapshot), so
  an ownership change during the wait also refuses; the production repository is PAPER-fenced and
  a missing owner row fails closed (unit fixtures and non-paper adapters are unaffected).
  Snapshot saves run in one transaction under that same owner lock; an identical-content resend of
  the same revision is an ACK, different content or any stale session is refused. (5) Recovery
  pages through EVERY ended order by primary key. (6) Drain: all paper work is an admitted
  activity (gateway calls, the safety cycle, entries, startup); once closing, new top-level
  activity and every top-level broker call are refused BEFORE they run, work started inside an
  admitted activity may finish (async-local scope), the in-flight set is drained until empty
  (including work admitted after the first snapshot) and the broker is sealed in the same
  synchronous step; only then is the final checkpoint taken. `exportAccount` (the checkpoint
  snapshot) and the DIRTY-ACKed restore calls are the only internal exceptions; `paper()` is the
  same object and every state-touching method carries the same owner guard.

Not solved: distributed takeover, an audited quarantine clearing path, recovery that proves and
re-applies lost mutations (every unclean paper session blocks the account until one exists), a
real broker (this covers the PAPER adapter only), and the DB ownership check inside
`reserveAndConsume` itself (ownership is verified by the caller just before it).

## 10. Queued risk-reducing actions re-read permission (S002)

`cancelWorking` and `protectiveClose` used to judge mode, kill switches and the adapter BEFORE
waiting for the account lock, so a request queued behind another action could run on a stale
permission or binding. Now `reductionControl` (synchronous, current state) runs once for an early
refusal and records the broker binding the request was made against; inside the lock it runs again
(and after every awaited read) and immediately before the broker call with no await in between.
It requires: not SHADOW/BACKTEST (never transmit); kill-switch state loaded and no EXECUTION
switch; the account and its CURRENT binding exist and equal the queued binding (never redirected to
another adapter or broker account); the adapter kind matches the mode; any LIVE adapter has the
existing environment + account authorization. HALTED mode and GLOBAL/ACCOUNT/STRATEGY/INSTRUMENT
switches still never block a reduction. A cancel also verifies the stored order belongs to the
requesting account and was placed through the current adapter. Evidence/halt write failures after
the broker answered are reported exactly (UNKNOWN, execution halted, reservation kept, nothing
released or resent); a halt that is only in memory is reported as not persisted. R004 ownership,
admission and drain fencing are unchanged (gateway calls remain admitted activities).

Review corrections: the queued binding pins the adapter INSTANCE and its kind as well as the
adapter id and broker account, so a different object registered under the same id/ref while the
request waited is refused before any call. A cancel reports each durable step separately (broker
answer; order-state evidence recorded or NOT; audit event appended or NOT; halt persisted or NOT)
and never asserts the reservation is kept: the recorded terminal state may already have released
it, which the store (not the message) decides. An EXECUTION halt that is only in memory blocks local
paper admission, refuses a clean stop (the session stays DIRTY, so the next start quarantines) and
is reported to the caller as not persisted.

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
