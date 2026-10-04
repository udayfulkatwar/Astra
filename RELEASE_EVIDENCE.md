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

| Field      | Value                                                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch     | `claude/s001-execution-safety` (from I001 `f0d79a71981036b6c06d51fdbd2768124a3d07e6`; I001 and default untouched)                                        |
| Tested SHA | `c7655546583e7f59347aa8683291bd40e02b7569` (clean tree; later commits on the branch are evidence docs only)                                              |
| Local run  | Postgres 16.14, `TEST_DATABASE_URL` set. Exit codes: frozen install 0, format 0, lint 0, typecheck 0, build 0, tests 0                                   |
| Tests      | 85 files, 773 passed, 0 failed, 0 skipped (baseline I001: 82 files / 716). New: execution 38 + 32 existing, DB reservations 12, API 4, prop-firm merge 3 |
| CI         | NOT_STARTED for this SHA (no CI run is claimed); independent acceptance NOT_STARTED                                                                      |
| Software   | IN_PROGRESS — local PASS, awaiting independent review/CI. DB-backed multi-pool tests exist; distributed correctness is claimed only to that extent       |
| Edge       | NOT_STARTED (none verified; see `RESEARCH_REGISTRY.md`)                                                                                                  |
| Execution  | Live NOT authorized. LIVE additionally BLOCKED by missing real-broker position↔order linkage (ADR-0027)                                                  |

Regression proof: the queued-change bug was reproduced on the baseline (queued approval transmitted
after a kill switch change); the persistence-delay regressions fail (5 of 5) when the final gate is
disabled.
