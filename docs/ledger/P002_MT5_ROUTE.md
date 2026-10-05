# P002 — FundingPips (MetaTrader 5) route feasibility, design and offline conformance plan

Status: **design only, candidate for CEO review (2026-10-05 UTC). Not a route PASS.** No code, install,
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

## 3. MT5 integration facts to verify (none verified yet)

| #   | Topic                      | Working assumption                                                                                                                                                                                        | Label     | Primary page to read (mql5.com / metatrader5.com)                           |
| --- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------- |
| 1   | Integration options        | (a) MQL5 Expert Advisor running inside the terminal; (b) official `MetaTrader5` Python package that drives a **locally installed terminal** over local IPC. No hosted server REST API for retail accounts | S/K       | Python Integration; Expert Advisors docs; broker/firm terms                 |
| 2   | OS / deployment            | Python package officially supported on **Windows only**; terminal must be installed, logged in and running on that machine; broker server, login and password are terminal-side                           | K         | Python Integration (`initialize`, `login`, requirements); install notes     |
| 3   | Quote and server time      | Ticks carry a server-time stamp (ms in `time_msc`); the terminal can report trade-server time; server time zone is the broker's, NOT UTC                                                                  | K         | `symbol_info_tick`, `copy_ticks_*`, `SymbolInfoTick`, server-time notes     |
| 4   | Identities                 | Order ticket, position ticket and deal ticket are distinct integers; `position_id` links deals to a position; tickets are scoped to the account/server                                                    | K         | `positions_get`, `history_orders_get`, `history_deals_get`, deal properties |
| 5   | `magic` / `comment`        | `magic` is an integer tag and `comment` free text; **comment may be truncated or overwritten by the server or on partial/closing deals; neither is a uniqueness-enforced idempotency receipt**            | S/K       | `OrderSend` request/result, order and deal comment properties               |
| 6   | `request_id` / `retcode`   | `request_id` and `retcode` describe one request; some retcodes mean the outcome is not final (e.g. timeout, requote, price changed, connection lost) — **exact set and semantics to be read**             | S/K       | Trade server return codes                                                   |
| 7   | Hedging vs netting         | Account margin mode is hedging, netting or exchange; netting merges fills of a symbol into ONE position (changing position identity, SL/TP scope); hedging keeps separate positions                       | K         | `AccountInfoInteger(ACCOUNT_MARGIN_MODE)`, position docs                    |
| 8   | Fill policy, partial fills | Fill type (FOK/IOC/return) is symbol-dependent; partial fills possible; `deviation` is a slippage allowance; SL/TP can be sent with the request                                                           | K         | `ORDER_FILLING_*`, `order_check`, `order_send` fields                       |
| 9   | Dry-run and state reads    | `order_check` validates a request without sending; `positions_get`, `orders_get`, `history_*`, `account_info`, `terminal_info` give read-only state; history reads are time-window bounded                | K         | Python Integration function list                                            |
| 10  | Firm entitlement           | FundingPips automation/EA rules, VPS/VPN prohibition and proof-of-own-EA (P001 P-tier facts) decide whether an external process driving the terminal is permitted; **unresolved**                         | P(P001)/L | FundingPips rules (P001 §4); written firm confirmation                      |

## 4. Route options and recommendation

| Option                                                                                             | For                                                                                                                                                                                                 | Against / risk                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1 — Terminal bridge: Python `MetaTrader5` package in a small sidecar** on the founder's machine | Same language family as the existing Python kit; the terminal-module surface can be replaced by an in-memory fake, so conformance runs offline with no terminal; read-only state calls are explicit | Windows-only [K]; the sidecar is external software to the terminal (firm may require an EA, P001); no event stream (poll + history reconcile)                                                       |
| **R2 — MQL5 EA bridge** inside the terminal                                                        | The conventional "own EA" artefact a firm can assess; `OnTradeTransaction` events and in-terminal journal (Files) are strong for unknown outcomes                                                   | A second language with no repository test harness; cannot be unit-tested offline without a custom MQL5 harness; WebRequest/socket permission configuration inside the terminal                      |
| R3 — hosted/cloud MT5 REST API                                                                     | —                                                                                                                                                                                                   | **Not assumed to exist for a retail MT5 account; third-party bridges are not accepted as facts; VPS/VPN forbidden by the firm (P001).** Rejected unless a primary source and firm permission appear |

**Recommendation: R1 as the primary design, R2 as the pre-agreed fallback, behind ONE ASTRA-side protocol
(§6) so the ASTRA adapter and conformance suite do not change if the firm requires an EA.** Reasons:
(1) the only option whose offline conformance can be built and proven in this repository; (2) read-only
state and `order_check` give a dry-run path before any write; (3) the protocol boundary isolates every MT5
quirk in the bridge. **Switch to R2 if** a primary read shows the Python package is not Windows-portable to
the founder's machine, or the firm/entitlement requires an EA. **Hosting:** the terminal and bridge run on
the founder's own machine (ASTRA's cloud host is not the terminal host; P001 VPN/VPS prohibition); the bridge
only dials out to ASTRA. If the founder's machine cannot run it, that is an owner decision, not an
assumption.

