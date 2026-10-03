# R001 — research validation correctness and honest readiness

Branch `claude/research-r001-validation` (base `c54df2d`). No strategy was run, tuned or selected; no
parameter search; archived LSFVG results (`RESULTS-2026-09-29.md`, trade CSVs) are untouched.

## Defects fixed (`packages/research/src/validation.ts`, `metrics.ts`, `report.ts`)

| #   | Defect                                                                                             | Effect on evidence                                                   | Fix                                                                                       |
| --- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | `walkForward` with `windowMonths` ≤ 0 never advanced                                               | endless loop                                                         | refused (positive whole number only)                                                      |
| 2   | Invalid `from`/`to`/`cut` gave NaN comparisons                                                     | silently empty windows or an empty split that looks like "no trades" | refused with an error                                                                     |
| 3   | The last walk-forward window counted every trade closed after `to` while its label was cut at `to` | trades outside the declared period inflated a window                 | window is `[lo, min(hi, to))`                                                             |
| 4   | Window starts were chained (`start = next`), so a 31st start day drifted (31 Jan → 3 Mar → 3 Apr)  | windows overlapped or skipped days, not the labelled periods         | each window anchored to `from`, day clamped to month length                               |
| 5   | A trade with an unreadable `closedAt` made the sort, and so every drawdown, meaningless            | wrong drawdown, silently                                             | `metrics`, `split`, `walkForward` refuse it                                               |
| 6   | Monte Carlo accepted `runs` 0 or non-finite R                                                      | NaN probabilities / poisoned percentiles                             | refused                                                                                   |
| 7   | Report called the held-out slice "untouched"                                                       | the 2017–2019 slice sits inside the already-examined dataset         | labelled "held out by date"; report says it is a later slice of the same dataset          |
| 8   | Split assigns by close time, so trades opened before the cut count as out-of-sample                | in-sample decisions leak into the held-out sample                    | definition kept (frozen); the count is now `split.straddling`, printed in the report      |
| 9   | Walk-forward stability line counted only windows with trades                                       | a strategy trading rarely looked stable                              | report also states windows with no trades and windows below 30 trades                     |
| 10  | Monte Carlo assumptions unstated                                                                   | bootstrap reads as a forecast                                        | documented: independent trades, no clustering or regime change, zero-risk trades excluded |

Regression tests: `packages/research/test/metrics.test.ts` (3 added). They use synthetic fixture
trades only — they test arithmetic, and say nothing about any strategy.

## Known limitations (not fixed here, still visible)

- `metrics` counts a zero-risk trade (`r = null`) as a trade with 0 R; Monte Carlo leaves it out.
- Bootstrap Monte Carlo cannot show an edge the sample did not contain.
- The 2010–2019 FX dataset has been examined and its result is archived; it cannot be reused as
  untouched evidence for any rule chosen after seeing it. Costs use a template commission
  (UNVERIFIED); the news calendar was NOT MODELLED in those runs; spread was partly assumed.

## US30: next blocker

Nothing in the research kit supports US30 yet: no `config/instruments/US30.yaml` (point value,
tick, contract/CFD terms, session and costs all unverified), no US30 history, no plausibility range
in `scripts/research.ts`, and the only tested strategy (LSFVG) was built and tested on FX pairs.
FX results say nothing about an index. The blocker is **credible modern US30 data** (bid/ask or
spread, 1-minute, covering 2020–2026, with its source and licence recorded) plus the owner's
verified broker/CFD terms. Hold-out periods must be fixed before any candidate is looked at.

## Route to a trading product (each stage must pass before the next)

1. Credible modern data: US30 (and any other instrument) with provenance, gaps and costs recorded.
2. Pre-registered candidates: rules, parameters, split dates and pass criteria committed first.
3. Unseen-period tests with real costs, then stress (wider spreads, slippage, news days).
4. Prop-rule replay on the owner's verified firm profile.
5. Paper / shadow verification on live quotes (required validation, not optional).
6. Owner-authorized, limited live (ADR-0008's six factors). This task enables none of it.
