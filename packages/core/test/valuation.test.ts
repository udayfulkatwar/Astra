import { describe, expect, it } from 'vitest';
import {
  conversionPair,
  conversionRate,
  valuationLookup,
  valueInAccountCurrency,
  type InstrumentSpec,
} from '../src';

const fx = (symbol: string, quoteCurrency: string, tickSize: number, tickValue: number) =>
  ({
    symbol,
    displayName: symbol,
    assetClass: 'FOREX',
    quantityUnit: 'LOTS',
    quoteCurrency,
    tickSize,
    tickValue,
    quantityStep: 0.01,
    minQuantity: 0.01,
    maxSpreadTicks: 20,
    costs: { commissionPerUnitRoundTurn: 7, commissionCurrency: 'USD', slippageAllowanceTicks: 5 },
    verification: { status: 'UNVERIFIED' },
  }) satisfies InstrumentSpec;

const EURUSD = fx('EURUSD', 'USD', 0.00001, 1);
const USDJPY = fx('USDJPY', 'JPY', 0.001, 100);
const EURGBP = fx('EURGBP', 'GBP', 0.00001, 1);
const symbols = ['EURUSD', 'USDJPY', 'EURGBP'];

describe('currency valuation', () => {
  it('finds the pair that converts one currency into another, direct or inverted', () => {
    expect(conversionPair('JPY', 'USD', symbols)).toEqual({ symbol: 'USDJPY', invert: true });
    expect(conversionPair('EUR', 'USD', symbols)).toEqual({ symbol: 'EURUSD', invert: false });
    expect(conversionPair('GBP', 'USD', symbols)).toBeNull(); // no GBPUSD configured
  });

  it('converts at the mid price; a missing or invalid quote gives no rate', () => {
    const q = (s: string) => (s === 'USDJPY' ? { bid: 149.99, ask: 150.01 } : null);
    expect(conversionRate('JPY', 'USD', symbols, q)).toMatchObject({
      rate: Number((1 / 150).toFixed(12)),
      via: 'USDJPY',
    });
    expect(conversionRate('USD', 'USD', symbols, q)).toMatchObject({ rate: 1 });
    expect(conversionRate('EUR', 'USD', symbols, q)).toBeNull();
    expect(conversionRate('JPY', 'USD', symbols, () => ({ bid: 150, ask: 149 }))).toBeNull();
  });

  it('values USD/JPY in a USD account: 100 JPY per tick at 150.00 is $0.6667; USD commission stays', () => {
    const v = valueInAccountCurrency(USDJPY, 'USD', (from) =>
      conversionRate(from, 'USD', symbols, () => ({ bid: 150, ask: 150 })),
    );
    expect(v.conversionError).toBeUndefined();
    expect(v.quoteCurrency).toBe('USD');
    expect(v.tickValue).toBeCloseTo(0.6666666667, 9);
    expect(v.costs.commissionPerUnitRoundTurn).toBe(7);
    expect(v.conversion).toMatchObject({ from: 'JPY', to: 'USD', via: 'USDJPY' });
    // Already in the account currency: unchanged, no quote needed.
    expect(valueInAccountCurrency(EURUSD, 'USD', () => null)).toBe(EURUSD);
  });

  it('never guesses 1:1 — without a rate the spec carries an error and the lookup omits it', () => {
    const v = valueInAccountCurrency(USDJPY, 'USD', () => null);
    expect(v.conversionError).toMatch(/no fresh JPY→USD rate to value USDJPY/);
    const specs = new Map([
      ['EURUSD', EURUSD],
      ['USDJPY', USDJPY],
      ['EURGBP', EURGBP],
    ]);
    const lookup = valuationLookup(specs, 'USD', (s) =>
      s === 'USDJPY' ? { bid: 150, ask: 150 } : null,
    );
    expect(lookup('USDJPY')?.tickValue).toBeCloseTo(0.6667, 4);
    expect(lookup('EURUSD')).toBe(EURUSD);
    expect(lookup('EURGBP')).toBeUndefined(); // GBP→USD needs a GBPUSD quote
    expect(lookup('NQ')).toBeUndefined();
  });
});
