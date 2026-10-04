# Latest independent CEO evidence — 4 October 2026

Candidate a85323928d74ee18417cc50d181bb46e774c7e56: software checks PASS (run 37189561759, job 111398729769; 88 files, 813 tests, zero skips; PostgreSQL 16.15). Safety acceptance FAIL. See docs/ledger/S001_R3_CEO_REVIEW.md. This documentation checkpoint changes no application code; it is not a new accepted/tested operating release. Prior candidate evidence follows.

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

## F003 final synchronous entry freshness guard

| Field      | Value                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch     | `claude/f003-final-freshness` from accepted M001 `3cd84145ee3c73b9b80e79ff7ac2c76e7358ca28` (ancestry verified, clean tree)                                                                                   |
| Rejected   | `f0b2c283` (CI 37229648831 typecheck: invalid test health status; guard read current quote/calendar/news only for status). `9fc9b048` (source review PASS; CI 37230123250 typecheck: API test payload typing) |
| Tested SHA | `2e75b104d57b3ac7adfcac9d7c1053f506502534` (clean committed tree; this evidence commit is docs only)                                                                                                          |
| Local run  | PostgreSQL 16.14, `TEST_DATABASE_URL` set; exits: frozen install 0, format 0, lint 0, typecheck 0, tests 0, build 0                                                                                           |
| Tests      | 92 files, 857 passed, 0 failed, 0 skipped (M001 baseline 89 files / 820)                                                                                                                                      |
| CI         | Run 37230464693 / job 111518851649 on `2e75b104`: install/format/lint/typecheck PASS; test/build result to be recorded by the reviewer. Not claimed as passed here                                            |
| Software   | IN_PROGRESS — pending independent acceptance. Stage 1 NOT accepted; live DISABLED; no edge claim; migrations unchanged                                                                                        |

Old-base proof (executable, composed API + real PostgreSQL ledger + real `DecisionEngine`; final
shared-ledger read held while the world changes): on `3cd84145` the stale-quote and event-blackout
regressions fail (order CONFIRMED, i.e. submitted); against `f0b2c283` the calendar-revision (two
variants) and news-risk-to-HIGH regressions fail; on the final head all pass, plus the positive
unchanged path submits once. Unit/gateway coverage (`packages/decision|execution/test/final-guard.test.ts`):
account/FX/quote/calendar/news aging, signal expiry, trading-day reset, health/provider revocation,
changed current calendar/news/quote/FX values, adapter and accountRef rebinding, invalid and
backward clock, missing/throwing/thenable/malformed guard (reservation kept if release fails), no
call between guard and `submitOrder`, delayed second FX fetch expiring the first rate.

Remaining gaps: R004 durable failure/restart ownership; S002 queued cancel / protective-close
permissions; no quarantine clearing path; ledger evidence committed inside the last round trip is
applied after submit; stored AI analysis has no provider to re-read (age only); activity/tracking
age reuses the account-snapshot limit; real-broker linkage absent.
