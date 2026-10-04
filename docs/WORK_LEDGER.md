# ASTRA work ledger

Read this before restarting any work. One row per task. Evidence = what CI/tests actually showed,
not what a chat claimed.

| Task                          | Branch / head                                                                  | Depends on        | Accepted evidence                                                                                                                    | Gaps                                                                      | Next                                         |
| ----------------------------- | ------------------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------- |
| Task 002 calendar persistence | `task-002-calendar-persistence` `babf91160d5438463c0c714ccec5ca7b2ebf42c9`     | default `c54df2d` | Separate CI, PG16, 0 skips: 674 tests. Migration 0009 immutable                                                                      | No retention of `calendar_windows`; store failures not in health          | —                                            |
| F001 operator-flow UI tests   | in F002 branch, `83de6124da85577cabb8f338805e70de314317f9`                     | default           | Included in F002 run                                                                                                                 | —                                                                         | —                                            |
| F002 lazy page loading        | `claude/frontend-f002-page-loading` `0c0aff9959d3a68502958c86b6925fd400c5a62a` | F001              | Separate CI, PG16, 0 skips: 697 tests                                                                                                | —                                                                         | —                                            |
| R001 research validation      | `claude/research-r001-validation` `d39129afd031f78e391b19085e9ac811207dc8cb`   | default           | Separate CI, PG16, 0 skips: 663 tests                                                                                                | No strategy approved; historical LSFVG no-edge result preserved           | Pick instruments on verifiable data          |
| I001 integration              | `claude/i001-integration` (head in PR/CI report)                               | the four above    | Local, PG16 (`TEST_DATABASE_URL`): format, lint, typecheck, build, 82 files / 716 tests passed, 0 skipped. CI URL: see I001 report   | Combined CI result pending independent review                             | Independent review                           |
| Unverified chat research      | Claude chat 611bf957-bb1b-486e-ac01-69e2ef0f3a8f (`/home/claude/astra`)        | —                 | NONE — not reproduced                                                                                                                | Gold/Nasdaq/US30 backtest and payout claims unverified; files not in repo | Obtain reproducible artifacts before any use |
| S001 execution safety         | `claude/s001-execution-safety` `ba8c487`                                       | I001 `f0d79a7`    | Local PG16 pass (788 tests) but independent review round 2: FAIL                                                                     | Released-row bypass, migration 0011 gaps, tracking weakenings → S001-R3   | Superseded by S001-R3                        |
| S001-R3 risk repair           | `claude/s001-r3-risk-repair` (head in `RELEASE_EVIDENCE.md`)                   | S001 `ba8c487`    | Local PG16: frozen install, format, lint, typecheck, build, full tests (counts in `RELEASE_EVIDENCE.md`). Independent review pending | No quarantine/history-conflict clearing path; residuals in ADR-0027       | Independent CEO review                       |

Management files: [`CEO_STATE.md`](../CEO_STATE.md), [`DECISIONS.md`](../DECISIONS.md), [`RESEARCH_REGISTRY.md`](../RESEARCH_REGISTRY.md), [`RELEASE_EVIDENCE.md`](../RELEASE_EVIDENCE.md).

## Lessons (persistent engineering rules)

1. Read this ledger before restarting work.
2. Never infer that something works or tests pass from a chat claim.
3. Report exact tested SHA, test count and DB skips.
4. Keep regression tests for reproduced bugs.
5. AI may veto only.
6. Never relax safety to obtain a pass.
7. Scripted edits assert their expected match count and the diff is read; a replacement that
   silently missed `freshTracking` after reformatting went unnoticed once. Test the exact
   production path, not a look-alike.
