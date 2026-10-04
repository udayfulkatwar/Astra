# CEO_STATE

Status vocabulary: NOT_STARTED / IN_PROGRESS / BLOCKED / PASS / FAIL. Updated 4 October 2026.

| Item              | Value                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stage             | Stage 1 (execution safety): IN_PROGRESS — NOT accepted. Live trading DISABLED; no verified edge; no real broker adapter                                                                                                                                                                                                                                                        |
| Accepted baseline | R004 PASS (PAPER crash/restart scope only): code `8c57e6be5b7f9757bb381be26985a405804ab2c5`, docs head `05fc2ef0589b4fa81c784818921de41e02910d88` (Markdown-only after code), independent review PASS, CI 37236216419 / job 111535726577 SUCCESS (97 files, 897 tests, 0 skips; install/format/lint/typecheck/test/build). Under it F003 PASS `2e75b104`, M001 PASS `3cd84145` |
| Active task       | S002 — queued risk-reduction permissions, branch `claude/s002-queued-safety-actions` from `05fc2ef0…`; IN_PROGRESS; `0dd69ca2`/`11ffee72` rejected by review (cancel persistence overclaim, adapter instance not pinned); corrected candidate published for review (evidence in `RELEASE_EVIDENCE.md`)                                                                         |
| R004 history      | `484c9a5c` (CI 37232550276 / job 111525132255 PASS, 95 files / 874 tests) and `230478e8` (local 97 / 894) were rejected by safety review before acceptance. R004 limitations stand: unclean paper sessions block accounts with no clearing path, recovery does not re-apply lost mutations, PAPER only, no real broker or distributed takeover                                 |
| Next              | After S002 acceptance: integrated cleanup + fresh combined evidence (NOT_STARTED)                                                                                                                                                                                                                                                                                              |

Session: one active writer in https://claude.ai/code/session_01JscBgwrjg845F2kNfVWFYZ, reused for S002;
integrated cleanup follows only after S002 acceptance; old chats are historical.

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

1. S002 acceptance (independent review + CI on the exact final head).
2. Integrated release cleanup and combined evidence (one candidate, one CI run, one evidence record).
3. Then the roadmap: Stage 2 — firm/platform selection followed by verifiable data, then registered research (`RESEARCH_REGISTRY.md`).

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

I001 integration PASS (software-only). S001 candidate `c765554`/`6caeb71`: FAIL. S001 round 2
`ce12040`/`ba8c487`: FAIL. S001-R3 `c1ba5318`: FAIL despite 813-test CI PASS
(`docs/ledger/S001_R3_CEO_REVIEW.md`). M001 repaired only its tombstone-upgrade findings and F003
only the final entry-freshness finding; crash/restart ownership (R004) and queued safety actions
(S002) remain open, so S001-R3 and Stage 1 are NOT accepted.
