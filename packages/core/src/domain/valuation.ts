/**
 * Valuation in the account currency. An instrument's tick value is quoted in its quote currency
 * (USD/JPY: 100 JPY per tick per lot). Before any money is computed — sizing, open risk, P&L —
 * the spec is converted with a rate taken from a live quote of a configured currency pair. With
 * no rate there is no valuation: callers treat that as unknown risk (no trade), never as 1:1.
 */
import { dec, toNum } from '../decimal';
import type { InstrumentSpec } from './instrument';

export interface ConversionQuote {
  readonly bid: number;
  readonly ask: number;
}

export interface Conversion {
  readonly from: string;
  readonly to: string;
  /** Units of `to` per unit of `from`, from the pair's mid price. */
  readonly rate: number;
  /** The pair quoted, e.g. USDJPY for JPY→USD (inverted). */
  readonly via: string;
}

/** An instrument spec whose money figures are in the account currency (or why they are not). */
export type ValuedInstrumentSpec = InstrumentSpec & {
  readonly conversion?: Conversion;
  /** Set when the spec could not be converted: its money figures must not be used. */
  readonly conversionError?: string;
};

/** The configured pair that converts `from` into `to`: FROMTO (direct) or TOFROM (inverted). */
export function conversionPair(
  from: string,
  to: string,
  symbols: Iterable<string>,
): { symbol: string; invert: boolean } | null {
  const all = new Set(symbols);
  if (all.has(`${from}${to}`)) return { symbol: `${from}${to}`, invert: false };
  if (all.has(`${to}${from}`)) return { symbol: `${to}${from}`, invert: true };
  return null;
}

export function conversionRate(
  from: string,
  to: string,
  symbols: Iterable<string>,
  quote: (symbol: string) => ConversionQuote | null,
): Conversion | null {
  if (from === to) return { from, to, rate: 1, via: from };
  const pair = conversionPair(from, to, symbols);
  if (!pair) return null;
  const q = quote(pair.symbol);
  if (!q || !(q.bid > 0) || !(q.ask >= q.bid)) return null;
  const mid = dec(q.bid).plus(q.ask).div(2);
  return {
    from,
    to,
    rate: toNum(pair.invert ? dec(1).div(mid) : mid, 12),
    via: pair.symbol,
  };
}

/** Currency of the commission (defaults to the quote currency, like the tick value). */
export const commissionCurrency = (spec: InstrumentSpec): string =>
  spec.costs.commissionCurrency ?? spec.quoteCurrency;

/**
 * The spec with tick value and commission expressed in `accountCurrency`. When a conversion is
 * needed and `rate` cannot provide it, the result carries `conversionError` and must not be used
 * for money (callers reject).
 */
export function valueInAccountCurrency(
  spec: InstrumentSpec,
  accountCurrency: string,
  rate: (from: string) => Conversion | null,
): ValuedInstrumentSpec {
  const needed = [...new Set([spec.quoteCurrency, commissionCurrency(spec)])].filter(
    (c) => c !== accountCurrency,
  );
  if (needed.length === 0) return spec;
  const rates = new Map<string, Conversion>();
  for (const c of needed) {
    const r = rate(c);
    if (!r) {
      return {
        ...spec,
        conversionError: `no fresh ${c}→${accountCurrency} rate to value ${spec.symbol}`,
      };
    }
    rates.set(c, r);
  }
  const tick = rates.get(spec.quoteCurrency);
  const fee = rates.get(commissionCurrency(spec));
  return {
    ...spec,
    quoteCurrency: accountCurrency,
    tickValue: tick ? toNum(dec(spec.tickValue).mul(tick.rate), 10) : spec.tickValue,
    costs: {
      ...spec.costs,
      commissionPerUnitRoundTurn: fee
        ? toNum(dec(spec.costs.commissionPerUnitRoundTurn).mul(fee.rate), 10)
        : spec.costs.commissionPerUnitRoundTurn,
      commissionCurrency: accountCurrency,
    },
    ...(tick ? { conversion: tick } : fee ? { conversion: fee } : {}),
  };
}

/** A lookup of account-currency specs from live quotes; unconvertible specs are omitted. */
export function valuationLookup(
  specs: ReadonlyMap<string, InstrumentSpec>,
  accountCurrency: string,
  quote: (symbol: string) => ConversionQuote | null,
): (symbol: string) => ValuedInstrumentSpec | undefined {
  return (symbol) => {
    const spec = specs.get(symbol);
    if (!spec) return undefined;
    const v = valueInAccountCurrency(spec, accountCurrency, (from) =>
      conversionRate(from, accountCurrency, specs.keys(), quote),
    );
    return v.conversionError ? undefined : v;
  };
}
