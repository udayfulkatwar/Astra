# RELEASE_EVIDENCE

Three separate questions, never conflated: **software** (does the code do what it claims — tests/CI),
**trading edge** (is there a verified, repeatable advantage — `RESEARCH_REGISTRY.md`), **permitted
execution** (is live execution authorized — ADR-0008, owner only). Passing tests proves only the
first. Nothing here claims self-retraining, edge or live readiness.

## I001 integration (baseline)

| Field     | Value                                                                                      |
| --------- | ------------------------------------------------------------------------------------------ |
| Branch    | `claude/i001-integration`                                                                  |
| SHA       | `f0d79a71981036b6c06d51fdbd2768124a3d07e6`                                                 |
| CI        | run 37177481999, job 111363029335 (independently verified by the owner's reviewer)         |
| Software  | PASS — PG16, 82 files, 716 tests, 0 skips; frozen install/format/lint/typecheck/build PASS |
| Edge      | NOT_STARTED (none verified)                                                                |
| Execution | Live not authorized; paper only                                                            |

## S001 execution safety

| Field      | Value                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch     | `claude/s001-execution-safety` (from I001 `f0d79a71981036b6c06d51fdbd2768124a3d07e6`; I001 and default untouched)                                                   |
| Tested SHA | `ce12040c99b879f2a409bab1de1012e0761ab5d0` (clean tree; later commits on the branch are evidence docs only)                                                         |
| Local run  | Postgres 16.14, `TEST_DATABASE_URL` set; exit codes: frozen install 0, format 0, lint 0, typecheck 0, build 0, tests 0                                              |
| Tests      | 85 files, 788 passed, 0 failed, 0 skipped (I001 baseline 82 files / 716; the earlier 773-test candidate `c765554`/`6caeb71` was NOT accepted by independent review) |
| CI         | https://github.com/udayfulkatwar/Astra/actions/runs/37187124572 for `ce12040` — queued at the time of writing, NOT a result. Independent acceptance NOT_STARTED     |
| Software   | FAIL — independent review round 2 (released-row bypass, migration 0011 gaps, tracking weakenings); superseded by S001-R3 below                                      |
| Edge       | NOT_STARTED (none verified; see `RESEARCH_REGISTRY.md`)                                                                                                             |
| Execution  | Live NOT authorized. LIVE additionally BLOCKED by missing real-broker position↔order linkage / closure records (ADR-0027)                                           |

Review round 2 fixes (each with real-PG and/or in-memory regressions): cumulative closure coverage
(migration-independent), migration `0011` back-fill of unclosed ended orders (ambiguity fails the
migration), same-day-aware tracking merge built from persisted state, submit initiation inside the
uncertainty boundary, monotonic broker evidence (contradictory/stale/malformed evidence keeps the
reservation and marks the order UNKNOWN). Earlier proof: queued-change bug reproduced on the baseline;
persistence-delay regressions fail 5/5 with the final gate disabled.

## S001-R3 bounded account-risk repair (review round 3)

| Field      | Value                                                                                                                                                                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch     | `claude/s001-r3-risk-repair` (from reviewed `claude/s001-execution-safety` `ba8c487da4284d83045430f44bc8ef4d57afead4`; ancestry verified)                                                                                                                                              |
| Tested SHA | `c1ba5318049ea4b33696fe088fb04dbcfefb051a` (clean committed tree; later commits on the branch are evidence docs only)                                                                                                                                                                  |
| Local run  | PostgreSQL 16.14, `TEST_DATABASE_URL` set; exit codes: frozen install 0, format 0, lint 0, typecheck 0, build 0, tests 0                                                                                                                                                               |
| Tests      | 88 files, 813 passed, 0 failed, 0 skipped (round-2 candidate: 85 files / 788)                                                                                                                                                                                                          |
| Repro      | Before the fix, on `ba8c487`: 6 reproductions failed (late FILLED after REJECTED-0 applied blindly; one gateway call CONFIRMED; same-day reference 50 500→50 000; completed day 1 000→100 in memory and on two PG pools; filled-3/closed-1 released row left unreserved after upgrade) |
| CI         | Triggered by the push of this branch; see the session result for the run. A queued or cancelled run is NOT a pass. Independent acceptance NOT_STARTED                                                                                                                                  |
| Software   | IN_PROGRESS — local PASS only, pending independent CEO review. Stage 1 NOT accepted                                                                                                                                                                                                    |
| Edge       | NOT_STARTED (none verified; see `RESEARCH_REGISTRY.md`)                                                                                                                                                                                                                                |
| Execution  | Live DISABLED and NOT authorized. No real broker adapter                                                                                                                                                                                                                               |

Fixed (ADR-0027 §4, §8, migration `0012`): evidence after a release durably quarantines the account
(enforced by the gate before and after revalidation, `reserveAndConsume`, `markDispatching` and
startup reconciliation; idempotent; never re-creates the released exposure); prematurely released
uncovered rows reinstated or quarantined; legacy unknown fills UNKNOWN + quarantined; same-day
tracking references never decrease; completed-day conflicts resolved only by per-day evidence,
otherwise tracking fails closed. Two earlier tests that encoded the defects were changed (0011
unknown-fill label; a higher-ranked source lowering the same-day reference). Mutation checks: with
the post-revalidation ledger checks disabled, 3 regressions fail; with the PG quarantine check in
`reserveAndConsume` disabled, 2 fail.

Remaining risks: no clearing path for a quarantine or an unresolved history conflict (blocks the
account); a contradictory-evidence write that fails outright is protected only by the
process-local kill switch until re-applied; one bounded DB round trip separates the last ledger
read from the adapter call; queued cancel / protective-close permission checks are unchanged.
