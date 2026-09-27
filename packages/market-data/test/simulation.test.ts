import { ManualClock } from '@astra/core';
import { describe, expect, it } from 'vitest';
import type { RawQuote } from '../src/adapter';
import { MarketDataService } from '../src/service';
import { SimulationAdapter } from '../src/simulation';
import { SESSIONS, instrument } from './fixtures';

function sim(random: () => number, onTick?: (now: Date) => void) {
  const clock = new ManualClock('2026-09-28T14:00:00Z');
  const adapter = new SimulationAdapter({
    intervalMs: 60_000,
    instruments: {
      NQ: { startPrice: 20_000, volatilityTicks: 4, spreadTicks: 1 },
      UNKNOWN: { startPrice: 1, volatilityTicks: 1, spreadTicks: 1 },
    },
    tickSize: (s) => (s === 'NQ' ? 0.25 : undefined),
    clock,
    random,
    ...(onTick ? { onTick } : {}),
  });
  return { adapter, clock };
}

describe('SimulationAdapter', () => {
  it('labels itself SIMULATED and walks the price in whole ticks', () => {
    const { adapter } = sim(() => 1); // +4 ticks every step
    const quotes: RawQuote[] = [];
    expect(adapter.kind).toBe('SIMULATED');
    expect(adapter.health().status).toBe('UNKNOWN');
    adapter.start((q) => quotes.push(q));
    try {
      expect(adapter.health().status).toBe('ONLINE');
      adapter.tick();
      // Symbols without a tick size are skipped.
      expect(quotes.map((q) => [q.symbol, q.bid, q.ask])).toEqual([
        ['NQ', 20_001, 20_001.25],
        ['NQ', 20_002, 20_002.25],
      ]);
    } finally {
      adapter.stop();
    }
    adapter.tick(); // stopped: no-op
    expect(quotes).toHaveLength(2);
    expect(adapter.health().status).toBe('UNKNOWN');
  });

  it('calls onTick after each step (the API pushes its simulated calendar there)', () => {
    const ticks: string[] = [];
    const { adapter } = sim(
      () => 0.5,
      (now) => ticks.push(now.toISOString()),
    );
    adapter.start(() => undefined);
    adapter.stop();
    expect(ticks).toEqual(['2026-09-28T14:00:00.000Z']);
  });

  it('feeds the service through a sink as SIMULATED data', () => {
    const { adapter, clock } = sim(() => 0.5);
    const svc = new MarketDataService({
      clock,
      instruments: new Map([['NQ', instrument()]]),
      sessions: SESSIONS,
      freshness: { maxAgeMs: 5_000, maxFutureSkewMs: 2_000 },
    });
    adapter.start(svc.sink(adapter));
    adapter.stop();
    expect(svc.latest('NQ')).toMatchObject({
      status: 'OK',
      source: 'simulation',
      sourceKind: 'SIMULATED',
      value: { bid: 20_000, ask: 20_000.25 },
    });
  });
});
