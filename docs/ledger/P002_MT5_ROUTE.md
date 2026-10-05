# P002 — FundingPips (MetaTrader 5) route feasibility, design and offline conformance plan

Status: **design only; revised after CEO review of `cac2c73` — final review candidate (2026-10-05 UTC). Not a route PASS.** No code, install,
terminal/account/API connection, credential, firm contact, spend, data run or LIVE. Preserves the dated
P001 audit and the accepted `P002_REQUIREMENTS.md` (§4 matrix) as the requirement baseline.

## 1. Founder decision (2026-10-05) and scope

- FundingPips platform: **MetaTrader 5 (MT5)**; phase **EVALUATION**. The exact FundingPips program/size/step
  is **UNSPECIFIED** (the historical 10K 2-Step Flex is not inferred); it blocks only rule-profile mapping,
  not this design.
- Lucid Trading platform: **TradeSea** — recorded as **secondary context only**; no second route is opened.
- MT5 is **not** by itself proof of: a hosted/public server REST API, the firm's entitlement for automation
  through this route, the account's margin mode (hedging vs netting), or end-to-end idempotency.

## 2. Evidence and labels (read first)

Repository inspected: `BrokerAdapter` / `OrderRequest` / `BrokerOrderState` / `ClosePositionRequest|Result`
(`packages/execution/src/types.ts`), `MarketDataAdapter` / `RawQuote` (`packages/market-data/src/adapter.ts`),
`instrument.providerSymbols`, P001 §4–§7 and `P002_REQUIREMENTS.md`.

**MetaQuotes primary pages were NOT fetched.** Direct fetches of `www.mql5.com` returned
`EGRESS_BLOCKED` in this environment (`docs.mql5.com` does not resolve); a blocked fetch is not proof the
page is unavailable. One web search returned only result titles and a short generated summary of
`https://www.mql5.com/en/docs/python_metatrader5/mt5ordersend_py` and
`https://www.mql5.com/en/docs/python_metatrader5`. Therefore every MT5 fact below is labelled:

- **[S]** seen in that search summary (still tier L until a primary read): `order_send` sends a trading
  request from the terminal to the trade server; the result mirrors `MqlTradeResult` (fields `retcode`,
  `deal`, `order`, `volume`, `price`, `request_id`) and carries a copy of the request; the request has a
  `magic` EA identifier and a free-text `comment`; success is checked via `retcode`.
- **[K]** Claude background knowledge, **UNVERIFIED** — must be confirmed by a CEO primary read before any
  reliance. Nothing marked [K] is a current fact.

## 2A. CEO primary reads (tier P; 2026-10-05)

The CEO read these official MetaQuotes pages (via web search/open). My earlier `EGRESS_BLOCKED` result stays an
environment limitation, not evidence of absence. Only the statements below are promoted to P; everything
else stays [S]/[K].

| URL (www.mql5.com/en/docs/…)                    | Supported statement (P)                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `python_metatrader5`                            | The official package talks to the MT5 terminal over IPC; function list is published. The docs' Windows example is **not** proof of Windows-only support and not the founder's OS. `initialize` can launch the terminal if required (it need not already be running) |
| `python_metatrader5/mt5ordersend_py`            | Request has `magic`, `comment`, `volume` (lots), `sl`, `tp`, position ticket and fill policies; result is `MqlTradeResult`                                                                                                                                          |
| `trading/ordersend`                             | A true result means the request was **accepted, not that it filled**                                                                                                                                                                                                |
| `constants/tradingconstants/positionproperties` | `POSITION_IDENTIFIER` is stable for the position lifecycle (linked by `ORDER_POSITION_ID` / `DEAL_POSITION_ID`); `POSITION_TICKET` **may change** (service operations, netting reversal)                                                                            |
| `python_metatrader5/mt5copyticksfrom_py`        | Terminal tick/bar data are **UTC without shift**: do **not** apply a broker timezone offset to Python tick epochs                                                                                                                                                   |
| `dateandtime/timecurrent`                       | MQL `TimeCurrent` is the last known server-quote time and can be stale — a separate server-clock domain                                                                                                                                                             |
| `dateandtime/timetradeserver`                   | `TimeTradeServer` is a client-computed estimate depending on the computer clock — **not** an authoritative current server/UTC time                                                                                                                                  |
| `constants/structures/mqltick`                  | `time_msc` is the last price update in ms; bid/ask present                                                                                                                                                                                                          |
| `event_handlers/ontradetransaction`             | Event arrival order is **not guaranteed** and a 1024-entry queue can overwrite events: EA events are not durable proof                                                                                                                                              |

