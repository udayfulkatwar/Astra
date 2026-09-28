# Strategy drafting prompt

A prompt the owner can give another AI model to draft a strategy that ASTRA can implement, test
and check against the prop-firm rules. It reflects the configuration as of 2026-09-28 (gate checks,
instrument specs, template risk policy and prop-firm profiles). Replace the example prop-firm block
with the real firm's rules. The result comes back to ASTRA for review, implementation and testing;
it is the owner's strategy only after the owner accepts it.

```text
You are a quantitative trading-strategy designer. Design ONE intraday strategy for ASTRA, a risk-first trading system for prop-firm accounts. ASTRA's code will implement your specification exactly as written, so it must be complete, deterministic and testable. Read every section before you start, and ask me (the owner) before assuming anything that is my choice.

## 1. Ground rules

- Do not promise or imply profitability. Give no win rates, returns or "edge" figures unless you label them as hypotheses to test. Whether the strategy makes money is decided only by testing: a backtest on real historical data, then paper trading, then shadow trading on live data.
- Every rule must be computable from the data in section 3 at the moment of the signal, using only bars that have already closed. No lookahead and no repainting. If a rule needs data that is not listed, put it under "Data gaps" instead of assuming it exists.
- No discretion. Phrases like "if it looks strong", "use judgement" or "wait for confirmation" are not allowed unless they are an exact, numeric test.
- Every number you choose is a starting default: list it as a named parameter with a default and a sensible test range.
- Keep it simple: at most about 8 entry conditions. Fewer, clearer rules beat many filters, which overfit.
- ASTRA's safety gate (section 4) decides whether a trade is allowed. Do not try to get around it. Design signals that pass it when conditions are genuinely good, and accept that it will block some of them by design.
- ASTRA's AI can only veto a trade; it never approves or sizes one. Do not rely on AI for entries.

## 2. Account, instruments and risk

Instruments ASTRA has configured (recommend which to use; MNQ is the practical one at this account size):

| Symbol | Market | Tick size | Tick value | Costs per round turn | Max spread | Max entry slip |
|---|---|---|---|---|---|---|
| MNQ | Micro E-mini Nasdaq-100 futures (CME) | 0.25 | 0.50 USD | 1.50 USD commission + 2 ticks slippage allowance | 4 ticks | 8 ticks |
| NQ | E-mini Nasdaq-100 futures (CME) | 0.25 | 5.00 USD | 5.00 USD + 2 ticks | 4 ticks | 8 ticks |
| XAUUSD | Gold CFD (100 oz per lot, to be confirmed with the broker) | 0.01 | 1.00 USD per lot | 7.00 USD per lot + 20 ticks | 60 ticks | 50 ticks |

Trading hours: Sunday 18:00 to Friday 17:00 New York time, with a daily break from 17:00 to 18:00 New York.

Prop-firm rules — [OWNER: replace this block with your firm's current published rules. If you leave it, design for this example, which is NOT a real firm:]
- 50,000 USD evaluation account; the trading day resets at 17:00 New York.
- Daily loss limit: 2% of the initial balance (1,000 USD), measured on equity against the day-start balance.
- Maximum drawdown: 5% static (2,500 USD). Alternative example: 2,500 USD trailing on intraday equity, which stops trailing at initial balance + 100 USD.
- Profit target: 6% (3,000 USD), with at least 5 trading days.
- Maximum position: 5 NQ contracts (1 MNQ counts as 0.1 NQ).
- A stop loss is required on every trade. No hedging. No weekend holding (flat by Friday 16:00 New York). Overnight holding is allowed in one example and prohibited in the other (flat by 16:59 New York).
- No trading from 2 minutes before to 2 minutes after high-impact news.
- Consistency (trailing example): no single day may be more than 30% of total profit.

Internal risk policy (the owner's current defaults; the strategy may be stricter, never looser):
- Risk per trade: 0.25% of equity (about 125 USD on 50,000). Minimum reward-to-risk: 1.5.
- Position size = floor(allowed risk ÷ risk per contract), where risk per contract = (stop distance in ticks + slippage allowance in ticks) × tick value + round-turn commission.
- Allowed risk is also capped at 40% of the remaining daily-loss buffer, 20% of the remaining drawdown buffer and 1% of equity in total open risk. It is halved when the account is in CAUTION (40% or more of a limit used), and trading stops at RESTRICTED (70%). Size is never rounded up: a size below 1 contract means no trade.
- Worked example: MNQ with a 10-point (40-tick) stop costs (40 + 2) × 0.50 + 1.50 = 22.50 USD per contract, so 5 contracts. NQ with the same stop costs 215 USD per contract, above 125 USD, so it is rejected. At this risk, NQ stops must be under about 5.5 points.
- At most 2 open positions, 1 per instrument, no pyramiding. At most 3 trades per day. After 2 losses in a row, no more trades for the rest of that trading day.
- No new trades within 15 minutes of a required flat time. ASTRA closes all positions itself 2 minutes before a flat time, or when 90% of a hard limit is used.

## 3. Data the strategy may use

- OHLC bars built from live quotes on M1, M5, M15, M30, H1, H4 and D1. Only closed bars may be used. Volume is present only when the data provider reports it, so do not require volume, or make it an optional filter.
- The current bid and ask (a quote older than 5 seconds counts as missing).
- ATR(14), Wilder's method, on any timeframe.
- Levels: today's open, high and low (the trading day starts 18:00 New York); the previous day's high, low and close; the high and low of each session so far.
- Sessions, usable as filters (Monday to Friday): asia 09:00–15:00 Tokyo; london 08:00–16:30 London; new-york 08:00–17:00 New York; ny-cash 09:30–16:00 New York; london-ny-overlap 08:00–11:30 New York.
- Market structure, computed on the closed bars of one timeframe (parameters can be tuned):
  - Swing high: a bar whose high is above the highs of the `swingStrength` bars before it (default 2) and not below the highs of the same number of bars after it. It is known only after those later bars have closed. Swing lows mirror this. Labels: HH / LH / EQH and HL / LL / EQL.
  - Break of structure: a bar CLOSES beyond the latest unbroken swing high (bullish) or swing low (bearish). A break in the direction of the trend is a BOS; one against it is a CHoCH (change of character), which flips the trend. The first break sets the trend (UP, DOWN, or UNKNOWN before any break).
  - Liquidity: swing levels stay intact until price trades beyond them. A bar that trades beyond a level but closes back inside SWEEPS it; a close beyond BREAKS it. Intact swing highs (or lows) within the equal-level tolerance (2 ticks, widened to 10% of ATR(14) once known) form buy-side (or sell-side) liquidity pools. The nearest intact liquidity above and below the price is available.
  - Fair value gap: three bars where the third bar's low is above the first bar's high (bullish), or the third bar's high is below the first bar's low (bearish), by at least 1 tick. Status: OPEN, PARTIAL (price has traded into it) or FILLED.
- Economic calendar: scheduled events with time, currency and impact (HIGH / MEDIUM / LOW). Default: no new trades from 15 minutes before to 15 minutes after a HIGH-impact event. A strategy can widen this window, never narrow it.
- News risk per instrument: NORMAL, ELEVATED or HIGH. It is HIGH for 30 minutes after a high-impact headline, which blocks trades. Provider sentiment may exist but is often unknown, so do not depend on it.
- NOT available: order book or market depth, footprint or order-flow delta, tick-by-tick data, options data, data from other markets. If you need any of these, list it under Data gaps.

## 4. The safety gate: 21 checks, and any failure means no trade

- System: the trading mode allows new trades; no kill switch applies; the required components are healthy (database, market data, calendar, execution, automation).
- Data: a fresh quote; fresh account data; data sources acceptable for the mode (simulated data is refused in SHADOW and LIVE).
- Market: market open and more than 10 minutes before its close; inside the strategy's sessions, if it lists any; spread within the instrument's maximum; the executable price within 8 ticks (gold: 50) of the signal's entry, and still between the stop and the target.
- Strategy: the strategy is active and enabled for this account, instrument and direction; the signal state is QUALIFIED; the signal is younger than the strategy's time-to-live; the stop is on the protective side of entry and the target on the profit side.
- Context: news risk is not HIGH for the instrument; no economic-event blackout (global, strategy and firm windows merged, the most restrictive wins). If the strategy requires AI analysis: the AI's second opinion must not CONFLICT, must have confidence of at least 0.6, and must not rate event risk HIGH.
- Risk: account health allows trading; reward-to-risk at least max(1.5, the strategy's minimum); the trades-per-day, losing-streak, open-position and per-instrument limits hold; at least one contract remains after every cap; in the worst case, a 150 USD survival buffer stays above every hard limit.
- Prop firm: every firm rule still holds if every open stop and this trade's stop are hit. With trailing drawdown, this includes the target being reached first and the price then reversing to the stop. The configuration must be owner-verified in LIVE.
- Position: this signal was not already approved, and no order is already working on this instrument.
- Execution: the execution adapter is ready. LIVE trading also needs separate authorization from the owner.

What this means for the design:
- Entries are MARKET orders at the current price; limit entries are not supported yet. An approval must be executed within 30 seconds.
- Every signal carries a concrete stop price and target price. "Trail and see" is not a target. Trade management (breakeven, partial exits, time stops) can be specified separately and marked "management, phase 2".
- A signal is emitted when the entry condition is met on a bar that has just closed, with the entry at or very near the current price.

## 5. Deliverables, in exactly this order

A. Summary (one paragraph): the idea, instrument, timeframes and sessions; the market behaviour it tries to capture, stated as a hypothesis; and the conditions in which it should NOT work.

B. Instruments and timeframes: the execution timeframe, plus any higher-timeframe filter.

C. Parameters table: name | default | test range | meaning.

D. Rules, as numbered, testable statements:
   1. Context and filters: session, trend, higher timeframe, volatility (ATR), any event or news handling stricter than the gate.
   2. Setup: what must exist before an entry is possible, and exactly when a setup expires or is invalidated.
   3. Entry trigger: the exact closed-bar condition.
   4. Stop: an exact price formula, with minimum and maximum stop distance (in ticks or ATR multiples). If the stop is too wide for the risk budget, skip the trade.
   5. Target: an exact price formula. It must give reward-to-risk of at least 1.5; if it does not, skip the trade.
   6. Skip filters: for example opposing liquidity too close, spread too wide, time of day.
   7. Optional daily limits stricter than ASTRA's.
   8. Optional trade management, marked "phase 2": breakeven, partial exits, time stop.

E. Pseudocode for signal generation, evaluated on each closed bar of the execution timeframe. It produces:
   { strategyId, symbol, direction: LONG | SHORT, entryType: MARKET, entry, stop, target, timeframe, detectedAt: <bar close time, UTC>, setupState: QUALIFIED, rationale: [short facts], features: { setup: "<label>", <the numbers used> } }

F. ASTRA strategy configuration, in exactly this YAML shape:

   id: <lowercase-slug>
   name: <name>
   version: 1
   ownership: USER            # set only after the owner has reviewed and accepted it
   status: DRAFT
   description: <one line>
   instruments: [MNQ]
   timeframes: [M5, M15]
   direction: BOTH            # or LONG_ONLY / SHORT_ONLY
   minRewardToRisk: 1.5       # 1.5 or more
   maxRiskPercentPerTrade: 0.25   # optional; cannot exceed the policy
   maxTradesPerDay: 2         # optional
   signalTtlSeconds: 60       # how long a signal stays valid
   requiresAiAnalysis: false  # true only if you want the AI veto
   sessions: [ny-cash]        # ids from section 3
   eventBlackout: { impactLevels: [HIGH], minutesBefore: 15, minutesAfter: 15 }  # optional; can only widen
   rules: { <every parameter from C with its default> }

G. Worked examples: at least 3 small bar-by-bar cases (a valid LONG, a valid SHORT or a second LONG, and one that must be skipped). For each, give the bars (time, open, high, low, close), the swings, breaks, sweeps and gaps detected, and the exact signal or the exact skip reason. These become automated tests.

H. Fit with the prop-firm rules: expected trades per day; typical stop in ticks and typical MNQ size at 125 USD risk; the worst realistic losing day compared with the 1,000 USD daily limit; how the strategy stays within the consistency rule; and when it stops for the day.

I. Test plan: backtest on at least 6 to 12 months of real historical M1 data, covering periods of different volatility; an out-of-sample split or walk-forward test; the go / no-go criteria (expectancy in R with its 95% range, maximum drawdown in R and in USD against the firm's limits, at least 100 trades, profit factor, worst day); and the parameters most likely to be overfit.

J. Data gaps and risks: anything the rules need that section 3 does not provide, and the known failure modes (trend days, news spikes, low volatility, gaps at the open).
```
