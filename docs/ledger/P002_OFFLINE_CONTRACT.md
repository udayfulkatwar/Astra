# P002 — offline bridge contract, durable journal and fake-terminal conformance (evidence ledger)

Status: **ACCEPTED by the CEO for OFFLINE contract / journal / controlled fake conformance only (2026-10-05); NOT a P002 real-route PASS.**
Scope: the first bounded increment authorized after the accepted MT5 design (`P002_MT5_ROUTE.md`). Nothing
here imports an MT5 SDK or talks to a terminal, account, API or network; nothing is registered at runtime;
no real `BrokerAdapter` exists; LIVE stays disabled.

## 1. What was built (files)

| File                                                                      | Role                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/execution/src/mt5-offline/contract.ts`                          | Versioned (v1) strict validator returning a detached, frozen snapshot; decimal-string ulong ids; bounded raw input; strict Gregorian times; canonical account binding; payload hash; UTC ticks |
| `packages/execution/src/mt5-offline/transport.ts`                         | Fake-only transport port, account-bound `Fence`, `WriteBoundary`, abstract result model and operation-specific strict reply validator                                                          |
| `packages/execution/src/mt5-offline/journal.ts`                           | `BridgeJournal` port (durability is an implementation obligation), `MarkerGuard`, owner/takeover types                                                                                         |
| `packages/execution/src/mt5-offline/bridge.ts`                            | Runner with injected clock/entry-gate suppliers and the final boundary check (permission → owner → clock last)                                                                                 |
| `packages/execution/src/mt5-offline/fake-terminal.ts`                     | Scriptable fake (abstract statuses, throws, lost replies, raw replies, boundary callback)                                                                                                      |
| `packages/db/migrations/0016_mt5_offline_bridge_journal.sql`              | `bridge_owner`, `bridge_command`, transition-guard trigger (additive; byte-identical since first published `19bbf93a`)                                                                         |
| `packages/db/src/repositories/bridge-journal.ts`                          | PostgreSQL implementation of the port                                                                                                                                                          |
| `packages/execution/test/mt5-contract.test.ts`                            | 29 pure contract tests                                                                                                                                                                         |
| `packages/db/test/bridge-journal.test.ts`, `test/support/bridge-child.ts` | 53 PostgreSQL conformance tests incl. real-subprocess crash/concurrency                                                                                                                        |
| `packages/db/test/upgrade-0015.test.ts`                                   | One Stage 1 assertion generalised to "0015 and any later migrations" (pinned 0010–0015 hashes unchanged)                                                                                       |

## 2. Durability mechanism

PostgreSQL (the repository's test infrastructure; no SQLite; no in-memory store is offered as durable).
Every journal call resolves only after its transaction COMMITS.

- **Atomic unique intent:** `PRIMARY KEY (account_ref, command_id)` + `INSERT … ON CONFLICT DO NOTHING`; the
  stored `payload_hash` decides REPLAY (same payload) vs CONFLICT. Intents of one account are serialised by
  `SELECT … FOR UPDATE` on the account's owner row.
- **Irreversible marker:** `INTENT → SEND_MAY_HAVE_STARTED` is a compare-and-swap committed BEFORE the fake
  transport is called; for ENTRY commands the atomic step also checks current reconcile state and expiry at the
  caller's fresh instant. A trigger forbids returning to `INTENT`, deleting rows, or changing identity/payload.
  A failed persist means the transport is not invoked.
- **Detached input:** `parseCommand` copies own properties once into a frozen snapshot; the persisted/hashed/sent
  command is that snapshot, so later caller mutation cannot diverge it.
- **Fence inside the write:** the owner row is locked and `(accountRef, ownerId, epoch)` compared inside each
  write; the same owner id/epoch number never authorises another account. A later claimant is `BUSY` however
  old the owner row is; a takeover is an explicit call that bumps the epoch and sets `reconcile_required`.
- **Reservations untouched:** the journal never writes `exposure_reservations`, quarantine or PAPER tables.

## 3. Interleavings and failures actually tested (against the FAKE; PostgreSQL is real)

Each item is a **specific tested interleaving**, not a general exclusion proof.

- Validation before any write: malformed fields, NaN/"NaN"/Infinity/exponent lots, unknown operation/field,
  non-canonical or oversized account/ulong/command ids, inherited keys, impossible Gregorian dates
  (Feb 30, non-leap Feb 29, Apr 31, month 13, hour 24, minute/second 60); ulong ids above 2^53 round-trip as strings.
- Idempotency: 20 concurrent same-id intents create one row; same id + different payload is refused and never
  invoked; same id + same payload (even retimed) replays; 20 concurrent marker attempts have exactly one winner.
- Caller mutation of the raw command during the `begin` await changes neither the sent payload nor the hash.
- Marker visible on another connection before the fake is invoked; failed marker persist ⇒ no invocation.
- Thrown / lost-reply / malformed / extra-key / wrong-operation replies ⇒ `UNKNOWN`, replayed as `UNKNOWN`,
  never resent; a failed result write is reported `UNKNOWN` (first call and replay), never `RESOLVED`; a
  `RESOLVED` row with no stored result replays as `UNKNOWN`.
- Real child processes (own DB connections): SIGKILL after the intent leaves a safe `INTENT` the next owner
  sends once; SIGKILL after the marker leaves `SEND_MAY_HAVE_STARTED` and the next owner never resends; three
  concurrent processes invoke their fakes once in total; a stale-fence process is refused by the database.
- Ownership: BUSY regardless of row age; takeover without a recorded evidence note is refused; a stale fence is
  refused at begin, marker and result writes; another account's fence is refused even with an identical owner id
  and epoch number.
- Entry gates: invalid (NaN) clock, `entryPermitted` undefined/truthy-not-true/throwing, issuedAt in the future,
  expiry, reconcile-required ⇒ ENTRY refused and not sent; protective close/cancel are not blocked by entry
  permission or entry expiry; a pending protective INTENT survives reconcile-required and a restart and is
  drained afterwards.
- Final fake boundary (permission awaited first → owner/fence/reconcile read → clock read last, synchronously):
  with a permission supplier pending at the boundary, (a) the clock passing expiry, (b) a database takeover and
  (c) reconcile flipping to required each lead to zero fake effects; a protective close does not consult entry
  permission and is refused at the boundary if reconcile flips just before the final owner read (recorded
  `UNKNOWN`, never resent); with permission denied a protective close with current ownership still runs. These
  four boundary regressions failed against the previous ordering.
- Close results: a partial close is never `CLOSED` (quantities preserved across reopen); `CLOSED` requires a
  reply proving zero remaining; an unproven remainder is `UNKNOWN`; `NOT_FOUND` for a close is unsupported in the
  model (`UNKNOWN`); incoherent quantities against the request are not outcomes.
- Mutation checks (not committed): dropping the marker compare-and-swap, the boundary callback, or the
  account-bound fence check each made tests fail.

## 4. Test evidence

| Item                            | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rejected heads                  | `19bbf93a` (CEO safety review: raw aliasing, stale clock/gate, swallowed persist failure, loose replies, fence-by-epoch-only; full run also exposed the `upgrade-0015` assertion), `be2cb5b3` (CEO review: await staleness at the boundary) — both superseded, not accepted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `19bbf93a` full run             | 102 files passed, 1 failed (`upgrade-0015` expected only `0015`, now `0015`+`0016`); fixed in `1246eed3` (CI 37263735774 success)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `be2cb5b3`                      | local: install 0, `pnpm check` 0, API build 0 (103 files / 1103 tests); CI 37264321350 success                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Final tested code head**      | `d84459056f315e59a803348094014bb64b6aaa07`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Local (final head) — **FAILED** | install 0, API build 0; **`pnpm check` exit 1: 102 files passed / 1 failed; 1107 tests passed / 1 failed (of 1108) — recorded as FAILED, never relabelled green.** Failing test: `apps/api/test/paper-recovery.test.ts:299` (R004, unchanged), expected an outage-reason regex but received `quote STALE … age 5400ms exceeds limit 5000ms` before the intended outage path. **Targeted diagnostic (that one unchanged file, run once, no source/test change, no skips): exit 0, 14/14 passed in 16.18s.** Timing cause is an **inference, not proven**: the fixture's `ticking` helper advances a manual clock by 300ms every 5ms of real time, so the manual-clock quote age depends on how many real timer ticks fire before the outage path runs; under full-suite load the age may have passed the 5000ms limit first, while in isolation it did not. The fixture is pre-existing, is not weakened or skipped here, and should be hardened as a separate task |
| CI (final head)                 | CEO-verified: run 37264810187 / job 111619242401 SUCCESS at exact checkout `d8445905`, PostgreSQL 16.15, 103 files / 1108 tests (29 contract + 53 journal), 0 skips; frozen install, format, lint, typecheck, test and API + dashboard builds successful                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## 5. Scope limits (not claimed)

- **No atomic DB-to-effect exclusion.** The boundary regressions are controlled interleavings of the fake;
  even the fake's callback verdict and effect scheduling is not a distributed lock. A real terminal's race
  between the verdict and the broker applying the order is not addressed, and no blanket "check-to-effect gap
  closed" claim is made.
- `oldWriterCannotAct` in a takeover is **caller-supplied model evidence** recorded in a note, not verified proof
  that the old writer is gone; real terminal-boundary fencing is unresolved.
- **`UNKNOWN` has no read-only reconciliation implementation:** it is preserved and never resent, but nothing
  here resolves it against broker state.
- Protective **drain covers persisted `INTENT` records only**; there is no general durable protective-action
  queue, and S002/R004 remain PAPER-only.
- **No ADR-0027 reservation integration** (the journal does not touch reservations or quarantine) and no real
  route: no `BrokerAdapter`, no runtime registration, no SDK, no connection, no credentials, no LIVE.
- The fake's statuses are an abstract test model, not MT5 return codes; retcode classification, `comment`
  behaviour, OS support and firm acceptance remain unresolved gates. Exact FundingPips program and actual margin
  mode remain future activation/profile gates.
