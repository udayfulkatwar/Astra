# P002 — FundingPips EVALUATION: platform-independent requirements and acceptance matrix

Status: **preparation, Markdown only, REVIEWED/ACCEPTED by the CEO for requirements scope only (2026-10-05 UTC); NOT a P002 route PASS.** This is a design
requirements document, not implemented proof. No code, protocol, connection, credential, purchase or
support contact is part of it. Source research and tests are not repeated: it uses the accepted P001
audit (`docs/ledger/P001_PLATFORM_AUDIT.md`, evidence tiers P/L/T unchanged) and the existing
`BrokerAdapter` port (`packages/execution/src/types.ts`).

## 1. Founder decision (2026-10-05) and what remains unknown

| Item                                                 | State                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Firm                                                 | **FundingPips — confirmed by the founder**                                                                                                              |
| Phase                                                | **EVALUATION — confirmed by the founder**                                                                                                               |
| Trading platform                                     | **MetaTrader 5 (MT5) — founder-confirmed 2026-10-05.** Not proof of a hosted API, firm entitlement, margin mode or idempotency; see `P002_MT5_ROUTE.md` |
| Program, account size, evaluation step, terms        | UNSPECIFIED (blocks rule-profile mapping only). The earlier "10K 2-Step Flex" in P001 is a historical intention, not an account                         |
| Feed, reward option, DLL, add-ons, purchase date     | UNKNOWN / if applicable — recorded only if displayed; never assumed absent                                                                              |
| Written firm confirmation that the route is accepted | NOT OBTAINED (P001: external own-software/API acceptance unresolved)                                                                                    |

"FundingPips + evaluation" does **not** specify a verified rule profile: targets, loss limits, news,
holding and automation rules differ per program/step/terms. No `PropFirmRuleProfile` becomes VERIFIED
from this decision; templates stay `UNVERIFIED`/`TEMPLATE` and LIVE refuses them.

## 2. Dependency gates (distinct)

1. **Platform name (now MT5, 2026-10-05)** unblocked protocol-specific DESIGN (done as a proposal in `P002_MT5_ROUTE.md`, awaiting CEO review) and fake-server contract selection: API protocol
   and auth model, the `accountRef` format, order/fill/position model (netting vs hedging, partial
   fills, protective-order attachment), reconnect/session semantics, server-time and quote sources,
   and whether `clientOrderId` is returned on orders, fills and closes.
2. **Exact program, size, evaluation step and terms** block rule-profile mapping (targets, loss mode
   and basis, holding/news restrictions, automation/VPS/VPN permission). Funded-phase reward options
   and the optional DLL may not apply to an evaluation account: they are recorded as unknown or
   if-applicable, never assumed absent, and are **not** prerequisites for protocol design.
3. **Written firm/API entitlement** for the selected route blocks any real connection or activation
   (P001 §9), not design work.

Protocol-specific implementation stays blocked until the CEO reviews the MT5 route proposal and the MT5 primary pages are read; until (2),
profile verification stays blocked; until (3), no connection. No profile is VERIFIED.

## 3. What can proceed now (platform-independent)

Only this requirements/acceptance matrix and founder intake. Nothing here is a generic adapter
scaffold; protocol code starts only after the platform is known.

## 4. Requirements → evidence matrix

"Existing" = what the repository already proves, from the Stage 1 PASS evidence (PAPER scope, CI
37240369181). "Required proof after platform supplied" is a design requirement and is **not**
implemented or tested for any real route today.