**Still unresolved (not promoted):** retcode-specific classification, OS compatibility for the founder's machine,
whether `comment` is ever altered, margin-mode behaviour on the actual account, and firm acceptance of the route.

## 3. MT5 integration facts to verify (P-tier reads in §2A; the rest unverified)

| #   | Topic                      | Working assumption                                                                                                                                                                                                                                           | Label     | Primary page to read (mql5.com / metatrader5.com)              |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | -------------------------------------------------------------- |
| 1   | Integration options        | (a) MQL5 Expert Advisor running inside the terminal; (b) official `MetaTrader5` Python package that drives a **locally installed terminal** over local IPC. No hosted server REST API for retail accounts                                                    | S/K       | Python Integration; Expert Advisors docs; broker/firm terms    |
| 2   | OS / deployment            | Package IPC to a terminal on the same machine (P, §2A); **OS support and the founder's OS are unresolved** (Windows is only a docs example). A local terminal is required to be reachable; `initialize` may launch it (P)                                    | P/K       | Python Integration (`initialize`, requirements); install notes |
| 3   | Quote and server time      | Python tick/bar epochs are **UTC, no broker-offset shift (P)**; MQL `TimeCurrent` (stale-able server-quote time) and `TimeTradeServer` (client estimate) are separate clock domains and are not authoritative UTC (P); `time_msc` = last price update ms (P) | P         | `copy_ticks_from`, `TimeCurrent`, `TimeTradeServer`, `MqlTick` |
| 4   | Identities                 | `POSITION_IDENTIFIER` is the stable position identity; `POSITION_TICKET` may change (P). Order/deal tickets link via `ORDER_POSITION_ID`/`DEAL_POSITION_ID` (P); scoping per account/server [K]                                                              | P/K       | position properties; `history_*_get`                           |
| 5   | `magic` / `comment`        | `magic` is an integer tag and `comment` free text; **comment may be truncated or overwritten by the server or on partial/closing deals; neither is a uniqueness-enforced idempotency receipt**                                                               | S/K       | `OrderSend` request/result, order and deal comment properties  |
| 6   | `request_id` / `retcode`   | True from `OrderSend` = **accepted, not filled** (P). `request_id`/`retcode` semantics and which retcodes are non-final are **unresolved** — read the trade-server return-code table before classification                                                   | P/K       | Trade server return codes                                      |
| 7   | Hedging vs netting         | Account margin mode is hedging, netting or exchange; netting merges fills of a symbol into ONE position (changing position identity, SL/TP scope); hedging keeps separate positions                                                                          | K         | `AccountInfoInteger(ACCOUNT_MARGIN_MODE)`, position docs       |
| 8   | Fill policy, partial fills | Fill type (FOK/IOC/return) is symbol-dependent; partial fills possible; `deviation` is a slippage allowance; SL/TP can be sent with the request                                                                                                              | K         | `ORDER_FILLING_*`, `order_check`, `order_send` fields          |
| 9   | Dry-run and state reads    | `order_check` validates a request without sending; `positions_get`, `orders_get`, `history_*`, `account_info`, `terminal_info` give read-only state; history reads are time-window bounded                                                                   | K         | Python Integration function list                               |
| 10  | Firm entitlement           | FundingPips automation/EA rules, VPS/VPN prohibition and proof-of-own-EA (P001 P-tier facts) decide whether an external process driving the terminal is permitted; **unresolved**                                                                            | P(P001)/L | FundingPips rules (P001 §4); written firm confirmation         |

## 4. Route options and recommendation

| Option                                                                                             | For                                                                                                                                                                                                 | Against / risk                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1 — Terminal bridge: Python `MetaTrader5` package in a small sidecar** on the founder's machine | Same language family as the existing Python kit; the terminal-module surface can be replaced by an in-memory fake, so conformance runs offline with no terminal; read-only state calls are explicit | Windows-only [K]; the sidecar is external software to the terminal (firm may require an EA, P001); no event stream (poll + history reconcile)                                                       |
| **R2 — MQL5 EA bridge** inside the terminal                                                        | The conventional "own EA" artefact a firm can assess; `OnTradeTransaction` events and in-terminal journal (Files) are strong for unknown outcomes                                                   | A second language with no repository test harness; cannot be unit-tested offline without a custom MQL5 harness; WebRequest/socket permission configuration inside the terminal                      |
| R3 — hosted/cloud MT5 REST API                                                                     | —                                                                                                                                                                                                   | **Not assumed to exist for a retail MT5 account; third-party bridges are not accepted as facts; VPS/VPN forbidden by the firm (P001).** Rejected unless a primary source and firm permission appear |

