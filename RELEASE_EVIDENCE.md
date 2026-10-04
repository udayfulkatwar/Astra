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

Status: IN_PROGRESS — filled in by the follow-up evidence commit below once run on the exact SHA.
