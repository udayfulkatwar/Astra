# ADR-0023: LIMIT entries — resting orders that stay inside the gate's guarantees

**Status:** Accepted · **Date:** 2026-09-28

## Context

The owner's strategy (LSFVG v1.0) enters at the 50 % midpoint of a fair value gap and never
chases: the order waits for price to come back, and a missed setup is no trade. So ASTRA needs
LIMIT entries. A resting order is different from a market order: the broker can fill it later
without asking ASTRA again. Everything the gate approved must therefore stay true for as long
as the order can fill.

## Decision

- **Signal:** `entryType: LIMIT` with a required `expiresAt`. The limit is the signal's `entry`.
- **Gate (`market.entry`, `market.session`, calendar, firm rules):**
  - The expiry is required, in the future, and at most `decision.maxWorkingOrderMinutes`
    (240) away.
  - The limit must be on the tick grid and between the stop and the target.
  - The market must not already be beyond the stop or the target (a missed setup is not chased).
  - The order must be gone before the no-new-trades window of the market close.
  - The event blackout, the firm's news restriction and its flat-by / weekend rules cover the
    whole window from now to the expiry, not just now.
  - Size is computed from the limit: a fill is at the limit or better.
- **Exposure:**
  - The account snapshot lists `workingOrders`. Open risk, position counts, per-instrument
    limits, hedging, firm quantity caps and the trailing-drawdown path count each one as if
    filled at its limit.
  - Pending orders reported without details make open risk UNKNOWN, which means no new trades.
- **Execution:**
  - The gateway sends the limit and the expiry. A resting order that the broker accepted
    (`ACCEPTED`, shown as WORKING) is a confirmed state, not an unknown one; the same holds at
    startup reconciliation.
  - `refresh` records fills, expiries and cancellations.
  - `cancelWorking` is risk-reducing and follows the protective-close rules. It is never sent
    under an EXECUTION kill switch or in SHADOW, and an unknown outcome halts execution.
  - Operators can cancel from the dashboard (`POST /api/v1/orders/:id/cancel`).
- **Supervision (every safety-loop cycle):** a resting order is cancelled as soon as any of
  these holds:
  - the mode or a kill switch forbids new trades;
  - the calendar or the news feed is not fresh;
  - a restricted event now falls inside its blackout window;
  - news risk blocks.
- **Paper broker:**
  - A resting order fills AT its limit when the ask (LONG) or bid (SHORT) reaches it. It
    expires on time and survives a restart.
  - A limit that is already marketable fills at once at the market (never worse than the
    limit).
- **Backtest:**
  - The order is placed at the next open.
  - It fills at the limit only in a bar that trades `limitThroughTicks` (default 1) beyond it
    and closes before the expiry. A touch is not a fill.
  - In its fill bar the position can be stopped but cannot reach its target.
  - An unfilled order is reported as MISSED.

## Consequences

- LIMIT entries are safe to automate in PAPER: exposure is counted before the fill, and
  anything that would have blocked the trade cancels the resting order.
- Backtests are pessimistic about limit fills (queue position is unknown). The research
  backtest can vary `limitThroughTicks` as a sensitivity parameter.
- A LIVE adapter must support resting orders with server-side expiry (or ASTRA's cancel on
  expiry). It must report `workingOrders`; otherwise open risk is UNKNOWN and nothing trades.
