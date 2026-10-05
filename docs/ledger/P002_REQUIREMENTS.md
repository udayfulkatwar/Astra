# P002 — FundingPips EVALUATION: platform-independent requirements and acceptance matrix

Status: **preparation, Markdown only, candidate for CEO review (2026-10-05 UTC).** This is a design
requirements document, not implemented proof. No code, protocol, connection, credential, purchase or
support contact is part of it. Source research and tests are not repeated: it uses the accepted P001
audit (`docs/ledger/P001_PLATFORM_AUDIT.md`, evidence tiers P/L/T unchanged) and the existing
`BrokerAdapter` port (`packages/execution/src/types.ts`).

## 1. Founder decision (2026-10-05) and what remains unknown

| Item                                                 | State                                                                                         |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Firm                                                 | **FundingPips — confirmed by the founder**                                                    |
| Phase                                                | **EVALUATION — confirmed by the founder**                                                     |
| Trading platform                                     | **UNKNOWN. Must not be assumed** (no MT5, cTrader, Match-Trader or other protocol is implied) |
| Program, account size, evaluation step, reward/DLL   | UNCONFIRMED. The earlier "10K 2-Step Flex" in P001 is a historical intention, not an account  |
| Market-data feed, account purchase date, add-ons     | UNCONFIRMED                                                                                   |
| Written firm confirmation that the route is accepted | NOT OBTAINED (P001: external own-software/API acceptance unresolved)                          |

"FundingPips + evaluation" does **not** specify a verified rule profile: targets, loss limits, news,
holding and automation rules differ per program/step/terms. No `PropFirmRuleProfile` becomes VERIFIED
from this decision; templates stay `UNVERIFIED`/`TEMPLATE` and LIVE refuses them.

## 2. Precise dependencies

1. **Platform** is required to select: API protocol and auth model, the `accountRef` format, the
   order/fill/position model (netting vs hedging, partial fills, protective-order attachment),
   reconnect and session semantics, server-time and quote sources, and whether `clientOrderId` is
   returned on orders, fills and closes.
2. **Exact program, step and terms** are required to apply phase rules (targets, daily/overall loss
   mode and basis, holding/news restrictions, automation/VPS/VPN permission, add-ons) to a profile.
3. **Written firm/API permission** for the selected route (a later gate, per P001 §9).

Until (1) and (2) are supplied, platform-specific API contract, adapter and fake-server conformance
work stays **BLOCKED**, and so does profile verification.

## 3. What can proceed now (platform-independent)

Only this requirements/acceptance matrix and founder intake. Nothing here is a generic adapter
scaffold; protocol code starts only after the platform is known.

## 4. Requirements → evidence matrix

"Existing" = what the repository already proves, from the Stage 1 PASS evidence (PAPER scope, CI
37240369181). "Required proof after platform supplied" is a design requirement and is **not**
implemented or tested for any real route today.

| #   | Requirement for any real `BrokerAdapter` (`kind: 'LIVE'`)                                                                                                                                                    | Existing (PAPER only)                                            | Required proof after platform supplied                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Read-only state and reconciliation: `getAccountSnapshot`, `listOpenOrders`, `getOrder` read balance, equity, positions and orders without any write; a mismatch with ASTRA's records blocks entries          | PAPER adapter and generic reconciliation tests                   | Fake-server conformance for the chosen protocol, including unknown/partial/stale responses mapped to non-OK (never defaulted to flat/healthy)                   |
| 2   | Idempotency: `submitOrder` idempotent on `clientOrderId`, `closePosition` on `clientCloseId`; transport error means outcome unknown and is resolved by reading broker state, never by blind retry            | PAPER semantics; S001 reservations                               | Replay/timeout/duplicate-submit tests on the real route; proof the broker returns or links the client id on orders, fills and closes (P001: unverified per API) |
| 3   | Quotes and server time: tradable bid/ask with measured delay and the broker's server clock; a chart-only feed never counts as a quote; missing/stale quote rejects (F003 final guard)                        | `MarketDataAdapter` port, F003 guard with PAPER/fixture data     | Real provider adapter proof of quote freshness and server-time offset, status `Observed`, on the selected platform                                              |
| 4   | Account ownership: the adapter binds an `accountRef` to exactly one ASTRA account and verifies, at the boundary before every write, that the target account is the intended one                              | S002 binding pin and adapter-kind pinning (generic)              | Proof that the platform's `accountRef` format cannot alias another account; wrong-account write refused in a conformance test                                   |
| 5   | Durable evidence: every request, response, unknown outcome and reservation transition persisted before and after the call; reservations release only on authoritative broker evidence (ADR-0027)             | ADR-0027 reservations, evidence tests (PAPER)                    | Persisted-evidence tests on real-route payloads (redacted of secrets); crash-between-send-and-record recovery on the route                                      |
| 6   | Lossless protective actions: queued stop/close/cancel are never dropped across disconnect, restart or reconnect; re-read of broker state inside the lock before sending; pinned adapter instance/kind (S002) | S002 queued-action tests (PAPER)                                 | Reconnect/restart tests against the real session model; proof that protective orders survive a client disconnect or are re-established                          |
| 7   | Ownership and crash fencing on a real route: single owner per account across processes and restarts, quarantine of unclean sessions (R004/ADR-0027 §9)                                                       | **PAPER only — R004 fences cannot be attributed to real routes** | A new design and tests for LIVE-kind sessions (advisory lock, DIRTY/CLEAN, fences) — not inherited from R004                                                    |
| 8   | Phase rule application: the verified profile maps firm rules (loss basis, daily reset, news, consistency, holding) to ASTRA's schema; unmappable rules fail closed                                           | Two TEMPLATE profiles; mapping gaps in P001 §5                   | Exact program/step/terms plus owner confirmation; schema/engine tests per mapped rule; gaps left as blockers, not approximated                                  |
| 9   | Automation/cloud permission: the route is accepted in writing by the firm (P001: VPN/VPS forbidden, own-EA needs firm assessment)                                                                            | Not applicable                                                   | Written firm confirmation for the selected route; if cloud hosting is disallowed, an owner decision before any implementation                                   |
| 10  | Non-conflation: PAPER fences, reservations and CI results are never cited as proof for a real route, and nothing here enables LIVE (ADR-0008 six factors need the owner)                                     | Stage 1 PASS is PAPER execution-safety scope only                | Each future real-route claim cites its own tests and CI; live stays disabled                                                                                    |

## 5. Acceptance for the preparation task itself

- Records the confirmed firm and phase, the remaining unknowns and the exact dependencies (§1–§2).
- Maps existing `BrokerAdapter` requirements to evidence (§4) and distinguishes design from proof.
- No protocol, adapter, fake route, connection, credential or profile verification is introduced.
- Historical P001 findings stay as written (a dated addendum is recorded in `DECISIONS.md`).
- P002 preparation is a **candidate for CEO review**, not completed; route implementation is BLOCKED.

## 6. Minimum founder information to unblock platform-specific work

1. **The trading platform** shown on the FundingPips evaluation account (name as displayed), or "no
   account purchased yet / not decided".
2. **Exact program, size and evaluation step** (e.g. as shown on the account), and the reward option,
   optional DLL and add-ons if any.
3. The market-data feed shown on the account, if it is displayed.

Not requested: credentials, purchases, support contact, API access or data subscriptions.
