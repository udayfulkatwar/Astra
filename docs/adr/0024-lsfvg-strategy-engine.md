# ADR-0024: The owner's LSFVG v1.0 strategy as code, run by ASTRA through the gate

**Status:** Accepted · **Date:** 2026-09-28

## Context

The owner sent the Liquidity Structure FVG strategy v1.0 (EUR/USD, GBP/USD, USD/JPY; H1 bias,
M15 setup, M5 execution) and asked ASTRA to build it with the defaults it proposed for the
ambiguous points. The rules must be exact, deterministic, free of lookahead, and unable to
bypass the safety core. The owner's risk rules (per-pair and daily trade caps, daily loss stop,
losing-streak stop, correlated USD exposure) must hold whoever submits a signal.

## Decision

- **`@astra/strategy-lsfvg`** (pure, isomorphic) implements the SPEC's definitions.
  - **Inputs:** closed M5 candles only. M15 and H1 are aggregated from them, and a period is
    never emitted before it closes.
  - **Indicators and swings:** strict 5-candle fractals, confirmed after two right candles.
    ATR(14) uses Wilder smoothing.
  - **Liquidity:** the previous FX day's high/low (the day ends 17:00 New York), the Asian range
    (00:00–06:00 UTC), unswept M15 swings, and equal highs/lows (≤ 0.10 × M15 ATR, ≥ 2 swings).
  - **Sequence:** sweep → close back inside (same candle or the next 2) → displacement (body ≥
    0.60 × range and ≥ 0.80 × M15 ATR) that CLOSES through the last M15 swing confirmed before
    the sweep (CHoCH if that swing was a lower high / higher low, else BOS), within 6 candles →
    FVG around the displacement.
  - **Entry:** a LIMIT at the FVG midpoint, waiting 12 M5 candles. It is cancelled if an M5
    candle closes beyond the sweep extreme first.
  - **Stop:** sweep extreme ∓ 0.10 × M5 ATR, rounded away from the entry.
  - **Targets:** Model A = 2R. Model B = the nearest opposing liquidity giving ≥ 2R, else no
    trade (`NEAREST_ONLY` is the stricter reading, kept for sensitivity analysis).
  - **H1 bias:** from the last two swings, and NEUTRAL when the structure has broken since
    (a later swing or an H1 close through the higher low / lower high).
  - **Output:** every complete sequence — traded or not — produces the SPEC §26 decision
    record. The score is reported for information: every complete setup already scores
    ≥ 14/18.
- **Owner risk rules are gate code** (`strategy.limits`, mandatory, driven by
  `StrategyDefinition.limits`):
  - entries per symbol per day (working orders count);
  - a daily realized-loss stop, measured on the balance against the day-start balance;
  - consecutive full-risk losses (≤ −0.9R net, from the journal; an unjournaled close is
    unknown, which blocks);
  - correlated groups: positions plus working orders, and their open risk together with the
    new trade's.

  The per-trade 0.25 %, the 4 trades a day and the 2R minimum use the existing strategy and
  policy fields. The `lsfvg-fx` risk policy carries the owner's exposure caps.

- **Runner** (`StrategyRunner` in the API; the same logic in the browser demo):
  - One engine per ACTIVE strategy whose `rules.engine` is `lsfvg-v1`, per instrument.
  - Engines are warmed up from the candles already held; history is never traded.
  - Each SETUP goes to every ACTIVE account running the strategy as a LIMIT signal through the
    full gate.
  - Approvals execute only when `strategyRunner.autoExecute` is on and the mode is in
    `autoExecuteModes`, which is never LIVE.
  - INVALIDATED cancels the resting order.
  - Setups completing on the same candle are evaluated in the strategy's instrument order
    (EURUSD, GBPUSD, USDJPY): the deterministic priority when the correlation cap allows only one.
- **Configuration:** `lsfvg-a` (Model A) runs on `paper-fx` and `lsfvg-b` (Model B) on
  `paper-fx-b`, so the two models are measured separately.
  - The strategies are `ownership: USER` (the owner's rules).
  - Their risk policy stays TEMPLATE (ASTRA's buffers). The FX instruments stay UNVERIFIED and
    the prop-firm profile is a TEMPLATE, so LIVE refuses them.

## Consequences

- The strategy trades in PAPER on whatever feed ASTRA has (SIMULATED today). It has NOT been
  validated on real history: that is the research backtest's job (S4). No profitability is
  claimed.
- Interpretations beyond the owner's document are marked DEFAULT in `params.ts` and listed in
  PROJECT_STATE for the owner to confirm:
  - the displacement window (6 M15 candles);
  - the bias "structure broken" guard;
  - Model B's target reading;
  - the choice of primary level when one sweep takes several levels (strongest type, then
    deepest).
- Changing a rule is a code or config change with its own version. Research may vary
  parameters only as sensitivity analysis, never to pick winners after seeing outcomes.
