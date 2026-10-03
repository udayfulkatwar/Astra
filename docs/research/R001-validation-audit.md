# R001 — research validation correctness and honest readiness

Branch `claude/research-r001-validation` (base `c54df2d`). No strategy was run, tuned or selected; no
parameter search; archived LSFVG results (`RESULTS-2026-09-29.md`, trade CSVs) are untouched.

## Defects fixed (`packages/research/src/validation.ts`, `metrics.ts`, `report.ts`)

| #   | Defect                                                                                             | Effect on evidence                                                                                                                                | Fix                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `walkForward` with `windowMonths` ≤ 0 never advanced                                               | endless loop                                                                                                                                      | refused (positive whole number only)                                                                                                                                                     |
| 2   | Invalid `from`/`to`/`cut` gave NaN comparisons                                                     | silently empty windows or an empty split that looks like "no trades"                                                                              | refused with an error                                                                                                                                                                    |
| 3   | The last walk-forward window counted every trade closed after `to` while its label was cut at `to` | trades outside the declared period inflated a window                                                                                              | window is `[lo, min(hi, to))`                                                                                                                                                            |
| 4   | Window starts were chained (`start = next`), so a 31st start day drifted (31 Jan → 3 Mar → 3 Apr)  | the windows were still consecutive, but their boundaries were not the intended month boundaries and the labels did not match the intended periods | each window anchored to `from`, day clamped to month length                                                                                                                              |
| 5   | A trade with an unreadable `closedAt` made the sort, and so every drawdown, meaningless            | wrong drawdown, silently                                                                                                                          | `metrics`, `split`, `walkForward` refuse it                                                                                                                                              |
| 6   | Monte Carlo accepted `runs` 0 or non-finite R                                                      | NaN probabilities / poisoned percentiles                                                                                                          | refused                                                                                                                                                                                  |
| 7   | Report called the held-out slice "untouched"                                                       | the 2017–2019 slice sits inside the already-examined dataset                                                                                      | labelled "held out by date"; report says it is a later slice of the same dataset                                                                                                         |
| 8   | Split assigns by close time, so trades opened before the cut count as out-of-sample                | in-sample decisions leak into the held-out sample                                                                                                 | definition kept (frozen); the count is now `split.straddling`, printed in the report; an unreadable `openedAt`, or one after `closedAt`, is refused so the count is never silently wrong |
| 9   | Walk-forward stability line counted only windows with trades                                       | a strategy trading rarely looked stable                                                                                                           | report also states windows with no trades and windows below 30 trades                                                                                                                    |
| 10  | Monte Carlo assumptions unstated                                                                   | bootstrap reads as a forecast                                                                                                                     | documented: independent trades, no clustering or regime change, zero-risk trades excluded                                                                                                |

Regression tests: `packages/research/test/metrics.test.ts` (3 added). They use synthetic fixture
trades only — they test arithmetic, and say nothing about any strategy.

## Known limitations (not fixed here, still visible)

- `metrics` counts a zero-risk trade (`r = null`) as a trade with 0 R; Monte Carlo leaves it out.
- Bootstrap Monte Carlo cannot show an edge the sample did not contain.
- The 2010–2019 FX dataset has been examined and its result is archived; it cannot be reused as
  untouched evidence for any rule chosen after seeing it. Costs use a template commission
  (UNVERIFIED); the news calendar was NOT MODELLED in those runs; spread was partly assumed.

## Next target: instrument selection (no instrument is selected)

The founder removed the US30-only constraint. Nothing in the research kit supports an index yet
(no US30 instrument spec, history or plausibility range), and the only tested strategy (LSFVG)
was built on FX pairs, so FX results say nothing about any other asset class. The next step is to
**compare the instruments the target prop firms support**, on three verifiable grounds:

- **Data:** credible modern history with recorded source, licence, gaps and bid/ask or spread.
- **Costs:** spread, commission, slippage and swap terms taken from the firm's or broker's own
  published terms, not assumed.
- **Compatibility:** the firm's rules and instrument list, contract specifications and sessions.

No instrument is a prerequisite and none is chosen. The existing FX losses stay archived, and
no dataset already examined becomes untouched: hold-out periods must be fixed before a candidate
is looked at, on data not used to choose it. Planning targets (founder context, not verified account or platform configurations): Lucid Flex 25K and FundingPips 10K 2-Step Flex. Their current rules, instrument lists and costs must still be entered and verified from the firms' own terms. Instrument and strategy selection remain open.

## Route to a trading product (each stage must pass before the next)

1. Credible modern data for the shortlisted instruments, with provenance, gaps and costs recorded.
2. Pre-registered candidates: rules, parameters, split dates and pass criteria committed first.
3. Unseen-period tests with real costs, then stress (wider spreads, slippage, news days).
4. Prop-rule replay on the owner's verified firm profile.
5. Paper / shadow verification on live quotes (required validation, not optional).
6. Owner-authorized, limited live (ADR-0008's six factors). This task enables none of it.
