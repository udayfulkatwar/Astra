import { resolve } from 'node:path';
import { loadAstraConfig } from '@astra/config';
import { describe, expect, it } from 'vitest';
import { REALISTIC_COSTS, ResearchBroker, type ResearchBar } from '../src';

const config = loadAstraConfig(resolve(import.meta.dirname, '../../../config'));
const T = Date.parse('2026-03-03T10:00:00Z');
const bar = (t: number, bid: number, ask: number, move = 0): ResearchBar => ({
  t,
  bid: { o: bid, h: bid + move + 0.01, l: bid - 0.01, c: bid + move },
  ask: { o: ask, h: ask + move + 0.01, l: ask - 0.01, c: ask + move },
  spread: 'DATA',
});

describe('research broker', () => {
  it('values USD/JPY with the last uncrossed quote when a candle’s bid and ask disagree', () => {
    const broker = new ResearchBroker({
      accountId: 'paper-fx',
      currency: 'USD',
      startingBalance: 50_000,
      specs: config.instruments,
      costs: REALISTIC_COSTS,
    });
    broker.onBar('USDJPY', bar(T, 150.0, 150.01));
    broker.place({
      id: 'o1',
      symbol: 'USDJPY',
      direction: 'LONG',
      quantity: 1,
      limit: 150.0,
      stop: 149.5,
      target: 151.0,
      activeFrom: T + 300_000,
      expiresAt: T + 3_600_000,
      signalId: 's1',
      placedAt: new Date(T).toISOString(),
    });
    expect(broker.onBar('USDJPY', bar(T + 300_000, 149.99, 150.0)).filled).toHaveLength(1);
    // Ask below bid (the two series disagree for this candle): accounting goes on at the last
    // uncrossed mid instead of failing; the raw quote is still what the gate sees.
    const crossed = bar(T + 600_000, 150.2, 150.19);
    expect(() => broker.onBar('USDJPY', crossed)).not.toThrow();
    expect(broker.quote('USDJPY')).toEqual({ bid: 150.2, ask: 150.19 });
    const snap = broker.snapshot(T + 900_000);
    // 20 pips on 1 lot, converted at the last uncrossed mid (149.995) → ≈ 133.34 USD floating.
    expect(snap.equity - snap.balance).toBeCloseTo((0.2 * 100_000) / 149.995, 1);
  });
});
