# ADR-0008: Multi-factor live-trading authorization

**Status:** Accepted · **Date:** 2026-09-27

## Context

Real-money execution must require explicit human authorization and must not activate just
because the implementation is complete (§16, §40).

## Decision

An order may reach a LIVE broker adapter only when **all** of the following hold:

1. Server environment `ASTRA_LIVE_TRADING_AUTHORIZED=true` (set by the owner on the host).
2. Global mode is `LIVE` (changed only by an operator; the mode change is audited).
3. The account config has `liveTradingAuthorized: true`.
4. The account's prop-firm profile and the instrument spec are `USER_VERIFIED`.
5. A LIVE-kind broker adapter is registered for the account.
6. Every gate check passed and no kill switch applies.

The system never boots into LIVE: after any restart the persisted mode is honoured only if (1)
still holds; otherwise it falls back to `HALTED`.

## Consequences

- - No single mistake (a config typo, a leaked automation token, an API call) can start live trading.
- − Slightly more ceremony for the owner when going live — intended.
