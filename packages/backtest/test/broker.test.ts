import { describe, expect, it } from 'vitest';
import type { Bar } from '@astra/market-data';
import { BacktestBroker } from '../src';
import { config } from './helpers';

const spec = config.instruments.get('MNQ')!; // tick 0.25, $0.50/tick, $1.50 commission

function bar(minute: number, o: number, h: number, l: number, c: number): Bar {
  const open = Date.parse('2026-03-03T15:00:00Z') + minute * 60_000;
  return {
    symbol: 'MNQ',
    timeframe: 'M1',
    openTime: new Date(open).toISOString(),
    closeTime: new Date(open + 60_000).toISOString(),
    open: o,
    high: h,
    low: l,
    close: c,
    volume: null,
    tickCount: 0,
    complete: true,
    source: 'test',
    sourceKind: 'SIMULATED',
  };
}

const broker = () =>
  new BacktestBroker({
    accountId: 'paper-demo',
    currency: 'USD',
    startingBalance: 50_000,
    spec,
    model: { spreadTicks: 1, slippageTicks: 1 },
  });

const LATER = '2026-03-03T16:00:00.000Z';

describe('BacktestBroker fill model', () => {
  it('fills a LONG entry at the next open: ask plus adverse slippage, commission at entry', () => {
    const b = broker();
    b.queueEntry({
      clientOrderId: 'o1',
      direction: 'LONG',
      quantity: 2,
      stop: 90,
      target: 120,
      expiresAt: LATER,
    });
    expect(b.positions()).toHaveLength(0); // nothing fills at the decision price
    const out = b.onBar(bar(0, 100, 101, 99.5, 100.5));
    expect(out.opened).toHaveLength(1);
    // 100 + half spread 0.125 + 1 tick slippage 0.25
    expect(out.opened[0]!.entryPrice).toBe(100.375);
    const snap = b.snapshot(bar(0, 0, 0, 0, 0).closeTime, 100.5);
    expect(snap.balance).toBe(50_000 - 3); // 2 × $1.50
    // Marked at the bid 100.375: flat vs entry.
    expect(snap.equity).toBe(snap.balance);
  });

  it('fills a SHORT entry at the bid minus slippage', () => {
    const b = broker();
    b.queueEntry({
      clientOrderId: 'o1',
      direction: 'SHORT',
      quantity: 1,
      stop: 110,
      target: 80,
      expiresAt: LATER,
    });
    expect(b.onBar(bar(0, 100, 100.5, 99.5, 100)).opened[0]!.entryPrice).toBe(99.625);
  });

  it('assumes the stop first when one bar reaches both stop and target', () => {
    const b = broker();
    b.queueEntry({
      clientOrderId: 'o1',
      direction: 'LONG',
      quantity: 1,
      stop: 95,
      target: 105,
      expiresAt: LATER,
    });
    b.onBar(bar(0, 100, 100.5, 99.5, 100));
    const out = b.onBar(bar(1, 100, 110, 90, 100));
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0]!.exitReason).toBe('STOP');
    expect(out.closed[0]!.exitPrice).toBe(94.75); // stop − 1 tick slippage
  });

  it('fills a stop gapped through at the open (exit side, with slippage)', () => {
    const b = broker();
    b.queueEntry({
      clientOrderId: 'o1',
      direction: 'LONG',
      quantity: 1,
      stop: 95,
      target: 105,
      expiresAt: LATER,
    });
    b.onBar(bar(0, 100, 100.5, 99.5, 100));
    const out = b.onBar(bar(1, 92, 93, 91, 92.5));
    expect(out.closed[0]!.exitReason).toBe('STOP');
    expect(out.closed[0]!.exitPrice).toBe(92 - 0.125 - 0.25);
  });

  it('fills a target at the target, never better, and only when the exit side reaches it', () => {
    const b = broker();
    b.queueEntry({
      clientOrderId: 'o1',
      direction: 'LONG',
      quantity: 1,
      stop: 95,
      target: 105,
      expiresAt: LATER,
    });
    b.onBar(bar(0, 100, 100.5, 99.5, 100));
    // Mid high 105.1 → bid 104.975: not reached.
    expect(b.onBar(bar(1, 100, 105.1, 99.9, 104)).closed).toHaveLength(0);
    const out = b.onBar(bar(2, 104, 107, 103.9, 106));
    expect(out.closed[0]!.exitReason).toBe('TARGET');
    expect(out.closed[0]!.exitPrice).toBe(105);
    // (105 − 100.375) / 0.25 × 0.5 = 9.25 gross
    expect(out.closed[0]!.realizedPnl).toBe(9.25);
  });

  it('executes a protective close at the next open with slippage', () => {
    const b = broker();
    b.queueEntry({
      clientOrderId: 'o1',
      direction: 'SHORT',
      quantity: 1,
      stop: 110,
      target: 80,
      expiresAt: LATER,
    });
    const opened = b.onBar(bar(0, 100, 100.5, 99.5, 100)).opened[0]!;
    b.queueClose(opened.positionId);
    expect(b.isClosePending(opened.positionId)).toBe(true);
    const out = b.onBar(bar(1, 101, 102, 100, 101));
    expect(out.closed[0]).toMatchObject({
      exitReason: 'PROTECTIVE',
      exitPrice: 101 + 0.125 + 0.25,
      closedAt: bar(1, 0, 0, 0, 0).openTime,
    });
    expect(b.positions()).toHaveLength(0);
  });

  it('drops an entry whose approval expired before the next bar opened', () => {
    const b = broker();
    b.queueEntry({
      clientOrderId: 'o1',
      direction: 'LONG',
      quantity: 1,
      stop: 95,
      target: 105,
      expiresAt: '2026-03-03T14:59:00.000Z',
    });
    const out = b.onBar(bar(0, 100, 101, 99, 100));
    expect(out.expired.map((o) => o.clientOrderId)).toEqual(['o1']);
    expect(out.opened).toHaveLength(0);
    expect(b.hasPendingEntry()).toBe(false);
  });

  it('reports the exposed range of positions still open (exit side)', () => {
    const b = broker();
    b.queueEntry({
      clientOrderId: 'o1',
      direction: 'LONG',
      quantity: 1,
      stop: 95,
      target: 105,
      expiresAt: LATER,
    });
    const out = b.onBar(bar(0, 100, 102, 98, 101));
    expect(out.exposed[0]).toMatchObject({ bestExit: 101.875, worstExit: 97.875 });
  });
});
