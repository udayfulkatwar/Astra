# ADR-0004: Decimal arithmetic for risk-critical math

**Status:** Accepted · **Date:** 2026-09-27

## Context

Binary floating point produces results like `0.1 + 0.2 = 0.30000000000000004`. In position sizing,
`floor(1.0000000001)` vs `floor(0.9999999999)` can decide between 1 and 0 contracts, and limit
comparisons at the cent boundary can flip.

## Decision

Risk, sizing, drawdown and daily-loss computations use `decimal.js` (precision 40, ROUND_HALF_EVEN
for display; explicit ROUND_DOWN for quantities; conservative rounding direction for limits).
Public types keep `number` for JSON friendliness; conversion happens at package boundaries.
All inputs are validated as finite numbers.

## Consequences

- - Deterministic, exact cent-level math; quantity flooring can never round up.
- − Slight verbosity and CPU cost (negligible at ASTRA's decision rates).
