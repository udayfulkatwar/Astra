# CEO_STATE

Status vocabulary: NOT_STARTED / IN_PROGRESS / BLOCKED / PASS / FAIL. Updated 4 October 2026.

| Item              | Value                                                                                                                                                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stage             | Stage 1 (execution safety): IN_PROGRESS — NOT accepted. Live trading DISABLED; no verified edge; no real broker adapter                                                                                                                                   |
| Accepted baseline | F003 PASS: code `2e75b104d57b3ac7adfcac9d7c1053f506502534` (CI 37230464693 / job 111518851649, PostgreSQL 16.15, 92 files, 857 tests, 0 skips); docs-only `aa75c01e421007ba1e2a1291a4c73bb2b3cf67c6` (CEO exact-diff PASS). Under it M001 PASS `3cd84145` |
| Active task       | R004 — single-owner PAPER crash/restart safety, branch `claude/r004-paper-recovery` from `aa75c01e…`; IN_PROGRESS, candidate published for read-only CEO review (evidence in `RELEASE_EVIDENCE.md`)                                                       |
| Next              | After R004 acceptance: S002 queued risk-reduction permissions (NOT_STARTED) → integrated cleanup + fresh combined evidence                                                                                                                                |

Session: one active writer in https://claude.ai/code/session_01JscBgwrjg845F2kNfVWFYZ, reused for R004;
S002 follows only after R004 acceptance; old chats are historical.

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

1. R004 acceptance (independent review + CI on the exact final head).
2. S002 — queued cancel / protective-close permission re-checks.
3. Integrated release cleanup and combined evidence (one candidate, one CI run, one evidence record).
4. Then the roadmap: Stage 2 — firm/platform selection followed by verifiable data, then registered research (`RESEARCH_REGISTRY.md`).

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
