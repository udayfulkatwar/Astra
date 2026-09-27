import { ManualClock, type InstrumentSpec } from '@astra/core';
import { describe, expect, it } from 'vitest';
import { PaperBrokerAdapter } from '../src/paper/paper-broker';

const NQ: InstrumentSpec = {
  symbol: 'NQ',
  displayName: 'Test NQ',
  assetClass: 'FUTURES',
  quantityUnit: 'CONTRACTS',
  quoteCurrency: 'USD',
  tickSize: 0.25,
  tickValue: 5,
  quantityStep: 1,
  minQuantity: 1,
  maxSpreadTicks: 4,
  costs: { commissionPerUnitRoundTurn: 4, slippageAllowanceTicks: 1 },
  verification: { status: 'UNVERIFIED' },
};

function broker() {
  const clock = new ManualClock('2026-09-28T14:00:00Z');
  const b = new PaperBrokerAdapter({ clock, instruments: () => NQ });
  b.openAccount('A', 50_000);
  b.onQuote({ symbol: 'NQ', bid: 19_999.75, ask: 20_000, asOf: clock.now().toISOString() });
  return { b, clock };
}
const order = {
  clientOrderId: 'c1',
  accountRef: 'A',
  symbol: 'NQ',
  direction: 'LONG' as const,
  quantity: 2,
  entryType: 'MARKET' as const,
  stopLoss: 19_990,
  takeProfit: 20_030,
};

describe('PaperBrokerAdapter', () => {
  it('fills market orders at the ask and charges commission', async () => {
    const { b } = broker();
    const s = await b.submitOrder(order);
    expect(s).toMatchObject({ status: 'FILLED', averageFillPrice: 20_000, filledQuantity: 2 });
    const snap = await b.getAccountSnapshot('A', 'acct-a');
    expect(snap.balance).toBe(49_992);
    expect(snap.equity).toBe(49_992 - 10); // marked at bid: −0.25 × $20 × 2
  });

  it('is idempotent on clientOrderId', async () => {
    const { b } = broker();
    await b.submitOrder(order);
    await b.submitOrder(order);
    expect((await b.getAccountSnapshot('A', 'x')).openPositions).toHaveLength(1);
  });

  it('closes at the stop (loss) and records the trade', async () => {
    const { b } = broker();
    await b.submitOrder(order);
    b.onQuote({ symbol: 'NQ', bid: 19_989.75, ask: 19_990, asOf: '2026-09-28T14:01:00Z' });
    const [t] = b.closedTrades('A');
    // gap-through: exit at the worse of stop (19990) and bid (19989.75)
    expect(t).toMatchObject({ exitReason: 'STOP', exitPrice: 19_989.75, realizedPnl: -410 }); // −10.25 pts × $20 × 2
    expect((await b.getAccountSnapshot('A', 'x')).balance).toBe(49_992 - 410);
  });

  it('closes at the target (profit)', async () => {
    const { b } = broker();
    await b.submitOrder(order);
    b.onQuote({ symbol: 'NQ', bid: 20_030, ask: 20_030.25, asOf: '2026-09-28T14:01:00Z' });
    expect(b.closedTrades('A')[0]).toMatchObject({ exitReason: 'TARGET', realizedPnl: 1_200 });
  });

  it('rejects orders with stops on the wrong side or without a market', async () => {
    const { b } = broker();
    expect((await b.submitOrder({ ...order, clientOrderId: 'c2', stopLoss: 20_010 })).status).toBe(
      'REJECTED',
    );
    expect((await b.submitOrder({ ...order, clientOrderId: 'c3', symbol: 'ES' })).status).toBe(
      'REJECTED',
    );
  });
});

describe('PaperBrokerAdapter persistence', () => {
  it('exports and imports account state (restart recovery) and notifies on change', async () => {
    const clock = new ManualClock('2026-09-28T14:00:00Z');
    const changes: string[] = [];
    const b = new PaperBrokerAdapter({
      clock,
      instruments: () => NQ,
      onChange: (ref) => changes.push(ref),
    });
    b.openAccount('A', 50_000);
    b.onQuote({ symbol: 'NQ', bid: 19_999.75, ask: 20_000, asOf: clock.now().toISOString() });
    await b.submitOrder(order);
    expect(changes).toEqual(['A']);
    const saved = JSON.parse(JSON.stringify(b.exportAccount('A'))) as ReturnType<
      typeof b.exportAccount
    >;

    const restarted = new PaperBrokerAdapter({ clock, instruments: () => NQ });
    restarted.importAccount('A', saved);
    restarted.onQuote({
      symbol: 'NQ',
      bid: 20_030,
      ask: 20_030.25,
      asOf: clock.now().toISOString(),
    });
    expect(restarted.closedTrades('A')[0]).toMatchObject({
      exitReason: 'TARGET',
      realizedPnl: 1_200,
    });
    expect((await restarted.getOrder('A', 'c1'))?.status).toBe('FILLED');
  });
});