| #   | Requirement for any real `BrokerAdapter` (`kind: 'LIVE'`)                                                                                                                                             | Existing (PAPER only)                                                                                                                                                                     | Required proof after platform supplied                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Read-only state and reconciliation: `getAccountSnapshot`, `listOpenOrders`, `getOrder` read balance, equity, positions and orders without any write; a mismatch with ASTRA's records blocks entries   | PAPER adapter and generic reconciliation tests                                                                                                                                            | Fake-server conformance for the chosen protocol, including unknown/partial/stale responses mapped to non-OK (never defaulted to flat/healthy)                                                                                                                                                                                                                                                                                                              |
| 2   | Idempotency: `submitOrder` idempotent on `clientOrderId`, `closePosition` on `clientCloseId`; transport error means outcome unknown and is resolved by reading broker state, never by blind retry     | PAPER semantics; S001 reservations                                                                                                                                                        | Replay/timeout/duplicate-submit tests on the real route; proof the broker returns or links the client id on orders, fills and closes (P001: unverified per API)                                                                                                                                                                                                                                                                                            |
| 3   | Quotes and server time: tradable bid/ask with measured delay and the broker's server clock; a chart-only feed never counts as a quote; missing/stale quote rejects (F003 final guard)                 | `MarketDataAdapter` port (`packages/market-data/src/adapter.ts`) and F003 guard, tested with PAPER/fixture data; the Yahoo chart feed is prices-only, never a quote                       | Design requirement, not implemented: each `RawQuote.asOf` is the **provider** timestamp (never receive time); the provider symbol maps via `instrument.providerSymbols[adapter.id]`; bid/ask validated by the service; measured quote age, honest `health()` and reconnect backoff reported; `DataSourceKind` `LIVE` assigned only to real-time provider data and never to a delayed or chart-only feed. An `Observed` status alone is not freshness proof |
| 4   | Account ownership: the adapter binds an `accountRef` to exactly one ASTRA account and verifies, at the boundary before every write, that the target account is the intended one                       | S002 binding pin and adapter-kind pinning (generic)                                                                                                                                       | Proof that the platform's `accountRef` format cannot alias another account; wrong-account write refused in a conformance test                                                                                                                                                                                                                                                                                                                              |
| 5   | Durable evidence: every request, response, unknown outcome and reservation transition persisted before and after the call; reservations release only on authoritative broker evidence (ADR-0027)      | ADR-0027 reservations, evidence tests (PAPER)                                                                                                                                             | Persisted-evidence tests on real-route payloads (redacted of secrets); crash-between-send-and-record recovery on the route                                                                                                                                                                                                                                                                                                                                 |
| 6   | Lossless protective actions: queued stop/close/cancel are never dropped across disconnect, restart or reconnect; re-read of broker state inside the lock before sending; pinned adapter instance/kind | S002 proves **in-process** queued-action pinning and current admission in PAPER tests. It does **not** prove that a durable protective-action queue survives crash, restart or disconnect | **Unimplemented requirement:** durable lossless delivery and reconciliation of protective actions across crash/restart/disconnect, then real-session reconnect tests against the selected platform                                                                                                                                                                                                                                                         |
| 7   | Ownership and crash fencing on a real route: single owner per account across processes and restarts, quarantine of unclean sessions (R004/ADR-0027 §9)                                                | **PAPER only — R004 fences cannot be attributed to real routes**                                                                                                                          | A new design and tests for LIVE-kind sessions (advisory lock, DIRTY/CLEAN, fences) — not inherited from R004                                                                                                                                                                                                                                                                                                                                               |
| 8   | Phase rule application: the verified profile maps firm rules (loss basis, daily reset, news, consistency, holding) to ASTRA's schema; unmappable rules fail closed                                    | Two TEMPLATE profiles; mapping gaps in P001 §5                                                                                                                                            | Exact program/step/terms plus owner confirmation; schema/engine tests per mapped rule; gaps left as blockers, not approximated                                                                                                                                                                                                                                                                                                                             |
| 9   | Automation/cloud permission: the route is accepted in writing by the firm (P001: VPN/VPS forbidden, own-EA needs firm assessment)                                                                     | Not applicable                                                                                                                                                                            | Written firm confirmation for the selected route; if cloud hosting is disallowed, an owner decision/firm entitlement before any real connection, activation or deployment (protocol design and offline fake-server tests may proceed once the platform is known)                                                                                                                                                                                           |
| 10  | Non-conflation: PAPER fences, reservations and CI results are never cited as proof for a real route, and nothing here enables LIVE (ADR-0008 six factors need the owner)                              | Stage 1 PASS is PAPER execution-safety scope only                                                                                                                                         | Each future real-route claim cites its own tests and CI; live stays disabled                                                                                                                                                                                                                                                                                                                                                                               |

## 5. Acceptance for the preparation task itself

- Records the confirmed firm and phase, the remaining unknowns and the exact dependencies (§1–§2).
- Maps existing `BrokerAdapter` requirements to evidence (§4) and distinguishes design from proof.
- No protocol, adapter, fake route, connection, credential or profile verification is introduced.
- Historical P001 findings stay as written (a dated addendum is recorded in `DECISIONS.md`).
- P002 requirements preparation is **reviewed/accepted**; P002 route implementation is still **blocked and not complete**.

## 6. Minimum founder information to unblock platform-specific work

1. **The trading platform** shown on the FundingPips evaluation account (name as displayed), or "no
   account purchased yet / not decided".
2. **Exact program, size and evaluation step** as shown on the account.

Only if displayed or relevant: data feed, reward option, optional DLL and add-ons. Not requested:
credentials, purchases, support contact, API access or data subscriptions.
