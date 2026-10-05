# Stage 1 evidence index — 4 October 2026

Accepted (independent review + exact-head CI, PostgreSQL 16.x, 0 skips) vs rejected history. Sections
below are chronological per-task records; their "remaining risks" paragraphs are snapshots at that
task, and the standing limitations are in `CEO_STATE.md` / `docs/PROJECT_STATE.md`.

| Task                                 | Accepted code (docs head)                                       | CI run / job               | Files / tests | Rejected before acceptance                                |
| ------------------------------------ | --------------------------------------------------------------- | -------------------------- | ------------- | --------------------------------------------------------- |
| M001                                 | `3cd84145ee3c73b9b80e79ff7ac2c76e7358ca28`                      | 37194795717 / 111414315319 | 89 / 820      | S001-R3 `c1ba5318` (CI 813 PASS, safety FAIL)             |
| F003                                 | `2e75b104d57b3ac7adfcac9d7c1053f506502534` (`aa75c01e`)         | 37230464693 / 111518851649 | 92 / 857      | `f0b2c283`, `9fc9b048` (CI typecheck)                     |
| R004                                 | `8c57e6be5b7f9757bb381be26985a405804ab2c5` (`05fc2ef0`)         | 37236216419 / 111535726577 | 97 / 897      | `484c9a5c` (CI PASS 37232550276, safety FAIL), `230478e8` |
| S002                                 | `cee9b7a13f23ce374c189067953468a5fed45e76` (`728ac6d7`)         | 37239168847 / 111544207158 | 99 / 938      | `0dd69ca2` / `11ffee72`                                   |
| Stage 1 integrated                   | `dcb4f692882137d4b8081c45b393cfe24952b223` (`b9c3b890`)         | 37240369181 / 111547727471 | 100 / 945     | —                                                         |
| P002 offline (contract/journal/fake) | `d84459056f315e59a803348094014bb64b6aaa07` (offline scope only) | 37264810187 / 111619242401 | 103 / 1108    | `19bbf93a`, `be2cb5b3` (CEO safety reviews)               |

The Stage 1 integrated candidate's section and its CEO acceptance record follow below.

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
| Tested SHA | tested/accepted code `2e75b104d57b3ac7adfcac9d7c1053f506502534`; later commits on the branch are documentation only and were not themselves run through CI as code                                            |
| Local run  | PostgreSQL 16.14, `TEST_DATABASE_URL` set; exits: frozen install 0, format 0, lint 0, typecheck 0, tests 0, build 0                                                                                           |
| Tests      | 92 files, 857 passed, 0 failed, 0 skipped (M001 baseline 89 files / 820)                                                                                                                                      |
| CI         | Run 37230464693 / job 111518851649 on `2e75b104`: PASS frozen install/format/lint/typecheck/test/build, PostgreSQL 16.15, 92 files, 857 tests, 0 skips (independently verified by the CEO)                    |
| Software   | F003 PASS for accepted code `2e75b104` (bounded software-safety scope). Stage 1 IN_PROGRESS, NOT accepted; live DISABLED; no edge or real-adapter claim; migrations unchanged                                 |

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

## R004 single-owner PAPER crash/restart safety

| Field      | Value                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch     | `claude/r004-paper-recovery` from accepted F003 docs head `aa75c01e421007ba1e2a1291a4c73bb2b3cf67c6` (code `2e75b104`); F003/M001/default untouched     |
| Tested SHA | code `842ed66686ac9da26225cd2bcc63f2a4d239993a` (clean committed tree); later commits on the branch are documentation only                              |
| Local run  | PostgreSQL 16.14, `TEST_DATABASE_URL` set; exits: frozen install 0, format 0, lint 0, typecheck 0 (also run before the first publish), tests 0, build 0 |
| Tests      | 95 files, 874 passed, 0 failed, 0 skipped (F003 baseline 92 files / 857)                                                                                |
| CI         | Triggered by the branch push; result not claimed here                                                                                                   |
| Migrations | 0015 added (`paper_owner`, `paper_broker_state.revision/session_id`); 0010–0014 unchanged byte-for-byte (empty diff)                                    |
| Software   | IN_PROGRESS — local PASS only, pending independent CEO review. Stage 1 NOT accepted; live DISABLED; no readiness, edge or real-broker claim             |

Old-base repro (isolated temporary git worktree at `aa75c01e`, no change to the implementation
tree): `apps/api/test/paper-recovery-seam.test.ts`, written only against pre-R004 APIs, fails 2/2
there — `flush()` resolves although the snapshot save failed (absorbed), and a restarted runtime
after a crash reports the account reconciled with no quarantine — and passes 2/2 on the candidate.

