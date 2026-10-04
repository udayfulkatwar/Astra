# ADR-0027: Fresh pre-submit validation and durable account-wide exposure reservations

**Status:** Accepted · **Date:** 2026-10-04 · **Task:** S001

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
   never loosen (a measured/reported value beats a late guess, equal trust takes the higher),
   completed-day history is unioned, and a genuine day reset takes the NEW day's references
   (yesterday's floor is never carried over). Fresh tracking is built from the persisted state.
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
- Known limitation: evidence arriving AFTER a reservation was released as "ended with nothing
  filled" (a cancelled order that later reports a fill) is not re-checked against the released
  reservation; the order row is not protected by it.
- Reservation counts the entry/stop exposure through the existing engines; costs are exactly those
  the existing sizing and rules already include. Nothing here relaxes any limit.

## Consequences

Migration `0010` adds the ledger and reservations (and back-fills in-flight orders); `0011`
back-fills ended orders whose fills are not yet covered by recorded closures (unknown legacy fill
→ the full approved quantity is held; two unresolved exposures on one account/symbol make the
migration FAIL so a human reconciles them — it never invents flatness; no order is submitted
while migrations run, which happen before the runtime starts). Gateways
require `revalidate` and `revalidationTimeoutMs`. SHADOW keeps its semantics: re-checked control
plane, recorded, never transmitted, no reservation, no revalidation.
