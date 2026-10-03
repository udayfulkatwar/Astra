# F001 — Operator-flow regression tests (frontend)

_Frontend team · 2026-10-03 · branch `claude/frontend-f001-operator-tests`_

The dashboard now has rendered UI tests for its highest-risk operator flows. The audit of
2026-10-03 found 7 helper tests and no page tests; there are now 43 dashboard tests (36 new).
The new tests found three real UI defects, now fixed (below).

## How the tests work

- **Stack:** the existing Vitest, plus dev-only React Testing Library, user-event and jsdom 28.
  jsdom 28 is used rather than 30 because 30 requires Node ≥ 22.22.2, while the repository
  allows Node ≥ 22.12 under `engine-strict`. No production dependency changed.
- **Config:** `apps/dashboard/vitest.config.ts` runs `src/**/*.test.{ts,tsx}` in jsdom, with
  cleanup in `src/test/setup.ts`.
- **API stand-in:** `src/test/api.ts` replaces `fetch` with a deterministic route table and
  records each request (method, path, body, `Authorization`). Unlisted routes answer 404 in the
  API's error envelope. It never uses the network, real credentials, a broker or an order.
- **Fixtures:** `src/test/fixtures.ts` follows the API's response shapes. The calendar test builds
  its event-risk view with the server's own `eventRiskView()`.
- **What is checked:** what the operator sees and what is sent. Tests click and type like a
  person. They assert on visible text, button states and the recorded requests, never on
  snapshots or component internals.

## Coverage

| Flow                                         | File                                            | What is checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login and session                            | `src/App.test.tsx`                              | No token → login screen, no data read. An accepted token is stored for the tab and sent as `Bearer` on every request. A rejected token (401) keeps the operator out and stores nothing. An unreachable API is reported as such. Menu navigation works. A 401 during a session (expired or revoked token) signs the operator out.                                                                                                                                                                                                                                     |
| Trade Approval Center                        | `src/pages/Approvals.test.tsx`                  | A REJECTED decision has no Execute button. An approval that is expired (by ASTRA's clock), `EXPIRED` or `CONSUMED` cannot be executed. A PENDING approval needs a confirmation, then sends exactly one `POST /api/v1/executions` with `{ approvalId }`. The request shows as in flight and the button stays disabled. CONFIRMED, REJECTED and UNKNOWN outcomes are shown as they are. HTTP failures, including 403, are shown as failed execution requests. Cancel sends nothing. The list shows status and first reason.                                            |
| Risk Controls                                | `src/pages/RiskControls.test.tsx`               | The emergency stop needs a confirmation, then sends `{ scope: GLOBAL, target: null, reason }` once. Cancel sends nothing; a reason under 3 characters blocks it. The activate form sends scope, target and reason (GLOBAL sends no target). Clearing needs a written reason and sends the switch's scope and target. Failures are reported, and the list shows only what the server reports. "Not loaded" shows everything as blocked. LIVE mode needs a second confirmation; a refused mode change is reported and the current mode stays as the server reports it. |
| System Health, Economic Calendar, status bar | `Operations`, `Intelligence`, `StatusBar` tests | An UNKNOWN or DEGRADED component keeps its own status: never ONLINE, "never" online, and BLOCKING when it blocks trading. A stale calendar makes instruments UNKNOWN (never CLEAR) and says trades are refused. Read failures say so. The status bar shows CONNECTING, API UNREACHABLE, STALE/UNKNOWN and DISABLED rather than a healthy or tradable state.                                                                                                                                                                                                          |

## Defects found and fixed (frontend only, each kept as a regression test)

1. **Action failures were labelled "Could not load data".** A failed execution, kill-switch
   request or mode change read as a failed page load.
   - Fix: `ErrorBox` takes an optional `title`. The actions now say "Execution request failed",
     "Kill-switch request failed" or "Mode change failed". Read failures keep the old wording.
2. **No visible in-flight state for an execution.** The button was disabled, but nothing said a
   request was being sent.
   - Fix: "Sending to the execution gateway…" is shown while the request is open.
3. **The activate and clear forms reset even when the request failed.** The kill-switch activate
   form cleared its reason, and the clear form closed and lost its reason. A reset reads as
   success.
   - Fix: both reset only after the server accepts the request; on failure the reason is kept.
     A test run with the old behaviour fails 2 tests.

Risk calculations, authorization rules and API calls are unchanged. The endpoints and payloads
are the existing ones.

## Validation

- Dashboard: `pnpm --filter @astra/dashboard test` passes 43 of 43 tests. Lint, typecheck and
  format are clean.
- Builds: the production build and the demo build pass.
- Repository CI-equivalent run (local PostgreSQL 16, `TEST_DATABASE_URL` set, so the database
  tests are mandatory, as in CI): `pnpm install --frozen-lockfile`, `pnpm format:check`,
  `pnpm lint`, `pnpm typecheck`, `pnpm test` (79 files, 695 of 695 tests, none skipped) and
  `pnpm build` all pass.

## Not covered yet

- The Live Activity event stream: the flows above do not use it.
- Other pages: Charts, Backtesting, Learning and the rest.
- Real-browser end-to-end runs: these are jsdom component tests, not Playwright.