Candidate coverage (real PostgreSQL, composed runtime, deterministic fault injection; the crash seam
terminates the owner's lock backend and never calls `stop()`): DIRTY write failure and lost DIRTY
ACK before any interaction; owner A vs competitor B; ownership loss halting admission/paper actions,
and during the final ledger wait; terminal-ended dirty restart with no kill switch blocking the
gateway AND direct DB `reserveAndConsume`/`markDispatching`; quote-driven fill before a failed
snapshot save then crash; all evidence/UNKNOWN/kill-switch writes failing then crash (older
reservation preserved, no resend); ended order unknown to the restored broker recorded as lost
evidence; failed flush propagating and never CLEAN; lost-ACK CLEAN commit verified at the next
start; idempotent replay of committed evidence; positive clean stop → ACKed checkpoint → restart
admits. Plus a gateway test that `unknown()` reports the real persistence outcome.

Remaining risks: any unclean paper session blocks its accounts until an audited clearing path exists
(none built); recovery does not re-apply lost mutations; PAPER only (no real broker, no distributed
takeover); ownership is verified by the caller just before — not inside — the DB reserve/dispatch
SQL; the keepalive interval bounds detection of a silent lock loss between boundary checks;
legacy sessions from before 0015 cannot be proven clean; S002 queued cancel / protective-close
permissions unchanged.

## R004 corrections (review rounds 2–3)

| Field      | Value                                                                                                                                                                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch     | `claude/r004-paper-recovery` (base F003 docs head `aa75c01e`; F003/M001/default untouched)                                                                                                                                                                            |
| Rejected   | `484c9a5c` — CI run 37232550276 / job 111525132255 PASS (CEO-located; install/format/lint/typecheck/test/build, 95 files, 874 tests) but the safety review rejected it. `230478e8` — local 97 files / 894 tests / 0 skips; review rejected (see below); no CI located |
| Tested SHA | code `8c57e6be5b7f9757bb381be26985a405804ab2c5` (clean committed tree); later commits on the branch are documentation only                                                                                                                                            |
| Local run  | PostgreSQL 16.14, `TEST_DATABASE_URL` set; exits: frozen install 0, format 0, lint 0, typecheck 0 (also before each push), tests 0, build 0                                                                                                                           |
| Tests      | 97 files, 897 passed, 0 failed, 0 skipped (self-reported until independent CI)                                                                                                                                                                                        |
| CI         | Triggered by the branch push; result not claimed here                                                                                                                                                                                                                 |
| Migrations | 0015 only; 0010–0014 unchanged                                                                                                                                                                                                                                        |
| Software   | IN_PROGRESS — local PASS only; fresh exact-head CI and independent review required. Stage 1 NOT accepted; live DISABLED; no readiness, edge or real-broker claim                                                                                                      |

Fixed (reproduced first in isolated temporary worktrees; the implementation tree was never
replaced): lock identity pinned and permanently latched (no idle/lifetime recycling, original
backend pid + granted advisory lock proved on every verify, close observed at once); legacy paper
evidence without an owner record is UNCLEAN while an empty install is NONE; CLEAN requires exact
checkpoint/snapshot account sets (deleted/extra/changed rows quarantine, `markClean` refuses);
durable owner-session fence in `reserveAndConsume`/`markDispatching` (owner row FOR SHARE first,
consistent lock order with acquire/markClean/save; PAPER-fenced production repository fails closed
without an owner row; non-paper adapters and unit fixtures unaffected); snapshot saves in one
transaction under the owner lock (held save vs owner change, stale-owner retry refused, same
revision with different content never ACKed); recovery pages through every ended order (1,100
tested; the old 1,000 cap skipped 100); drain: all paper work is an admitted activity, new top-level
work and top-level broker calls are refused before they run once closing, admitted work (including
work admitted after the first in-flight snapshot, a held safety cycle, a held entry, startup)
finishes before the broker is sealed and the checkpoint/CLEAN transition.

Old-base repro: on `484c9a5c` 16 of the 20 then-new tests failed (12/16 `paper-owner`, 4/4
`paper-drain`; the 4 that passed there were the empty-install, exact-positive, extra-row and
competitor-BUSY cases); on `230478e8` the 3 tests added for the last review (missing owner row
direct repository, composed deleted-row, broker call during held drain) failed.

Remaining risks: every unclean paper session still blocks its accounts (no clearing path); recovery
does not re-apply lost mutations; removing a paper account from config makes the next start
unclean (strict exact-set rule); PAPER only, no real broker or distributed takeover; a hung
in-flight operation leaves the session DIRTY after the drain timeout (never CLEAN); S002 queued
cancel / protective-close permissions unchanged (a protective close arriving while closing is
refused).

## R004 acceptance (CEO) and S002 queued safety actions

R004 PASS (PAPER crash/restart scope only): code `8c57e6be5b7f9757bb381be26985a405804ab2c5`, docs
head `05fc2ef0589b4fa81c784818921de41e02910d88`; CI 37236216419 / job 111535726577 SUCCESS, 97
files, 897 tests, 0 skips (independently verified). The earlier "remaining risks" paragraphs of the
R004 sections above are historical; the standing limitations are listed in `CEO_STATE.md`.

| Field      | Value                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch     | `claude/s002-queued-safety-actions` from accepted R004 docs head `05fc2ef0` (R004/F003/M001/default untouched)                                 |
| Tested SHA | code `0dd69ca216837232a4ca271940d24ad31efbd383` (clean committed tree); later commits on the branch are documentation only                     |
| Local run  | PostgreSQL 16.14, `TEST_DATABASE_URL` set; exits: frozen install 0, format 0, lint 0, typecheck 0 (also before the push), tests 0, build 0     |
| Tests      | 99 files, 931 passed, 0 failed, 0 skipped (R004 accepted baseline 97 / 897; self-reported until independent CI)                                |
| CI         | Triggered by the branch push; result not claimed here                                                                                          |
| Migrations | none added; 0010–0015 unchanged                                                                                                                |
| Software   | IN_PROGRESS — local PASS only, pending independent review and CI. Stage 1 NOT accepted; live DISABLED; no readiness, edge or real-broker claim |

Old-base repro (isolated temporary worktree at `05fc2ef0`, implementation tree never replaced):
the new tests fail 27 of 34 there (23/29 in-memory, 4/5 composed PostgreSQL) — the queued action
used the permission captured before the lock for SHADOW/BACKTEST, EXECUTION kill switch, unloaded
controls, a changed adapter or broker account binding, LIVE authorization and adapter kind. (A few of
those failures on base are the new store method rather than behaviour.)

Coverage: protective close AND cancel re-read inside the lock for mode SHADOW/BACKTEST, EXECUTION
switch, unloaded controls, adapter and account binding change, LIVE account and environment
revocation, adapter kind vs mode; a change during the final asynchronous read (target lookup) still
prevents the call; entry-only GLOBAL/ACCOUNT/INSTRUMENT switches and HALTED never block the
permitted reduction; orders of another account or placed through another adapter are never
cancelled; queued duplicates are idempotent; unknown broker outcome, failed evidence writes and
failed (or memory-only) halt writes are reported exactly with the reservation kept; composed
runtime on real PostgreSQL for SHADOW, EXECUTION switch, binding change, entry-only switch and a
failed kill-switch persistence. Fake adapters only; no LIVE.

Remaining risks: a protective close still takes the account lock (it waits behind a long entry
validation); a close whose broker position id exists on the NEW binding is refused by the
binding check rather than reconciled; the first early refusal can pre-empt a reduction that would
have become permitted a moment later (conservative); integrated cleanup and fresh combined
evidence remain.

## S002 review corrections

| Field      | Value                                                                                                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rejected   | `0dd69ca2` (code) / `11ffee72` (docs): safety review rejected — cancel persistence text overclaimed, queued binding did not pin the adapter instance/kind. Its local run: 99 files / 931 tests / 0 skips; no CI located |
| Tested SHA | code `cee9b7a13f23ce374c189067953468a5fed45e76` (clean committed tree); later commits on the branch are documentation only                                                                                              |
| Local run  | PostgreSQL 16.14; exits: frozen install 0, format 0, lint 0, typecheck 0 (also before the push), tests 0, build 0                                                                                                       |
| Tests      | 99 files, 938 passed, 0 failed, 0 skipped (self-reported until independent CI)                                                                                                                                          |
| CI         | Triggered by the branch push; result not claimed here                                                                                                                                                                   |
| Migrations | none added; 0010–0015 unchanged                                                                                                                                                                                         |
| Software   | IN_PROGRESS — local PASS only. Stage 1 NOT accepted; live DISABLED; no readiness claim                                                                                                                                  |

Corrected: the queued binding pins adapter instance + kind (same-id replacement refused before any
call, for cancel, close and during the final asynchronous read); cancel reports the broker answer,
order-state evidence, audit event and halt persistence separately and no longer asserts the
reservation is kept (the composed PostgreSQL test shows the terminal update released it); an
in-memory-only EXECUTION halt blocks local paper admission, refuses a clean stop and leaves the
session DIRTY so a restart quarantines (composed test: audit append and halt persistence fail, then
stop is refused and the restarted runtime is UNCLEAN with a quarantine). The entry-flow `unknown()`
text no longer asserts retention either. Old-code repro (isolated worktree at `0dd69ca2`): 9 of 41
new/updated tests fail there.

Remaining risks: as in the S002 section above; additionally an unpersisted halt blocks ALL paper
admission for the session (conservative) until restart/recovery.

## Stage 1 integrated release candidate

| Field      | Value                                                                                                                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch     | `claude/stage1-integrated-release` from accepted S002 docs head `728ac6d796d3de83f4312e8aef86e51d79a233e1`; default branch not touched                                                                          |
| Ancestry   | Verified in this branch: I001 pieces (`babf911`, `0c0aff9`, `d39129a`), `ba8c487`, S001-R3 `c1ba531`, M001 `3cd84145`, F003 `2e75b104` / `aa75c01e`, R004 `8c57e6be` / `05fc2ef0`, S002 `cee9b7a1` / `728ac6d7` |
| Tested SHA | code `dcb4f692882137d4b8081c45b393cfe24952b223` (clean committed tree); later commits on the branch are documentation only                                                                                      |
| Local run  | PostgreSQL 16.14, `TEST_DATABASE_URL` set; exits: frozen install 0, format 0, lint 0, typecheck 0 (also before the push), tests 0, build 0                                                                      |
| Tests      | 100 files, 945 passed, 0 failed, 0 skipped (S002 accepted baseline 99 / 938; +7 integration tests); self-reported until independent CI                                                                          |
| CI         | Triggered by the branch push; result not claimed here                                                                                                                                                           |
| Migrations | 0010–0015 unchanged (empty diff vs M001 `3cd84145` and R004 `8c57e6be`; content hashes now pinned by a test)                                                                                                    |
| Software   | IN_PROGRESS — integrated candidate for CEO exact-head review. Stage 1 NOT complete; live DISABLED; no readiness, edge or real-broker claim; Stage 2 not started                                                 |

Changes (cleanup and integration blockers only; no behavior change to accepted code):

- Status documents made consistent: `CEO_STATE.md` (one accepted-chain table, rejected history,
  next step), `docs/PROJECT_STATE.md` (the three "review pending" S001/R3/F003 sections replaced by
  one Stage 1 section), `docs/WORK_LEDGER.md` (M001, F003, R004, S002, integrated rows; S001/R3 rows
  marked superseded; lessons 8–10), the stale header of this file replaced by the evidence index above,
  `CLAUDE.md` (two lessons), `DECISIONS.md`.
- ADR-0027 "what is and is not safe": the obsolete "run ONE execution process per paper account" and
  "contradictory-evidence write fails" residuals now point at §9/§10 (R004/S002).
- New `packages/db/test/upgrade-0015.test.ts` (7 tests): SHA-256 pins of migrations 0010–0015
  (immutability) and a real-PostgreSQL 0014→0015 upgrade over pre-R004 paper state (legacy snapshot
  kept with revision 0, empty owner table, first owner start UNCLEAN + quarantine, idempotent re-run).
- Retained deliberately: `.github/workflows/ci.yml` (required gate), and the two Claude workflows
  (`claude.yml` routine bridge, `claude-direct-connection-test.yml` diagnostic) — operator tooling
  that does not affect the product gate; their removal is an owner decision, not a cleanup guess.

Migration evidence in the suite: fresh install (every PostgreSQL suite migrates a new schema),
idempotence and modified-applied-migration refusal (`migrate-audit`), upgrades from 0010/0011/0012/
0013 databases (`tombstone-upgrade`), and the 0014→0015 upgrade (`upgrade-0015`).

Cross-component regressions still green in the full run: F003 final guard (decision, gateway, composed
API with held final ledger wait), R004 (`paper-owner`, `paper-recovery`, `paper-recovery-seam`,
`paper-drain`), S002 (`queued-actions`, in-memory and composed), S001 pre-submit/late-evidence/
reservation suites, plus the entire pre-existing suite.

Documentation-only corrections after review (tested code unchanged, no test rerun): PROJECT_STATE
and WORK_LEDGER now say S001/S001-R3 failed review and were repaired by the accepted M001/F003/R004/
S002 chain, and I001 is marked historical-local / accepted software-only (no CI run recorded for
I001); ADR-0027 states the DIRTY latch precisely (only a FAILED EXECUTION-halt persistence latches;
a persisted halt is durable; restored ended-order evidence is a consistency check, not
reconstruction of lost mutations).

Unresolved (not weakened): no audited quarantine clearing path; unclean paper session blocks its
accounts; recovery does not re-apply lost mutations; PAPER only (real-broker linkage blocks LIVE);
no distributed takeover; an unpersisted halt blocks all paper admission until restart; a protective
close waits behind a long entry validation. LIVE needs the owner (ADR-0008).

## Stage 1 integrated gate — CEO acceptance (current status)

The "IN_PROGRESS" wording in the section above is historical. The CEO accepted the Stage 1
integrated software gate (PAPER execution-safety scope only) at review/CI head
`b9c3b890f35c4e0529502d76a032dad6a7b67ec6`, tested code `dcb4f692882137d4b8081c45b393cfe24952b223`:
exact-head CI run 37240369181 / job 111547727471 SUCCESS (frozen install, format, lint, typecheck,
full tests, build; PostgreSQL 16.15; 100 files / 945 tests; 0 skips; independently decoded logs).
No application behavior changed after the tested code. Standing limitations are unchanged (see
`CEO_STATE.md`); this is not live readiness, deployment or profitability.

## P001 Stage 2 platform-readiness audit (documentation only)

Branch `claude/p001-platform-readiness` from `b9c3b890`; deliverable `docs/ledger/P001_PLATFORM_AUDIT.md`
(first published `206c9461`, corrected after CEO review; the final head is named in the hand-off).
Markdown-only validation: `prettier --check` and a source/consistency review; no code or tests changed,
so the full suite was not rerun. Source tiers: CEO primary reads (2026-10-04 UTC / 2026-10-05 IST),
Claude leads (unverified) and third-party pages (never facts). My direct fetches of the official
domains were blocked by this environment's egress proxy; I did not fetch the pages the CEO read. No
profile is VERIFIED and no spend, account, route or contract is selected.

## D001 strict research import calendar timestamps (ACCEPTED, timestamp-import scope)

| Field      | Value                                                                                                                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch     | `claude/d001-import-timestamps` from `aac79c0eb0b0ef5f10a5d93b625b110392b9b630` (P001 docs head; Stage 1 PASS evidence unchanged)                                                                                                      |
| Tested SHA | accepted code `a432fe860a9cdc9f0d6ebaa04127213c4108993a`; docs head `994c09b2b1c289963b6da8c4905ebde1108af983` changed only 3 Markdown files after the tested code; `a2ca62f2` superseded, not accepted (ISO 24:00 treated as invalid) |
| CI         | independent exact-code run 37243166602 / job 111555751622 SUCCESS: frozen install, format, lint, typecheck, full tests, build; PostgreSQL 16.15, 101 files / 1026 tests / 0 skips                                                      |
| Local run  | PostgreSQL 16.14, `TEST_DATABASE_URL`; exits: frozen install 0, format 0, lint 0, typecheck 0 (also before each push), tests 0, build 0                                                                                                |
| Tests      | 101 files, 1026 passed, 0 failed, 0 skipped (Stage 1 baseline 100 / 945; +81 tests in `packages/research/test/import-timestamps.test.ts`); local run, independently confirmed by CI above                                              |
| Scope      | `packages/research/src/data.ts`, `packages/research/kit/lsfvg_kit.py`, one new test file; no application code, migrations, `docs/research` archives, engine, strategy, sizing or costs changed                                         |

**Observed defect (reproduced on `aac79c0e` in an isolated worktree with synthetic fixtures).**
`parseBars` used `Date.UTC` for HistData and fixed-offset MT5 and `Date.parse` for generic times, so
impossible components were normalised into a DIFFERENT valid instant and passed the finite-time and
OHLC checks. HistData `20240230 120000` → 2024-03-01T17:00Z; `20230229` → 1 March; month 13 →
2025-01-01; day 0 → 31 Dec; hour 25, minute 60 and second 60 all rolled forward (invalid 0 in each
case). MT5 with a fixed offset behaved the same (`NY+7`, via Luxon, already rejected impossible dates);
a two-digit year (`24.01.02`) became 1924 (fixed) or 0024 (`NY+7`). Generic `Date.parse` (V8)
accepted `2024-02-30` (date-only, `T`, space) as 1 March. The Python kit never shifted (it raised
`ValueError`) but **aborted the whole file** instead of counting the row invalid — a mismatch with the
`ParseReport` contract; it also accepted a two-digit MT5 year in fixed-offset mode.

**Correction (parsing boundary only).** New exported `utcMs` validates month 1–12, day against the
month and the leap rule (incl. century rules), hour 0–23, minute/second 0–59, ms 0–999, year 1–9999
and builds the instant without `Date.UTC`'s two-digit-year mapping; an impossible value is NaN →
counted `invalid` ("unreadable time"), dropped, never repaired. HistData, MT5 (fixed offset and
`NY+7`; 4-digit year, `H[H]:MM[:SS]`) and generic ISO (extended `YYYY-MM-DD`, optional `T`/space time,
seconds, fraction, `Z`/±hh[:]mm, date-only = UTC midnight) use it. **ISO-8601 end-of-day `24:00`,
`24:00:00` and `24:00:00.000` is a valid convention and is preserved** as the next midnight of the
already-validated date (also with a zone; Dec 31 and Feb 29 roll correctly); `24:01`, `24:00:01`,
`24:00:00.5`, hour 25, `Feb 30 T24:00` and a non-leap `Feb 29 T24:00` are invalid. HistData and MT5
clocks keep hour 24 invalid (not part of those formats). Epoch seconds/ms are unchanged. The Python
kit now counts impossible HistData/MT5 fields invalid (no abort), uses the same strict MT5 shapes
(`re.ASCII`) and implements the same narrow ISO `24:00` rule; `KIT_VERSION` stays `1.0.0`, but it **no longer uniquely
identifies parser bytes** (the kit's parsing changed without a version bump). Future research provenance must
record the exact code SHA or kit file hash, not `KIT_VERSION` alone. Archived historical provenance is preserved
as written; no version or code change is made in this docs-only handoff.

**Valid-input compatibility.** HistData fixed UTC−5, MT5 explicit fixed offset and `NY+7` (winter and
summer), spread values, ordering, de-duplication and the absent-server-offset behaviour are covered by
positive cases and are asserted unchanged **for those documented formats and tests only**; this is not a claim of
global TypeScript/Python equivalence or parity for all inputs. Verified totals: new file 81 tests; full suite
101 files / 1026 tests (Stage 1 baseline 100 / 945). `docs/research` archives are untouched and no engine code
changed.

**Tests.** 81 tests in the new file: 77 table cases run through the production `parseBars` (impossible vs valid leap /
month-end / century boundaries per format, ISO 24:00 positive and negative), a mixed-file ordering/
duplicate test, `utcMs` boundaries, and a TypeScript-vs-Python-kit parity test over every case (same
parsed/invalid counts and the same UTC instant). On the base (`aac79c0e`) the first 66-test version of the file failed
31 tests (the failing impossible-date cases plus the Python abort; `NY+7` already rejected impossible dates);
the valid-input cases passed.

**Out-of-scope concerns recorded, not fixed:** (1) `NY+7` uses Luxon in TypeScript but the kit's built-in
New York rules start in 2007 — pre-2007 `NY+7` rows are now counted invalid in the kit while TypeScript
converts them; nonexistent local times in a DST gap are shifted by Luxon (data-quality/DST policy);
(2) generic ISO basic format (`20240102T120000Z`) is accepted by the Python kit but not by TypeScript;
(3) non-ISO generic shapes (e.g. `2024/02/05 12:00`) are now unreadable in TypeScript (previously a
V8 fallback), matching the documented "ISO-8601 or epoch" and the kit; (4) no spread/overlap/resampling
or data-quality change. No real data was downloaded; no strategy run; no untouched-data or edge claim.

**CEO acceptance (D001, timestamp-import scope only).** Accepted on code `a432fe86` with CI 37243166602 / job 111555751622. This is NOT global TypeScript/Python equivalence, verified data, an edge, or Stage 2 completion.
Stage 1 PASS (PAPER execution-safety scope; accepted `b9c3b890`, tested code `dcb4f692`, CI 37240369181 / job
111547727471, 100 / 945, 0 skips) is intact: P001 changed documentation only; D001 changed only the research
loader and kit, and the Stage 1 application is unchanged. Stage 2 remains IN_PROGRESS; P001 PASS; P002
route-specific work stays BLOCKED on the founder's exact first account-or-none, platform and phase/options.
