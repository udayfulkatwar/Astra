# M001 — conservative legacy fill upgrade repair (migration 0013)

Status: PASS (implementation) — awaiting CEO review. Live trading DISABLED. No production-readiness or trading-edge claim.
Base: `ceo/s001-r3-review-checkpoint` @ `733bf5e8`. Branch: `claude/m001-tombstone-upgrade`. Tested code SHA: `b3b7fe94b55eed28e4f676a71805304ae9e269c5` (a docs-only commit follows).

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
