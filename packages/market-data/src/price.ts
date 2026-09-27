/** Price derivations from a quote (decimal math: no binary-float artefacts in stored prices). */
import { dec, toNum, type Quote } from '@astra/core';

/** (bid + ask) / 2. */
export function quoteMid(q: Pick<Quote, 'bid' | 'ask'>): number {
  return toNum(dec(q.bid).plus(q.ask).div(2), 10);
}

/** Bar price basis: the last trade when the source reports one, otherwise the mid. */
export function barPrice(q: Pick<Quote, 'bid' | 'ask' | 'last'>): number {
  return q.last ?? quoteMid(q);
}

/** Spread in ticks (2 dp). */
export function spreadTicks(q: Pick<Quote, 'bid' | 'ask'>, tickSize: number): number {
  return toNum(dec(q.ask).minus(q.bid).div(tickSize), 2);
}

/** Absolute distance between two prices in ticks (2 dp). */
export function ticksBetween(a: number, b: number, tickSize: number): number {
  return toNum(dec(a).minus(b).abs().div(tickSize), 2);
}
