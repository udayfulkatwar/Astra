# CEO_STATE

Status vocabulary: NOT_STARTED / IN_PROGRESS / BLOCKED / PASS / FAIL. Updated 4 October 2026.

| Item           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stage 1        | **PASS (integrated software gate, PAPER execution-safety scope)** — accepted review/CI head `b9c3b890f35c4e0529502d76a032dad6a7b67ec6`, tested code `dcb4f692882137d4b8081c45b393cfe24952b223`; exact-head CI run 37240369181 / job 111547727471 SUCCESS (frozen install, format, lint, typecheck, full tests, build; PostgreSQL 16.15, 100 files / 945 tests, 0 skips). Later work did not change the Stage 1 application: P001 was documentation only; D001 changed only the research loader and kit. NOT live readiness, deployment or profitability. Standing limitations: PAPER only; unclean paper sessions quarantine their accounts; no audited clearing path and no reconstruction of lost mutations; a protective close can wait behind a long entry validation; no verified edge; no real broker adapter. Live trading DISABLED                                           |
| Accepted chain | M001 `3cd84145` (CI 37194795717, 820 tests) → F003 code `2e75b104` (CI 37230464693, 857) → R004 code `8c57e6be` (CI 37236216419, 897) → S002 code `cee9b7a1` (CI 37239168847, 938) → Stage 1 integrated `dcb4f692` / `b9c3b890` (CI 37240369181, 945)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Stage 2        | **IN_PROGRESS** — firm/platform selection → verifiable data → registered research. No strategy promoted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Active task    | **D001 PASS (timestamp-import scope only)**, branch `claude/d001-import-timestamps`: accepted code `a432fe860a9cdc9f0d6ebaa04127213c4108993a`, independent exact-code CI 37243166602 / job 111555751622 SUCCESS (PostgreSQL 16.15, 101 files / 1026 tests, 0 skips); docs `994c09b2` changed only 3 Markdown files after tested code; `a2ca62f2` superseded, not accepted. NOT global TS/Python equivalence, verified data/edge or Stage 2 completion; `KIT_VERSION` 1.0.0 no longer identifies parser bytes (record code SHA/file hash). Stage 2 IN_PROGRESS. P001 remains PASS (audit scope only; accepted `04091354`). Stage 1 PASS evidence above is intact. **P002 route-specific implementation stays BLOCKED on the founder's exact first account-or-none / platform / phase and options** (no account/route inferred; no credentials, purchase or support contact requested) |
| P001 finding   | Corrected after CEO review. Evidence tiers: CEO primary read (P, 2026-10-04 UTC / 2026-10-05 IST) vs Claude leads (L, unverified) vs third-party (never facts). Current P facts: FundingPips 2 Step Flex 10%/8% targets, 4% daily (higher of opening balance/equity, reset 00:00 UTC+3), static 12% max loss; evaluation permits overnight/weekend, Master auto-closes unless Swing; VPN/VPS forbidden; own-EA automation needs firm-assessed proof; external own-software/API acceptance unresolved. Lucid LucidFlex 25K: end-of-day trailing, MLL $1,000, floor $25,100, optional DLL, automation permitted; API/cloud route unresolved; CME MYM/MNQ point values read. Profile-schema mapping is a GAP needing proof; R004 fences are PAPER-only. No account/route/fee/profile selected or VERIFIED                                                                               |
| P002 prep      | **IN_PROGRESS → candidate review (Markdown only).** Founder confirmed 2026-10-05: first account firm **FundingPips**, phase **EVALUATION**. Platform NOT specified and not assumed; program/size/step/feed/options unconfirmed (10K 2-Step Flex is historical intention only). Platform-independent requirements/acceptance matrix: `docs/ledger/P002_REQUIREMENTS.md`. **Route implementation BLOCKED** (needs platform for protocol/auth/accountRef/order/fill/reconnect semantics; exact program/step/terms for phase rules). No completion claim; no code, connection, credentials, purchase or profile verification. D001 PASS (`a432fe86`, CI 37243166602, 101/1026/0 skips), Stage 1 PASS and Stage 2 IN_PROGRESS intact                                                                                                                                                      |
| Next           | CEO review of the P002 preparation candidate. Still needed from the founder: the platform and the exact program/size/step (+ reward/DLL/add-ons, feed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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

1. Founder: the platform and the exact program/size/evaluation step (firm FundingPips and phase EVALUATION are confirmed; reward option, optional DLL, add-ons, feed unconfirmed). Then platform-specific P002.
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
