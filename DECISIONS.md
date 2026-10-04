# DECISIONS

Index only; architecture lives in `docs/ARCHITECTURE.md` and the ADRs in `docs/adr/`
([index](docs/adr/README.md)). Do not duplicate ADR content here.

| ADR  | Topic                                                | Status   |
| ---- | ---------------------------------------------------- | -------- |
| 0001 | TypeScript modular monolith                          | Accepted |
| 0002 | PostgreSQL, plain SQL migrations                     | Accepted |
| 0003 | Fail-closed decision gate                            | Accepted |
| 0004 | Decimal arithmetic for risk                          | Accepted |
| 0005 | n8n orchestrates, core decides                       | Accepted |
| 0006 | Configuration as versioned files                     | Accepted |
| 0007 | One topology, local and cloud                        | Accepted |
| 0008 | Live trading authorization (six factors)             | Accepted |
| 0009 | Market data architecture                             | Accepted |
| 0010 | Market structure definitions                         | Accepted |
| 0011 | Economic calendar provider port                      | Accepted |
| 0012 | Position monitor                                     | Accepted |
| 0013 | Gate prices the trailing path                        | Accepted |
| 0014 | Automatic protective closing                         | Accepted |
| 0015 | Trade journal                                        | Accepted |
| 0016 | Backtesting                                          | Accepted |
| 0017 | Losing streak per trading day                        | Accepted |
| 0018 | Learning metrics                                     | Accepted |
| 0019 | News intelligence                                    | Accepted |
| 0020 | AI analysis layer (veto only)                        | Accepted |
| 0021 | n8n workflows                                        | Accepted |
| 0022 | Account-currency valuation                           | Accepted |
| 0023 | LIMIT entries                                        | Accepted |
| 0024 | LSFVG strategy engine                                | Accepted |
| 0025 | Research backtests                                   | Accepted |
| 0026 | Free chart feed                                      | Accepted |
| 0027 | Pre-submit validation + durable exposure reservation | Accepted |

## Session and mission rule

"Continue" never creates a new chat by itself. One active coding mission and one writer at a time.
Reuse the current session unless a concrete context, access or model reason warrants a new one. A
handoff always pins the accepted baseSHA and the reviewed evidence. Old chats are historical, not
simultaneous workers.

## P001 (Stage 2) — sourcing rule

Firm/platform facts count only when sourced to the official domain with URL and access date; a
paraphrase from a search tool is marked O-S (unread verbatim) and third-party pages are never facts.
The founder's named programs are intended targets, not purchased accounts. No profile is VERIFIED
without the evidence and owner confirmation; futures contracts and broker CFD symbols are never
mapped by assumption; no adapter, data purchase or provider activation before the founder's inputs.
Detail: `docs/ledger/P001_PLATFORM_AUDIT.md`.

## Stage 1 integration

Accepted tasks are integrated by fast-forward from the last accepted head; the integrated candidate
changes only status documents, stale ADR statements and added evidence tests (migration immutability
and the 0014→0015 upgrade). The CI workflow stays as is; the two Claude workflows are retained
(operator tooling, not part of the product gate) pending an owner decision.

## S002 design (summary; detail in ADR-0027 §10)

Queued cancel / protective close judge permission INSIDE the account lock from current state
(mode, loaded controls, EXECUTION switch, current binding equal to the queued one, adapter kind,
LIVE authorization), after awaited reads and immediately before the broker call; entry-only
switches and HALTED never block risk reduction; persistence failures after a broker answer are
reported step by step (no claim about the reservation beyond what the store committed); the queued
binding pins the adapter instance and kind; an in-memory-only halt blocks admission and CLEAN.

## R004 design (summary; detail in ADR-0027 §9)

One PAPER owner at a time: advisory lock plus a DIRTY session row ACKed before any paper state is
restored, mutated or read; the row stays DIRTY until a clean stop ACKs a final checkpoint whose
revisions the next start verifies. Any other previous session quarantines every paper account
(gateway AND DB reserve/dispatch refuse, no kill switch needed); lock loss halts local admission.
Snapshots are immutable and revisioned, failed saves are never absorbed. Conservative by design:
no automatic clearing, no recovery that re-applies lost mutations. Review lessons: lock identity is
proved on the original backend (never by "a query succeeded"), legacy evidence without an owner
record is unclean, CLEAN means exact checkpoint sets, the owner fence lives in the database
operations (missing row fails closed for PAPER), and a clean stop admits-or-refuses before running
and drains all paper activity before the checkpoint.

## F003 design (summary; detail in ADR-0027 §4a)

Every successful revalidation carries a REQUIRED synchronous final guard that keeps the assembled
evidence with its provenance (own timestamps, every FX quote). After the last awaited step, with no
`await` before `submitOrder`, the gateway re-checks control, the adapter/accountRef binding and
runs the guard: invalid or backward clock, trading-day rollover, aged account/FX/quote/calendar/
news evidence, provider revocation, and a re-run of the real engine on the captured inputs at the
current clock and state. Missing, throwing or asynchronous guards refuse. Rejected assumption (M001
lesson): a TTL check, a mocked boolean callback or the engine alone on captured inputs does not
prove freshness; the guard must be exercised through the real assembler/engine/API. Rejected at
`f0b2c283`: the guard read current quote/calendar/news only for status and reused the captured
values, so a revised calendar or changed news risk (still OK, fresh) went unseen; current OK
observations now replace the captured ones. Its CI also failed typecheck (invalid test status).

## S001 design (summary; detail in ADR-0027)

Re-check the control plane after every await and right before submit; revalidate the original
candidate with the existing engines on fresh data; reserve account-wide exposure in the same DB
transaction that consumes the approval (ledger version = optimistic token, row lock = shared
serialisation); release only on authoritative evidence; never net positions without order linkage.
S001-R3: evidence about an order whose reservation was released is judged against the unchanged
tombstone; anything but a consistent repeat durably quarantines the account (shared, enforced by
the gate and the reservation step, no clearing path yet). Corrective migration `0012`. Tracking:
same-day references never decrease; completed-day conflicts resolve only on per-day evidence,
otherwise tracking fails closed.
