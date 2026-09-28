# ADR-0017: The losing-streak limit counts within one trading day

**Status:** Accepted (owner decision) · **Date:** 2026-09-28

## Context

The risk policy's `activity.maxConsecutiveLosses` blocked new trades once the account had that
many losing trades in a row. The streak was counted over all history, and only a winning trade
reset it — but with new trades blocked no win could happen, so the block was permanent with no
reset path (known issue 21; visible in every backtest).

## Decision

The owner chose: **stop for the rest of the trading day**. The streak counts only trades closed
within the current trading-day window (the prop-firm profile's `tradingDayReset`); at the next
reset it starts at zero. The same rule is applied by the core (`AccountRepository.activity`),
the in-browser demo and the backtest replay.

## Consequences

- - The limit behaves like a daily cool-down: a bad day ends early; the next day starts clean.
- − A losing streak that spans the reset is not carried over; the daily loss limit, drawdown
  buffers and account health still apply across days.
