# ADR-0010: Market structure — deterministic definitions over complete bars

**Status:** Accepted · **Date:** 2026-09-27

## Context

Phase 5 strategies will reason about market structure: swings, breaks of structure (BOS),
changes of character (CHoCH), liquidity (equal highs/lows, sweeps) and fair value gaps (FVG).
These terms have no single industry definition, and loose implementations repaint — they revise
the past once later bars arrive — which makes backtests look better than live trading. The
owner's strategy rules are not known yet, so the definitions must be generic, documented and
adjustable, and must never be mistaken for trading rules.

## Decision

- **New pure package `@astra/market-structure`** (depends on `@astra/core` and
  `@astra/market-data` for `Bar`; isomorphic, lint-enforced). One function,
  `analyzeStructure({ bars, tickSize, symbol?, timeframe?, params? })`, does a single forward
  pass over **complete** bars of one symbol and timeframe (in-progress bars are ignored; mixed or
  overlapping series are refused).
- **No lookahead, by construction and by test.** Every item carries the time it became known:
  swings their `confirmedAt` (close of the bar `swingStrength` bars later), breaks, sweeps and
  gaps the close time of the bar that produced them. A property test (400 random walks, random
  cut points, strengths 1–3) asserts that analysing a prefix reports exactly the full analysis's
  events up to that prefix — so a backtest sees what live trading would have seen.
- **Definitions:**
  - _Swing high_: high above the `swingStrength` bars before it and not below those after it
    (first of equal highs wins). Lows mirror it. Labels vs the previous swing of the same kind:
    HH/LH/EQH, HL/LL/EQL, "equal" meaning within the equal-level tolerance at confirmation time.
  - _Break_: a bar **closes** beyond the latest confirmed, not yet broken swing. Against the
    prevailing trend it is a CHoCH, otherwise a BOS; the first break sets the trend (before it
    the trend is UNKNOWN — never guessed).
  - _Liquidity_: each confirmed swing level stays INTACT until price trades beyond it; a bar that
    trades beyond and closes back inside SWEEPS it, a close beyond BREAKS it. Intact swing highs
    (lows) within the tolerance form buy-side (sell-side) pools; the nearest intact level above
    and below the last close is reported.
  - _Fair value gap_: three bars where the third's low is above the first's high (bullish) or its
    high below the first's low (bearish) by at least `fvgMinTicks`; later bars mitigate it
    (PARTIAL) until FILLED. Only unfilled gaps are returned.
- **Parameters** (`structure` block in `config/astra.yaml`, validated by
  `StructureParamsSchema`, all DEFAULTS): `swingStrength` 2, `equalLevelTicks` 2 widened to
  `equalLevelAtrFraction` 0.1 × ATR(14) (computed incrementally, so the tolerance also has no
  lookahead), `fvgMinTicks` 1, `maxItems` 20.
- **Role:** structure is SIGNAL-layer input for the Phase 5 strategy engine and the operator. It
  adds no gate check and cannot approve anything. Served by `GET /api/v1/market/structure`
  (default H1) and drawn on the dashboard's Market Scanner.

## Consequences

- - Deterministic, explainable structure that is identical in backtest, paper and live, and in
    the browser demo.
- - Definitions are data (config) and documented here, so the owner can align them with the
    strategy without code changes.
- − Quote-built bars (ADR-0009) inherit their limits: bad ticks and partial observation shape the
  swings. A provider's own bars (backfill) will improve fidelity.
- − Close-based breaks lag wick-based variants by design (fewer false breaks, later signals).
- − Order blocks, displacement and premium/discount zones are not modelled yet; they will be added
  with the owner's strategy, under the same no-lookahead test.
