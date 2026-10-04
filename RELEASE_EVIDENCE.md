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
| Software   | IN_PROGRESS — local PASS only; distributed correctness is claimed solely to the extent of the multi-pool PostgreSQL tests                                           |
| Edge       | NOT_STARTED (none verified; see `RESEARCH_REGISTRY.md`)                                                                                                             |
| Execution  | Live NOT authorized. LIVE additionally BLOCKED by missing real-broker position↔order linkage / closure records (ADR-0027)                                           |

Review round 2 fixes (each with real-PG and/or in-memory regressions): cumulative closure coverage
(migration-independent), migration `0011` back-fill of unclosed ended orders (ambiguity fails the
migration), same-day-aware tracking merge built from persisted state, submit initiation inside the
uncertainty boundary, monotonic broker evidence (contradictory/stale/malformed evidence keeps the
reservation and marks the order UNKNOWN). Earlier proof: queued-change bug reproduced on the baseline;
persistence-delay regressions fail 5/5 with the final gate disabled.