**Recommendation (an engineering choice, not a constraint): R1 primary, R2 fallback, behind ONE ASTRA-side
protocol (§6).** Reasons: (1) the Python package keeps all MT5 code in testable Python and exposes
read-only state plus `order_check`; (2) the MT5 quirks are isolated in the bridge. R2 can also be exercised
by a protocol-side offline fake harness (the bridge protocol, not the MQL5 code, is what the ASTRA suite
tests), so R1 is not claimed to be the only testable option and the suite is not promised unchanged across
routes. **R2 is not pre-approved for real integration**; either route needs its own firm entitlement and
review. **Hosting** (terminal and bridge on the founder's own machine, bridge dialing out to ASTRA) is a
**proposal subject to firm and cloud-permission review (P001 VPN/VPS prohibition), not a workaround.**
If the founder's machine/OS cannot host it, that is an owner decision, not an assumption.

## 5. Mapping to the existing `BrokerAdapter` port (design)

| Port element                       | MT5 route design                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accountRef`                       | Canonical, length-prefixed or JSON-array-encoded `(server, login)` (no separator that can alias, e.g. a server name containing `:`); built from the terminal's own reported account, never from user text; every write re-verifies the terminal is logged into that exact pair                                                                                                                                                                                                                                                                                                              |
| `clientOrderId` idempotency        | Durable per-account unique lock on `(accountRef, clientOrderId)`. **Persist intent AND an irreversible `SEND_MAY_HAVE_STARTED` marker before the terminal call.** Same id with a different payload is rejected. A retry replays the persisted result or does read-only reconciliation and **never repeats an ambiguous send**. `magic`/`comment` are hints only: a found hint alone is not adoption evidence; "not found in recent history" cannot prove a send never executed; no resend after a dispatched `UNKNOWN` on bounded-history absence; quarantine and reservations are retained |
| `submitOrder`                      | Pre-checks (handshake, `order_check`, symbol mapping, mode) → durable intent + marker → `order_send` with SL/TP in the request → result journalled. An accepted result is **not** a fill (P): fill is established by order/deal/position reads. Exception/timeout/ambiguous retcode → `UNKNOWN` (never `REJECTED`); resolved only by reconciliation                                                                                                                                                                                                                                         |
| Quantity                           | ASTRA quantity → MT5 lots via the instrument's contract size and the symbol's volume min/step/max read from the terminal; **no assumed 1:1**; a quantity not exactly representable → refuse                                                                                                                                                                                                                                                                                                                                                                                                 |
| `getOrder`                         | Returns `null` only with proof the order was **never dispatched** (journal); otherwise the observed state or `UNKNOWN`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `listOpenOrders`                   | Includes **all** orders on the account, foreign/manual ones included (never filtered by hint); a foreign order that ASTRA cannot account for → refuse/quarantine                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `cancelOrder`                      | Pending-order removal with the same intent/marker/unknown handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `positionId` / `closePosition`     | `positionId` = `POSITION_IDENTIFIER` (P) with a **current-ticket lookup at send time**; the close proves the same identity. The port's `ClosePositionResult` has **no UNKNOWN**: an unknown outcome is thrown as a typed transport/unknown error (as the port documents), never mapped to `REJECTED`/`CLOSED`. A **partial close is never reported `CLOSED`**; confirmed closed quantity and order/deal linkage are preserved. `NOT_FOUND` requires the position's absence **plus** closing-deal/order evidence; absence from open positions alone is not closure proof                     |
| `getAccountSnapshot`               | Balance, equity, margin and positions are read as several calls; **coherence is checked (sequence/time/consistency), atomicity is not assumed**; stale/inconsistent → non-OK                                                                                                                                                                                                                                                                                                                                                                                                                |
| Wire identifiers                   | Tickets and identifiers are `ulong`: carried in JSON as **decimal strings**, never JS numbers (no float precision loss)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `MarketDataAdapter` (`kind: LIVE`) | `RawQuote.asOf` = the tick's provider timestamp: Python tick epochs are **UTC with no offset applied (P)**; MQL `TimeCurrent`/`TimeTradeServer` values stay in their own domains and are never mixed or used as authoritative UTC; bid/ask from the tick; `providerSymbols['mt5']` maps symbols; delayed or untrusted → not `LIVE`                                                                                                                                                                                                                                                          |

## 6. Protocol boundary and handshake (design; not code)

Bridge ⇄ ASTRA, versioned JSON frames over an **outbound-only, authenticated, encrypted** connection from the
bridge (token from an env var name in config; no secrets in the repository or chat). The terminal login and
password never leave the founder's machine.

1. **Hello:** bridge sends `{protocolVersion, bridgeVersion, route: R1|R2, bridgeInstanceId (fresh), codeHash}`.
2. **Terminal facts:** terminal build, connected-to-server flag, account login, server, currency, margin
   mode, trade-allowed flags, server-time offset sample and symbol list. ASTRA **refuses** the session unless
   every field is present, margin mode is HEDGING, trading is allowed, and login+server equal the configured
   `accountRef`.
3. **Ownership:** ASTRA grants one session lease per account (advisory-lock style, as R004 does for PAPER —
   a **new design for a real route**; R004 fences are PAPER-only and do not apply). A second bridge or a
   restarted bridge with a new `bridgeInstanceId` is a new lease and starts with full reconciliation.
4. **Reconcile before trade:** bridge returns positions, open orders and journal-vs-history findings;
   ASTRA compares with its ledger; any mismatch or `UNKNOWN` entry ⇒ account quarantined, entries blocked.
5. **Heartbeat/time:** monotonic sequence numbers and heartbeat; a gap, duplicate, reordering or stale
   frame ⇒ the session is unhealthy and writes are refused. Commands carry an ASTRA command id and
   expiry; the bridge never executes an expired command.
6. **Commands/results:** `submit`, `cancel`, `close`, `get_order`, `list_open`, `snapshot`, `quotes`;
   each reply states `OK | REJECTED(reason, retcode) | UNKNOWN`. Unrecognised or malformed → `UNKNOWN`/refusal.

## 7. Fail-closed requirements (all new, none implemented)

1. **Entry gates:** no entry unless handshake, lease, reconciliation, heartbeat, trade-allowed and fresh quotes are all healthy; any missing fact is non-OK. These gates apply to ENTRIES only.
2. **Protective actions** (close/cancel) keep the current S002 matrix permissions and are **not** lost to entry gates, a stale quote or an expired entry command. The durable queue and stale-owner dependencies are **not implemented** (gap).
3. Entries are sent only after fresh deterministic revalidation and a committed reservation (ADR-0027); the bridge never decides.
4. SL/TP are included in the entry request, but that is **not proof the server installed them**: after a fill, the actual protection is reconciled; missing/mismatched protection is blocked and persisted as a failure (no silent assumption).
5. Ambiguous/timed-out `order_send` ⇒ `UNKNOWN`; the durable marker, quarantine and reservations persist; release only on authoritative evidence; contradictory evidence ⇒ durable quarantine.
6. `magic`/`comment` are never unique receipts; adoption needs more than a found hint; "not found" in bounded history never proves "never executed".
7. **Stale-writer fencing:** the lease/owner fence must be checked **at the terminal write boundary**; lease expiry alone cannot stop a stale process; no automatic owner handoff unless the old writer demonstrably cannot act. Terminal-boundary fencing is **unresolved implementation proof**.
8. Netting/exchange margin mode, unknown symbol mapping, symbol trade-mode not full, or a server/login mismatch ⇒ refusal.
9. Terminal disconnect or stale quotes block new entries; open positions are reconciled on reconnect.
10. EA `OnTradeTransaction` events (R2) are never durable proof (P): arrival order and overwrites are possible; reconciliation reads state.
11. No real-route claim may cite PAPER/R004/S002/CI evidence; each needs its own tests.

## 8. Offline fake-terminal conformance cases (planned; the fake models the MT5 surface, not a server)

A deterministic in-memory fake terminal/trade server (scriptable retcodes, latency, disconnects, partial
fills, history windows, comment truncation) drives the bridge, and the bridge drives the ASTRA adapter
through the §6 protocol. Required cases:

1. Handshake: each missing/odd fact (netting mode, wrong login/server, trading disabled, no server time) → refused.
2. Happy submit with SL/TP; fill → `FILLED`; deal/position/order ids mapped; partial fill → `PARTIALLY_FILLED` with exact quantities.
3. Timeout before result; timeout after fill; connection lost mid-call; duplicate `request_id`: all → `UNKNOWN`, then reconciliation resolves each, never a double order.
4. Comment truncated/changed or `magic` collision (another EA's order with the same hint): correlation never adopts a foreign order; an unprovable case stays `UNKNOWN`.
5. Requote/price-changed/off-quotes/market-closed/invalid-stops/no-money retcodes → typed `REJECTED` vs `UNKNOWN` per the verified table.
6. Close: normal, already closed (`NOT_FOUND` proof), partial close, close racing a server-side SL/TP hit, retry with the same `clientCloseId`.
7. Restart: bridge restart mid-submit (journal intent without result) and ASTRA restart (lease lost) → quarantine/reconcile before any write; second bridge instance refused.
8. Quotes: provider-timestamp source, server-time offset (including a DST shift in the broker's zone), stale tick, crossed/zero bid-ask, symbol alias mapping, delayed feed not labelled `LIVE`.
9. Account read: equity vs balance, floating P&L, margin; stale or inconsistent snapshot → non-OK.
10. Heartbeat gaps, sequence reordering, malformed frames, expired commands, token failure.
11. A fake-vs-real divergence guard: the fake's retcode table and field semantics are generated from the verified primary read and carry its source/date, so an unverified retcode cannot be encoded as a fact.
12. Idempotency: same id + different payload rejected; crash after `SEND_MAY_HAVE_STARTED` and before result → retry never resends, reconciles read-only; durable lock under two concurrent callers.
13. Foreign/manual orders and positions present: `listOpenOrders`/snapshot include them; unaccountable ones quarantine; a foreign order with a colliding `magic`/`comment` is never adopted.
14. Position identity: ticket changes (service operation / netting-style reversal) while `POSITION_IDENTIFIER` stays; close proves identity; partial close reported with confirmed quantity, never `CLOSED`; `NOT_FOUND` only with closing evidence; unknown close outcome surfaces as a typed unknown error.
15. Accepted-not-filled: accepted result without a fill stays non-FILLED until order/deal reads confirm; accepted entry whose SL/TP are absent on the position → protection failure persisted and entries blocked.
16. Stale writer: a fenced old bridge attempts a write after a new lease; the write is refused at the terminal boundary (fake enforces), including after lease expiry.
17. Wire: tickets above 2^53 round-trip exactly as decimal strings; `accountRef` with separator-like characters cannot alias another account; lots conversion with volume step (not-representable → refuse); non-atomic snapshot with a mid-read change → non-OK.
18. Gating: entry blocked by stale quote / trade-not-allowed / expired entry command while a protective close/cancel is still permitted per the S002 matrix; clock-domain test (Python tick UTC vs `TimeCurrent`/`TimeTradeServer`) never applies a broker offset to a Python tick epoch.

Offline fake conformance proves the **adapter/bridge logic against a model**, not MT5's real behaviour; a
read-only dry run against a real terminal needs separate CEO authorization.

## 9. Gates and unresolved items

| Gate                                                                                                                     | Blocks                                                          | State           |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | --------------- |
| CEO review of this route proposal                                                                                        | any implementation                                              | **OPEN**        |
| CEO primary read of the REMAINING pages (retcode table, `comment` behaviour, OS support); P-tier reads so far are in §2A | the retcode table, fake generation, then code                   | **PARTLY DONE** |
| Written firm entitlement for automation through the chosen route (EA vs external process; own-EA proof; VPS/VPN)         | any real connection/activation                                  | **OPEN**        |
| Founder machine/OS able to host the terminal and bridge (package OS support unresolved)                                  | R1 vs R2 choice                                                 | UNKNOWN         |
| Account margin mode (hedging expected, unconfirmed)                                                                      | position model; netting is refused                              | UNKNOWN         |
| Exact FundingPips program/size/step/terms                                                                                | rule-profile mapping only (not this design)                     | UNSPECIFIED     |
| Durable protective-action queue; real-route ownership/fencing design                                                     | any claim of lossless protection / single owner on a real route | **GAP**         |

## 10. Not claimed

No route PASS, no adapter, no verified MT5 fact, no firm entitlement, no hosted API, no unique idempotency
receipt from `magic`/`comment`, no live readiness. R004/S002 remain PAPER-only; the durable queue and
real-route ownership gaps stand. TradeSea (Lucid) is secondary context and is not designed here.
