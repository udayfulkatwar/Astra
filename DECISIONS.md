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

## F003 design (summary; detail in ADR-0027 §4a)

Every successful revalidation carries a REQUIRED synchronous final guard that keeps the assembled
evidence with its provenance (own timestamps, every FX quote). After the last awaited step, with no
`await` before `submitOrder`, the gateway re-checks control, the adapter/accountRef binding and
runs the guard: invalid or backward clock, trading-day rollover, aged account/FX/quote/calendar/
news evidence, provider revocation, and a re-run of the real engine on the captured inputs at the
current clock and state. Missing, throwing or asynchronous guards refuse. Rejected assumption (M001
lesson): a TTL check, a mocked boolean callback or the engine alone on captured inputs does not
prove freshness; the guard must be exercised through the real assembler/engine/API.

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
