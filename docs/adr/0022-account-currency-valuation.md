# ADR-0022: Account-currency valuation of instruments (FX pairs)

**Status:** Accepted · **Date:** 2026-09-28

## Context

The owner's strategy trades EUR/USD, GBP/USD and USD/JPY. USD/JPY's tick value is in yen
(100 JPY per 0.001 per standard lot). Every money figure in ASTRA — sizing, open risk, prop-firm
limits, paper and backtest P&L, the journal's R — assumed the tick value was already in the
account currency. Treating yen as dollars would size USD/JPY trades 150 times too small and
report losses 150 times too large.

## Decision

- **Convert before any money is computed** (`@astra/core` `domain/valuation`):
  - A spec in another currency is converted with a live quote of a configured pair (`JPYUSD`
    direct, or `USDJPY` inverted), at the mid price.
  - The commission currency is separate (`costs.commissionCurrency`, default: the quote
    currency), because FX brokers usually charge in USD.
- **No rate, no valuation.**
  - A missing or stale quote gives a spec that carries `conversionError` instead of a guessed
    1:1 value.
  - Sizing rejects it, and so does any spec still in another currency. Account state and the
    monitor treat the figure as unknown, which blocks new risk.
- **Where the rate comes from:**
  - Gate: the assembler fetches the conversion quotes, checks their freshness and freezes the
    rate into the decision record (`instruments[…].conversion`).
  - Server (account state, monitor, journal): fresh quotes from the market-data service.
  - Paper broker: its own latest quotes. It refuses an order it cannot value, so a position
    it opened can always be settled.
  - Backtest: the replayed pair's own bar price. A replay that would need another pair's price
    is refused before it starts.
- **FX instrument templates**: `config/instruments/{EURUSD,GBPUSD,USDJPY}.yaml`, marked
  UNVERIFIED. They assume the standard conventions (1 lot = 100,000 base units, 5 / 3 digits,
  7 USD per lot round turn, Sun 17:05 – Fri 17:00 New York). A `paper-fx` account uses them with
  the TEMPLATE firm profile.

## Consequences

- USD/JPY risk and P&L are in dollars everywhere. Sizing, P&L and R agree because every place
  uses the same conversion rule.
- Cross pairs that need a third pair (e.g. EUR/GBP in a USD account needs GBP/USD) work only
  when that pair is configured and quoted. Otherwise they cannot be traded, which is correct.
- The journal values a closed trade at the quotes current when the close is recorded. Without
  a fresh quote its costs and R are left empty rather than guessed.
- The owner must confirm contract size, digits, commission and hours with the broker before the
  specs can be marked USER_VERIFIED. LIVE refuses them until then.