## 5. Mapping to the existing `BrokerAdapter` port (design)

| Port element                       | MT5 route design                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accountRef`                       | Opaque `mt5:<server>:<login>` built from the terminal's own reported account (handshake), never from user text; every write re-verifies the terminal is logged into that exact login+server                                                                                                                                                          |
| `clientOrderId` idempotency        | **ASTRA's committed reservation ledger (ADR-0027) and the bridge's durable journal are the authority; `magic`/`comment` are best-effort correlation hints only.** Before any (re)send the bridge searches open orders, positions and recent history for the hint; found → report, not found → still `UNKNOWN` unless the journal proves "never sent" |
| `submitOrder`                      | Pre-checks (handshake status, `order_check` pass, symbol mapping, mode) → journal "intent" fsynced → `order_send` with SL/TP attached → result → journal. Any exception/timeout/ambiguous `retcode` → `UNKNOWN` (never `REJECTED`), resolved only by reconciliation                                                                                  |
| `getOrder` / `listOpenOrders`      | Read-only terminal order and position queries plus bounded history; return `null` only when the journal and a covering history window both show it absent, else `UNKNOWN`                                                                                                                                                                            |
| `cancelOrder`                      | Pending-order removal request; same unknown-outcome handling                                                                                                                                                                                                                                                                                         |
| `closePosition` / `clientCloseId`  | Close by **position ticket** (hedging) with journalled intent; `NOT_FOUND` only when the position is absent from open positions AND history shows its closing deal (or the account's full state is covered); otherwise `UNKNOWN`                                                                                                                     |
| `getAccountSnapshot`               | Balance, equity, margin and open positions read in one bridge call with terminal timestamp and a coherent sequence; stale/partial → non-OK                                                                                                                                                                                                           |
| `positionId`                       | Position ticket; netting accounts are **refused** (fail closed) until a separate netting design exists                                                                                                                                                                                                                                               |
| `MarketDataAdapter` (`kind: LIVE`) | `RawQuote.asOf` = the tick's **server timestamp converted to UTC with a verified offset rule**, never receive time; bid/ask from the tick; `providerSymbols['mt5']` maps ASTRA symbols to the broker's exact symbol names (suffixes differ); delayed/untrusted → not `LIVE`                                                                          |

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

1. No trade unless the handshake, lease, reconciliation and heartbeat are all healthy and fresh; any missing field is non-OK.
2. Entries are sent only after fresh deterministic revalidation and a committed reservation (ADR-0027); the bridge never decides.
3. SL/TP are attached to the entry request; an entry that cannot carry them is refused (no unprotected position by design).
4. Ambiguous or timed-out `order_send` ⇒ `UNKNOWN`; reservation is released only on authoritative evidence; contradictory evidence ⇒ durable quarantine.
5. `magic`/`comment` are never treated as unique receipts; a resend after `UNKNOWN` is forbidden until reconciliation proves the first did not occur.
6. Netting/exchange margin mode, unknown symbol mapping, symbol trade-mode not full, or a server/login mismatch ⇒ refusal.
7. Protective closes survive bridge/ASTRA restart only with a **durable protective-action queue — an existing gap (S002 proves in-process pinning only)**; until built, a real route may not claim lossless protective delivery.
8. Terminal disconnect or stale quotes ⇒ new entries blocked; the account's open positions rely on server-side SL/TP and are reconciled on reconnect.
9. No real-route claim may cite PAPER/R004/S002/CI evidence; each needs its own tests.

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

Offline fake conformance proves the **adapter/bridge logic against a model**, not MT5's real behaviour; a
read-only dry run against a real terminal needs separate CEO authorization.

## 9. Gates and unresolved items

| Gate                                                                                                             | Blocks                                                          | State       |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------- |
| CEO review of this route proposal                                                                                | any implementation                                              | **OPEN**    |
| CEO primary read of the §3 pages (build facts [K]/[S] → P)                                                       | the retcode table, time-zone rules, fake generation, then code  | **OPEN**    |
| Written firm entitlement for automation through the chosen route (EA vs external process; own-EA proof; VPS/VPN) | any real connection/activation                                  | **OPEN**    |
| Founder machine/OS able to host the terminal and bridge (Windows if R1)                                          | R1 choice vs R2                                                 | UNKNOWN     |
| Account margin mode (hedging expected, unconfirmed)                                                              | position model; netting is refused                              | UNKNOWN     |
| Exact FundingPips program/size/step/terms                                                                        | rule-profile mapping only (not this design)                     | UNSPECIFIED |
| Durable protective-action queue; real-route ownership/fencing design                                             | any claim of lossless protection / single owner on a real route | **GAP**     |

## 10. Not claimed

No route PASS, no adapter, no verified MT5 fact, no firm entitlement, no hosted API, no unique idempotency
receipt from `magic`/`comment`, no live readiness. R004/S002 remain PAPER-only; the durable queue and
real-route ownership gaps stand. TradeSea (Lucid) is secondary context and is not designed here.
