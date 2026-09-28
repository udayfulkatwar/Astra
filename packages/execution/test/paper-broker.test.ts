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

describe('PaperBrokerAdapter — FX quoted in another currency', () => {
  const fx = (symbol: string, quoteCurrency: string, tickSize: number, tickValue: number) =>
    ({
      ...NQ,
      symbol,
      assetClass: 'FOREX',
      quantityUnit: 'LOTS',
      quoteCurrency,
      tickSize,
      tickValue,
      quantityStep: 0.01,
      minQuantity: 0.01,
      costs: {
        commissionPerUnitRoundTurn: 7,
        commissionCurrency: 'USD',
        slippageAllowanceTicks: 5,
      },
    }) satisfies InstrumentSpec;
  const specs: Record<string, InstrumentSpec> = {
    USDJPY: fx('USDJPY', 'JPY', 0.001, 100),
    EURGBP: fx('EURGBP', 'GBP', 0.00001, 1),
  };
  const at = '2026-09-28T14:00:00Z';
  const setup = () => {
    const b = new PaperBrokerAdapter({
      clock: new ManualClock(at),
      instruments: (s) => specs[s],
    });
    b.openAccount('A', 50_000, 'USD');
    b.onQuote({ symbol: 'USDJPY', bid: 150, ask: 150.01, asOf: at });
    b.onQuote({ symbol: 'EURGBP', bid: 0.85, ask: 0.85005, asOf: at });
    return b;
  };
  const fxOrder = {
    ...order,
    symbol: 'USDJPY',
    quantity: 1,
    stopLoss: 149.8,
    takeProfit: 150.4,
  };

  it('books USD/JPY profit in dollars at the USDJPY rate of the exit', async () => {
    const b = setup();
    expect(await b.submitOrder(fxOrder)).toMatchObject({ status: 'FILLED' });
    expect((await b.getAccountSnapshot('A', 'x')).balance).toBe(49_993); // $7 commission
    b.onQuote({ symbol: 'USDJPY', bid: 150.4, ask: 150.41, asOf: '2026-09-28T14:05:00Z' });
    const [t] = b.closedTrades('A');
    // 390 ticks × 100 JPY = 39,000 JPY ÷ 150.405 (mid) = $259.30
    expect(t).toMatchObject({ exitReason: 'TARGET', exitPrice: 150.4 });
    expect(t!.realizedPnl).toBeCloseTo(259.3, 2);
  });

  it('refuses an order whose P&L it cannot convert (no GBPUSD quote for a GBP-quoted pair)', async () => {
    const b = setup();
    const s = await b.submitOrder({
      ...order,
      clientOrderId: 'c-eg',
      symbol: 'EURGBP',
      quantity: 1,
      stopLoss: 0.849,
      takeProfit: 0.852,
    });
    expect(s.status).toBe('REJECTED');
    expect(s.rejectReason).toMatch(/no fresh GBP→USD rate/);
  });
});

describe('PaperBrokerAdapter — LIMIT entries', () => {
  const limitOrder = { ...order, entryType: 'LIMIT' as const, quantity: 1, stopLoss: 19_980 };

  it('fills a marketable limit at once at the market; a resting one only at its limit', async () => {
    const { b, clock } = broker();
    const now = await b.submitOrder({
      ...limitOrder,
      clientOrderId: 'm1',
      limitPrice: 20_001,
      expiresAt: '2026-09-28T15:00:00Z',
    });
    expect(now).toMatchObject({ status: 'FILLED', averageFillPrice: 20_000 });

    const rest = await b.submitOrder({
      ...limitOrder,
      clientOrderId: 'r1',
      limitPrice: 19_995,
      expiresAt: '2026-09-28T15:00:00Z',
    });
    expect(rest.status).toBe('ACCEPTED');
    b.onQuote({ symbol: 'NQ', bid: 19_997, ask: 19_997.25, asOf: clock.now().toISOString() });
    expect((await b.getOrder('A', 'r1'))?.status).toBe('ACCEPTED');
    b.onQuote({ symbol: 'NQ', bid: 19_990, ask: 19_990.25, asOf: clock.now().toISOString() });
    expect(await b.getOrder('A', 'r1')).toMatchObject({
      status: 'FILLED',
      averageFillPrice: 19_995,
    });
  });

  it('expires on time, survives export/import while resting, and rejects bad limits', async () => {
    const { b, clock } = broker();
    await b.submitOrder({
      ...limitOrder,
      clientOrderId: 'r2',
      limitPrice: 19_990,
      expiresAt: '2026-09-28T14:05:00Z',
    });
    const copy = new PaperBrokerAdapter({ clock, instruments: () => NQ });
    copy.importAccount('A', b.exportAccount('A'));
    expect((await copy.getAccountSnapshot('A', 'x')).workingOrders).toHaveLength(1);
    clock.advance(5 * 60_000);
    expect((await copy.getOrder('A', 'r2'))?.status).toBe('EXPIRED');
    expect((await copy.getAccountSnapshot('A', 'x')).pendingOrders).toBe(0);

    const offGrid = await b.submitOrder({
      ...limitOrder,
      clientOrderId: 'bad',
      limitPrice: 19_990.1,
      expiresAt: '2026-09-28T15:00:00Z',
    });
    expect(offGrid).toMatchObject({
      status: 'REJECTED',
      rejectReason: expect.stringMatching(/tick/),
    });
    const noExpiry = await b.submitOrder({
      ...limitOrder,
      clientOrderId: 'bad2',
      limitPrice: 19_990,
    });
    expect(noExpiry.rejectReason).toMatch(/expiry/);
  });
});
