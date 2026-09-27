# ADR-0016: Backtesting — replay through the real gate, pessimistic fills, honest labels

**Status:** Accepted · **Date:** 2026-09-27

## Context

Phase 8 needs a way to replay past prices through ASTRA before a strategy goes near an account.
A backtest that uses different rules from the live core, peeks at the future, or fills orders
optimistically produces numbers that look better than reality — the most dangerous kind of
fabrication. The owner's strategy is not defined yet, and the stored prices so far are SIMULATED.

## Decision

- **Pure `@astra/backtest`** (isomorphic; also runs in the browser demo). `runBacktest` replays
  M1 bars in order through the **same components as the live core**: `assembleDecisionInputs` +
  `DecisionEngine` (all 21 checks), sizing, prop-firm rules incl. the trailing path, account
  tracking, `monitorAccount` + `ProtectionEvaluator`, the kill-switch registry, and
  `buildJournalEntry` / `journalSummary`.
- **Mode BACKTEST inside the simulator only.** `DecisionInputs.environment` is
  `BACKTEST_SIMULATOR` only when set by the replay; `system.mode` passes only for BACKTEST inside
  the simulator and still refuses BACKTEST in the real-time pipeline. Replayed recordings are
  `HISTORICAL`, generated bars `SIMULATED` (both accepted in BACKTEST, refused in SHADOW/LIVE);
  the simulated broker's snapshots are `SIMULATED`.
- **No lookahead, by construction:** at each M1 close only closed bars exist; higher timeframes
  are resampled and emitted only when their period has ended (the period the replay started
  inside is discarded); the strategy sees only those; a property test checks that a replay cut at
  any bar agrees with the full replay up to the cut.
- **Pessimistic fill model** (explicit parameters, reported with every result): orders fill at
  the NEXT bar's open — entries at ask/bid plus adverse slippage; when a bar reaches both stop and
  target the stop is assumed first; stops and protective closes pay slippage and a gapped stop
  fills at the open; targets fill at the target, never better; an approval that expires before
  the next bar (a data gap) is dropped; commission from the instrument spec.
- **Honest output:** every result carries a label ("Engine test on SIMULATED data — not evidence
  of performance" / "Historical replay — past results do not predict future results"), its
  assumptions and warnings (TEMPLATE strategy, unverified profile or instrument, calendar not
  modelled, losing-streak stop, positions left open), the gate's blocking checks with counts, the
  first prop-firm breach, protective actions and a bounded decision log. Equity is marked at each
  M1 close (a downsampled curve keeps each interval's lowest mark).
- **Explicit inputs, no silent defaults:** the calendar treatment (`SIMULATED_SCHEDULE` or
  `NOT_MODELLED`) must be chosen; there is no historical news or AI, so a policy that requires
  news blocks every trade (and says so).
- **Strategy port + one TEMPLATE strategy** (`structure-breakout-template`: enter on a BOS/CHoCH
  of the closed bar, stop at the opposite swing, target N R) purely to exercise the engine. Its
  ownership is TEMPLATE; the replay enables it on a copy of the account, never in configuration.
- **API:** `POST /api/v1/backtests` (operator; STORED bars from `market_bars`, one source, or
  seeded SIMULATED bars; ≤ 184 days, ≤ 260 000 bars), `GET /api/v1/backtests`,
  `GET /api/v1/backtests/:id`. One run at a time; the replay yields to the event loop every 1 000
  bars so the real-time safety loop is never starved. Runs are stored append-only in
  `backtest_runs` (migration 0005). A backtest never touches accounts, orders, kill switches or
  the mode. Dashboard **Backtesting** page (form, runs, equity curve, statistics, gate summary,
  trades, assumptions); also in the demo.

## Consequences

- - A strategy can be judged under exactly the rules that will guard it live; any gate change
    applies to backtests automatically.
- - Deterministic: the same bars and settings give the same result.
- − Intrabar order is unknown from M1 bars; the stop-first assumption understates results when
  both levels were touched. Tick data would be needed to do better.
- − No historical news, AI or real calendar yet; queueing, partial fills and liquidity are not
  modelled.
- − Replays run in the API process (serialised and yielding); very long runs take seconds to
  tens of seconds.
