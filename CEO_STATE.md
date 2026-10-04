# CEO_STATE

Status vocabulary: NOT_STARTED / IN_PROGRESS / BLOCKED / PASS / FAIL. Updated 4 October 2026.

| Item             | Value                                                                                                                                                                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stage            | Stage 1 (execution safety): IN_PROGRESS — integrated candidate published for CEO exact-head review; NOT accepted. Live trading DISABLED; no verified edge; no real broker adapter                                                                                                                               |
| Accepted chain   | M001 PASS `3cd84145` (CI 37194795717, 820 tests) → F003 PASS code `2e75b104` (CI 37230464693, 857) → R004 PASS code `8c57e6be` (CI 37236216419, 897; PAPER scope) → S002 PASS code `cee9b7a1`, docs `728ac6d7` (CI 37239168847 / job 111544207158, 99 files / 938 tests, 0 skips). All PostgreSQL 16.x, 0 skips |
| Active task      | Stage 1 integrated cleanup and fresh combined release evidence, branch `claude/stage1-integrated-release` from `728ac6d7`; tested code `dcb4f692882137d4b8081c45b393cfe24952b223` (local: 100 files / 945 tests / 0 skips); later commits documentation only; CI pending (`RELEASE_EVIDENCE.md`)                |
| Rejected history | S001 `c765554`/`6caeb71`, round 2 `ba8c487`, S001-R3 `c1ba5318` (CI 813 PASS, safety FAIL); F003 `f0b2c283`, `9fc9b048`; R004 `484c9a5c` (CI PASS, safety FAIL), `230478e8`; S002 `0dd69ca2`/`11ffee72`                                                                                                         |
| Next             | After CEO review of the integrated candidate: Stage 2 (firm/platform selection → verifiable data → registered research). Not started                                                                                                                                                                            |

Session: one active writer in https://claude.ai/code/session_01JscBgwrjg845F2kNfVWFYZ; old chats are historical.

Technical decisions (architecture, safety design, tests, migrations) are made by engineering and
recorded in ADRs; they are not owner-managed.

## Blockers

- BLOCKED for LIVE: real-broker adapter must supply position ↔ order linkage / closed trades keyed by `clientOrderId` (ADR-0027). Paper only today. Live trading is DISABLED.
- BLOCKED: no strategy has a verified edge (see `RESEARCH_REGISTRY.md`); nothing is approved for trading.
- An account quarantine (ADR-0027 §8) or an unresolved completed-day history conflict has NO clearing path yet: it blocks the account until an audited reconciliation is built.

## Accepted safety rules

Default NO TRADE; any non-OK input rejects; no fabricated data/rules; AI context only (veto, never
approve); risk, sizing, rules, kill switches and execution permission are deterministic code;
secrets only via env; live trading never enabled without ADR-0008's six factors; a missing
revalidation/reservation input blocks transmission; reservations release only on authoritative
evidence; evidence contradicting a released reservation quarantines the account durably (never a
silent re-open or a time-based expiry); conservative refusal over invented headroom.

## Next priorities (in order)

1. CEO exact-head review of the Stage 1 integrated candidate (one candidate, one CI run, one evidence record).
2. Then the roadmap: Stage 2 — firm/platform selection followed by verifiable data, then registered research (`RESEARCH_REGISTRY.md`).

## Founder-only decisions

Money (budgets, paid services), legal matters, credentials, and financial authorization —
including the six live-trading factors (ADR-0008), platform/broker accounts and verification of
the firm's rules.

## Process lesson (S001-R3)

A previous text replacement silently missed `freshTracking` after formatting changed the code it
was meant to match. Every scripted edit must assert its expected match count, the diff must be
read, and the regression must exercise the exact production path (here `AccountService.tracking()`
and `freshTracking()` are both tested through the composed runtime).

## Process lesson (F003)

Reproduce old-base bugs in an isolated worktree or temp checkout, never by replacing source in a
dirty implementation tree: a `git checkout HEAD -- <src>` restore discarded a pending guard fix.
Scripted restorations must verify the resulting diff.

## Historical reviews (provenance only, not current work)

I001 integration PASS (software-only). S001 `c765554`/`6caeb71` and round 2 `ce12040`/`ba8c487`:
FAIL. S001-R3 `c1ba5318`: CI PASS (813 tests) but safety FAIL (`docs/ledger/S001_R3_CEO_REVIEW.md`);
its findings were resolved by M001 (tombstone upgrade), F003 (final freshness), R004 (PAPER
crash/restart ownership) and S002 (queued risk-reduction permissions), each accepted separately.
Standing limitations of the accepted chain are listed in `docs/PROJECT_STATE.md` (Stage 1).
