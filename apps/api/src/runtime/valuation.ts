/**
 * Account-currency instrument specs from live quotes (e.g. USD/JPY's 100 JPY tick valued in USD
 * with the current USDJPY mid). A spec that needs a conversion with no fresh quote for it is
 * unknown (`undefined`): account state, the monitor and the journal then report that figure as
 * unknown instead of counting yen as dollars.
 */
import type { AstraConfig } from '@astra/config';
import { valuationLookup, type ValuedInstrumentSpec } from '@astra/core';
import type { MarketDataService } from '@astra/market-data';

export type Valuation = (
  accountCurrency: string,
) => (symbol: string) => ValuedInstrumentSpec | undefined;

export function marketValuation(config: AstraConfig, market: MarketDataService): Valuation {
  return (currency) =>
    valuationLookup(config.instruments, currency, (symbol) => {
      const q = market.fresh(symbol);
      return q.status === 'OK' ? q.value : null;
    });
}
