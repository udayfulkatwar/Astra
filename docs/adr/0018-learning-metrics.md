# ADR-0018: Learning metrics — descriptive, sample-size honest, never self-applying

**Status:** Accepted · **Date:** 2026-09-28

## Context

Spec §32 asks ASTRA to learn from its trade history — win rate, profit factor, expectancy,
average R, drawdown, and performance by session, instrument, setup, news day, event, time of day,
direction and strategy, consecutive losses, slippage and execution quality — and to identify
patterns, while **never changing live risk parameters on its own**. Small samples produce
convincing-looking patterns that are noise; that is the main failure mode to design against.

## Decision

- **Pure `@astra/learning`** (isomorphic): `learningReport(entries, { timeZone, sessions,
minSample })` over journal entries (paper/live journal or a backtest run's trades).
- **Per-trade context is recorded with the journal entry** (`TradeContext` in `@astra/journal`):
  the strategy's setup label (`signal.features.setup`), timeframe, and whether a HIGH- (or
  unknown-) impact event for the instrument fell on the entry's trading day or while the
  position was open. Event facts come only from a calendar window that covers the period (first
  the one the decision saw, then the current one; in backtests the modelled schedule); otherwise
  `UNKNOWN` — never "no event". The calendar's source kind is kept, so results based on the
  SIMULATED calendar say so. Entries recorded earlier have no context and show as unknown.
- **Report:** overall (expectancy with a 95 % t-interval, win rate, profit factor, total R,
  Sharpe-like mean R ÷ SD R per trade, max drawdown in R and closed-trade money, losing-streak
  distribution), a cumulative-R curve, eleven dimensions (strategy, instrument, direction,
  session at entry, hour and weekday in a chosen time zone, setup, event day, held through an
  event, exit reason, mode) each with n, win rate, average R and its 95 % range, total R, profit
  factor; execution quality (entry and stop slippage, plan adherence, protective exits, MFE /
  MAE, winners' capture, losers that were +1 R first).
- **Sample-size honesty:** groups with fewer than `minSample` (default 30) R-trades are marked
  small. An _observation_ is raised only when a group and the rest of its dimension both have
  `minSample` trades and Welch's |t| ≥ 2 (MODERATE) or ≥ 3 (STRONG); the number of comparisons
  is reported with a multiple-comparisons caution. Mixed modes and simulated context are noted.
- **Never self-applying:** the report has no write path to configuration; every page and
  response says observations only — changes go through configuration review (ADR-0006).
- **API / UI:** `GET /api/v1/learning?source=journal|backtest&runId&accountId&strategyId&symbol&mode&timeZone&minSample`;
  dashboard **Learning Metrics** page (source, mode, time-zone filters; tiles; cumulative-R
  chart with a table view; observations and notes; per-dimension tables with average-R bars and
  95 % ranges; execution quality); also in the demo.

## Consequences

- - The owner sees what is working with the uncertainty attached, and weak evidence is labelled
    as such instead of being presented as a pattern.
- − Until real trades accumulate (≥ 30 per group) most groups will be "small sample"; that is
  the correct answer, not a defect.
- − Event facts depend on calendar coverage; with only the SIMULATED schedule they are
  placeholders. AI post-trade review (spec §31) is a later phase.
