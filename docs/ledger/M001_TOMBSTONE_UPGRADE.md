# M001 — conservative legacy fill upgrade repair (migration 0013)

Status: PASS (implementation, second repair) — awaiting CEO review. Live trading DISABLED. No production-readiness or trading-edge claim.
Base: `ceo/s001-r3-review-checkpoint` @ `733bf5e8`. Branch: `claude/m001-tombstone-upgrade`. Tested code SHA (final): `12e5d8b850f7cd2a3123b8cc1e7c5f057cafdbe2` (earlier: `b3b7fe94`) (a docs-only commit follows).

## Defect (0012, immutable)

0012 judged a released reservation by the ORDER record alone. Legacy `updateOrder` overwrote the order after a premature release, so:

1. tombstone FILLED/3, order CANCELLED/0, closed 1: omitted by the upgrade (looked like a clean cancel);
2. tombstone FILLED/3, order FILLED/1, closed 1: looked covered;
3. (CEO addition) tombstone FILLED/3, order FILLED/1, closed 0: 0012 REINSTATED and overwrote the tombstone fill 3 -> 1; its event kept only the order fill, so the original is irrecoverable.

## Fix: `packages/db/migrations/0013_tombstone_conservative_quarantine.sql` (pure DML, idempotent)

Durably quarantines the account (blocks `reserveAndConsume`) and appends an `order_events` row; tombstone and order rows are never rewritten, nothing is reinstated or cleared. Triggers:
a. tombstone fill > order fill and closures < tombstone fill (stronger evidence never decreases);
b. tombstone not an ended state yet released by something other than "not transmitted" (UNKNOWN/working is not proof of no fill);
c. tombstone FILLED with zero recorded fill and closures < ordered quantity (unknown size);
d. order record UNKNOWN after a release;
e. every `RESERVATION_REINSTATED` (migration 0012) row: prior tombstone fill UNKNOWN, unless closures cover the ordered quantity.
Rows with an active quarantine are skipped, so re-running changes nothing (no ledger bump). Fully closed consistent rows, clean rejections and newer same-symbol/other-symbol active reservations are untouched.

## Assumptions and conservative overblocking

- A tombstone fill never exceeds the ordered quantity, so closures >= ordered quantity prove coverage.
- Trigger (e) over-blocks a 0012 reinstatement that was in fact correct (e.g. premature release of 3 with 3 true fills): the audit cannot prove it, so the account stays blocked until an audited reconciliation exists (none yet; no automatic clearing). The existing test in `late-evidence.test.ts` that expected no quarantine after reinstatement now expects one.
- UNKNOWN tombstone with zero fills (b) and order UNKNOWN (d) are treated fail-closed; UNKNOWN is never read as "no fill".
- Direct upgrades from 0010/0011 run 0012 and 0013 in one transaction; the erased value cannot be intercepted, hence (e).

## Evidence

Unchanged base (0013 removed), real PostgreSQL 16.14: `packages/db/test/tombstone-upgrade.test.ts` fails 6/6 (cases cancelled0, filled1, collided tombstone, UNKNOWN tombstone, reinstated-erased, from 0010/0011/0012); with 0013 it passes. Full gate on the tested SHA: install/format/lint/typecheck/test/build all exit 0; 89 files, 819 tests, 0 skipped (PG 16.14 local; CI uses 16.15).

## Review follow-up: migration 0014 (supersedes 0013 trigger e's exception)

CEO review rejected 0013's exception "closures cover the ORDERED quantity prove coverage": legacy `applyOrderState` had no upper fill bound and 0010 only checks `fill >= 0`, so a tombstone could record FILLED 4 of ordered 3, be erased to 1 by the 0012 reinstatement, and later closures 1 + 2 = 3 = ordered while 4 is open. The assumption in the Assumptions section above ("tombstone fill never exceeds the ordered quantity") is therefore WITHDRAWN.
`0013` is preserved unchanged (it may already be applied). Immutable `packages/db/migrations/0014_unproven_reinstatement_quarantine.sql` quarantines EVERY order reinstated by 0012 (event `RESERVATION_REINSTATED`, migration 0012) that has no active quarantine, whatever closures exist, recording prior tombstone fill UNKNOWN and an `REINSTATEMENT_EVIDENCE_UNPROVEN` event. No independent authoritative evidence of the original fill exists in this schema, so none is accepted. Orders, tombstones, reservations (incl. newer commitments) and existing quarantines are untouched; no automatic clearing; re-running is a no-op.
Overblocking: a correctly reinstated order is also quarantined until an audited reconciliation exists. Non-reinstated consistent full closures stay closed and admitted (control tests pass). The old covered-reinstatement test expectation was changed accordingly.
Tests: `tombstone-upgrade.test.ts` now upgrades from 0010, 0011, 0012 and 0013-applied databases, includes the overfill (4 of 3 -> 1, closures 1+2) regression, real `reserveAndConsume` refusal, and idempotence by repeat migration and by re-executing 0013 and 0014 SQL. Old head (0013 only) failed the overfill and reinstated-covered expectations on the 0012- and 0013-applied paths (a harness ENOENT for the then-missing 0014 file also failed the 0010/0011 runs, so those failures are less specific).
