import {
  ManualClock,
  type AccountDefinition,
  type InstrumentSpec,
  type TradingMode,
} from '@astra/core';
import { KillSwitchRegistry } from '@astra/safety';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionGateway, clientOrderIdFor } from '../src/gateway';
import { InMemoryExecutionStore } from '../src/memory-store';
import { PaperBrokerAdapter } from '../src/paper/paper-broker';
import type { ApprovalRecord, BrokerAdapter } from '../src/types';

const NOW = '2026-09-28T14:00:00.000Z';
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
const account: AccountDefinition = {
  id: 'acct-a',
  name: 'A',
  firm: 'TEST',
  propFirmProfileId: 'p',
  riskPolicyId: 'r',
  currency: 'USD',
  status: 'ACTIVE',
  broker: { adapterId: 'paper', accountRef: 'PAPER-A' },
  strategies: ['s'],
  instruments: ['NQ'],
  liveTradingAuthorized: false,
};

function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    approvalId: 'apr_1',
    decisionId: 'dec_1',
    accountId: 'acct-a',
    strategyId: 's',
    signalId: 'sig-1',
    mode: 'PAPER',
    orderPlan: {
      symbol: 'NQ',
      direction: 'LONG',
      entryType: 'MARKET',
      entry: 20_000,
      stop: 19_990,
      target: 20_030,
      quantity: 2,
    },
    expiresAt: '2026-09-28T14:00:30.000Z',
    state: 'PENDING',
    ...overrides,
  };
}

function setup(
  opts: {
    mode?: TradingMode;
    adapter?: BrokerAdapter;
    accountDef?: AccountDefinition;
    liveEnv?: boolean;
  } = {},
) {
  const clock = new ManualClock(NOW);
  const broker = new PaperBrokerAdapter({
    clock,
    instruments: (s) => (s === 'NQ' ? NQ : undefined),
  });
  broker.openAccount('PAPER-A', 50_000);
  broker.onQuote({ symbol: 'NQ', bid: 19_999.75, ask: 20_000, asOf: NOW });
  const store = new InMemoryExecutionStore();
  const ks = new KillSwitchRegistry(clock);
  ks.load([]);
  const onUnknown = vi.fn(() => Promise.resolve());
  const adapter = opts.adapter ?? broker;
  const gateway = new ExecutionGateway({
    store,
    adapter: (id) => (id === adapter.id ? adapter : undefined),
    account: (id) => (id === 'acct-a' ? (opts.accountDef ?? account) : undefined),
    mode: () => opts.mode ?? 'PAPER',
    killSwitches: (ctx) => ks.evaluate(ctx),
    liveTradingEnvironmentAuthorized: () => opts.liveEnv ?? false,
    onExecutionUnknown: onUnknown,
    // Gate behaviour is covered in pre-submit.test.ts; here the verdict is a fixed fake.
    revalidate: () =>
      Promise.resolve({ ok: true, permittedQuantity: 1_000, entry: 20_000, checks: 1 }),
    revalidationTimeoutMs: 1_000,
    clock,
    confirmation: { timeoutMs: 2_000, pollIntervalMs: 250 },
    sleep: (ms) => {
      clock.advance(ms);
      return Promise.resolve();
    },
  });
  return { clock, broker, store, ks, gateway, onUnknown };
}

describe('ExecutionGateway — happy path and duplicates', () => {
  it('submits, confirms the fill, and consumes the approval', async () => {
    const { gateway, store, broker } = setup();
    store.addApproval(approval());
    const r = await gateway.execute('apr_1');
    expect(r.outcome).toBe('CONFIRMED');
    expect(r.brokerState).toMatchObject({
      status: 'FILLED',
      filledQuantity: 2,
      averageFillPrice: 20_000,
    });
    expect(store.approvals.get('apr_1')!.state).toBe('CONSUMED');
    const snap = await broker.getAccountSnapshot('PAPER-A', 'acct-a');
    expect(snap.openPositions[0]).toMatchObject({
      symbol: 'NQ',
      quantity: 2,
      stopPrice: 19_990,
      targetPrice: 20_030,
    });
    expect(store.events.map((e) => e.type)).toEqual([
      'SUBMIT_REQUESTED',
      'SUBMIT_DISPATCHING',
      'SUBMIT_RESPONSE',
      'CONFIRMED',
    ]);
  });

  it('refuses to execute the same approval twice', async () => {
    const { gateway, store } = setup();
    store.addApproval(approval());
    await gateway.execute('apr_1');
    const second = await gateway.execute('apr_1');
    expect(second.outcome).toBe('REJECTED');
    expect(second.reasons.join()).toMatch(/CONSUMED/);
  });

  it('concurrent execution of one approval produces exactly one order', async () => {
    const { gateway, store } = setup();
    store.addApproval(approval());
    const results = await Promise.all([
      gateway.execute('apr_1'),
      gateway.execute('apr_1'),
      gateway.execute('apr_1'),
    ]);
    expect(results.filter((r) => r.outcome === 'CONFIRMED')).toHaveLength(1);
    expect(store.orders.size).toBe(1);
  });

  it('two approvals for the same instrument cannot both add exposure', async () => {
    const { gateway, store } = setup();
    store.addApproval(approval());
    store.addApproval(approval({ approvalId: 'apr_2', decisionId: 'dec_2', signalId: 'sig-2' }));
    const [a, b] = await Promise.all([gateway.execute('apr_1'), gateway.execute('apr_2')]);
    expect([a.outcome, b.outcome].sort()).toEqual(['CONFIRMED', 'REJECTED']);
    expect((a.outcome === 'REJECTED' ? a : b).reasons.join()).toMatch(/position is already open/);
  });
});

describe('ExecutionGateway — re-validation at execution time', () => {
  it('rejects unknown and expired approvals', async () => {
    const { gateway, store, clock } = setup();
    expect((await gateway.execute('nope')).outcome).toBe('REJECTED');
    store.addApproval(approval());
    clock.set('2026-09-28T14:00:31.000Z');
    const r = await gateway.execute('apr_1');
    expect(r.reasons.join()).toMatch(/expired/);
    expect(store.approvals.get('apr_1')!.state).toBe('EXPIRED');
  });

  it('rejects when the mode changed since the decision', async () => {
    const { gateway, store } = setup({ mode: 'HALTED' });
    store.addApproval(approval());
    const r = await gateway.execute('apr_1');
    expect(r.reasons.join()).toMatch(/mode changed/);
    expect(store.approvals.get('apr_1')!.state).toBe('PENDING');
  });

  it('rejects when a kill switch was activated after the decision', async () => {
    const { gateway, store, ks } = setup();
    store.addApproval(approval());
    ks.activate({
      scope: 'EXECUTION',
      target: null,
      reason: 'owner stop',
      actor: { type: 'HUMAN', id: 'owner' },
    });
    const r = await gateway.execute('apr_1');
    expect(r.outcome).toBe('REJECTED');
    expect(store.orders.size).toBe(0);
  });

  it('rejects a disabled account', async () => {
    const { gateway, store } = setup({ accountDef: { ...account, status: 'DISABLED' } });
    store.addApproval(approval());
    expect((await gateway.execute('apr_1')).outcome).toBe('REJECTED');
  });

  it('SHADOW records the order but never transmits it', async () => {
    const { gateway, store, broker } = setup({ mode: 'SHADOW' });
    store.addApproval(approval({ mode: 'SHADOW' }));
    const r = await gateway.execute('apr_1');
    expect(r.outcome).toBe('SHADOW_RECORDED');
    expect(store.orders.get(clientOrderIdFor('apr_1'))!.status).toBe('SHADOW');
    expect((await broker.getAccountSnapshot('PAPER-A', 'acct-a')).openPositions).toHaveLength(0);
  });

  it('LIVE refuses a PAPER adapter and requires authorization', async () => {
    const { gateway, store } = setup({ mode: 'LIVE' });
    store.addApproval(approval({ mode: 'LIVE' }));
    expect((await gateway.execute('apr_1')).reasons.join()).toMatch(/requires LIVE/);
  });

  it('LIVE with a LIVE-kind adapter still needs environment + account authorization', async () => {
    const clock = new ManualClock(NOW);
    const paper = new PaperBrokerAdapter({ clock, instruments: () => NQ });
    const fakeLive = Object.assign(Object.create(paper) as PaperBrokerAdapter, {
      kind: 'LIVE' as const,
      id: 'paper',
    });
    const { gateway, store } = setup({
      mode: 'LIVE',
      adapter: fakeLive as unknown as BrokerAdapter,
    });
    store.addApproval(approval({ mode: 'LIVE' }));
    expect((await gateway.execute('apr_1')).reasons.join()).toMatch(/not authorized/);
  });
});

describe('ExecutionGateway — broker failures', () => {
  it('reports a broker rejection', async () => {
    const { gateway, store, broker } = setup();
    broker.failures.rejectNextOrder = 'insufficient margin';
    store.addApproval(approval());
    const r = await gateway.execute('apr_1');
    expect(r.outcome).toBe('REJECTED');
    expect(r.reasons.join()).toMatch(/insufficient margin/);
    expect(store.orders.get(clientOrderIdFor('apr_1'))!.status).toBe('REJECTED');
  });

  it('confirms by polling when the submit response is lost after acceptance', async () => {
    const { gateway, store, broker, onUnknown } = setup();
    broker.failures.loseNextSubmitResponse = true;
    store.addApproval(approval());
    const r = await gateway.execute('apr_1');
    expect(r.outcome).toBe('CONFIRMED');
    expect(onUnknown).not.toHaveBeenCalled();
    expect(store.events.map((e) => e.type)).toContain('SUBMIT_ERROR');
  });

  it('a transport failure with no trace at the broker is UNKNOWN and halts execution', async () => {
    const { gateway, store, broker, onUnknown } = setup();
    broker.failures.failNextSubmit = true;
    store.addApproval(approval());
    const r = await gateway.execute('apr_1');
    expect(r.outcome).toBe('UNKNOWN');
    expect(onUnknown).toHaveBeenCalledWith(
      'acct-a',
      clientOrderIdFor('apr_1'),
      expect.stringMatching(/could not be confirmed/),
    );
  });

  it('an order that is never confirmed is UNKNOWN and blocks further orders on the symbol', async () => {
    const { gateway, store, broker, onUnknown } = setup();
    broker.failures.neverConfirm = true;
    store.addApproval(approval());
    const r = await gateway.execute('apr_1');
    expect(r.outcome).toBe('UNKNOWN');
    expect(onUnknown).toHaveBeenCalledOnce();
    expect(store.orders.get(clientOrderIdFor('apr_1'))!.status).toBe('UNKNOWN');
    store.addApproval(approval({ approvalId: 'apr_2', decisionId: 'dec_2' }));
    const next = await gateway.execute('apr_2');
    expect(next.reasons.join()).toMatch(/still working/);
  });

  it('a partial fill is confirmed after cancelling the remainder', async () => {
    const { gateway, store, broker } = setup();
    broker.failures.partialFillRatio = 0.5;
    store.addApproval(approval({ orderPlan: { ...approval().orderPlan, quantity: 4 } }));
    const r = await gateway.execute('apr_1');
    expect(r.outcome).toBe('CONFIRMED');
    expect(r.brokerState).toMatchObject({ status: 'FILLED', filledQuantity: 2, quantity: 2 });
  });
});

describe('ExecutionGateway — protective close (ADR-0014)', () => {
  async function withPosition(opts: Parameters<typeof setup>[0] = {}) {
    const s = setup(opts);
    s.store.addApproval(approval());
    await s.gateway.execute('apr_1');
    const snap = await s.broker.getAccountSnapshot('PAPER-A', 'acct-a');
    return { ...s, positionId: snap.openPositions[0]!.positionId };
  }
  const close = (g: ExecutionGateway, positionId: string, id = 'protect:LIMIT_PROXIMITY:x') =>
    g.protectiveClose({ accountId: 'acct-a', positionId, clientCloseId: id, reason: 'test' });

  it('closes at market, idempotently, even under an ACCOUNT kill switch (it only removes risk)', async () => {
    const { gateway, broker, ks, positionId } = await withPosition();
    ks.activate({
      scope: 'ACCOUNT',
      target: 'acct-a',
      reason: 'limit near',
      actor: { type: 'SYSTEM', id: 't' },
    });
    broker.onQuote({ symbol: 'NQ', bid: 19_995, ask: 19_995.25, asOf: NOW });
    expect(await close(gateway, positionId)).toEqual({
      outcome: 'CLOSED',
      reason: 'test',
      exitPrice: 19_995,
      realizedPnl: -200, // −5 pts × $20 × 2
    });
    expect(broker.closedTrades('PAPER-A').at(-1)).toMatchObject({ exitReason: 'PROTECTIVE' });
    // Same clientCloseId: the stored result, no second close; a new id: already flat.
    expect((await close(gateway, positionId)).outcome).toBe('CLOSED');
    expect(broker.closedTrades('PAPER-A')).toHaveLength(1);
    expect((await close(gateway, positionId, 'other')).outcome).toBe('ALREADY_FLAT');
  });

  it('never sends in SHADOW or while an EXECUTION kill switch is active', async () => {
    const s = setup({ mode: 'SHADOW' });
    expect((await close(s.gateway, 'x')).outcome).toBe('SKIPPED');

    const { gateway, ks, positionId, broker } = await withPosition();
    ks.activate({
      scope: 'EXECUTION',
      target: 'acct-a',
      reason: 'order state unknown',
      actor: { type: 'SYSTEM', id: 't' },
    });
    const r = await close(gateway, positionId);
    expect(r).toMatchObject({
      outcome: 'SKIPPED',
      reason: expect.stringMatching(/EXECUTION kill switch .* manual action required/),
    });
    expect(broker.closedTrades('PAPER-A')).toHaveLength(0);
  });

  it('reports rejections and treats a lost response as UNKNOWN (execution halted)', async () => {
    const { gateway, broker, onUnknown, positionId } = await withPosition();
    broker.failures.rejectNextClose = 'market closed';
    expect(await close(gateway, positionId, 'a')).toMatchObject({
      outcome: 'REJECTED',
      reason: 'market closed',
    });
    broker.failures.failNextClose = true;
    expect(await close(gateway, positionId, 'b')).toMatchObject({ outcome: 'UNKNOWN' });
    expect(onUnknown).toHaveBeenCalledWith('acct-a', 'b', expect.stringMatching(/outcome unknown/));
  });
});

describe('ExecutionGateway — LIMIT entries', () => {
  const limitPlan = (entry: number, expiresAt = '2026-09-28T15:00:00.000Z') => ({
    symbol: 'NQ',
    direction: 'LONG' as const,
    entryType: 'LIMIT' as const,
    entry,
    stop: 19_980,
    target: 20_030,
    quantity: 1,
    expiresAt,
  });

  it('a resting LIMIT is a confirmed WORKING order; it fills when the market reaches it', async () => {
    const { gateway, store, broker, clock, onUnknown } = setup();
    store.addApproval(approval({ orderPlan: limitPlan(19_995) }));
    const r = await gateway.execute('apr_1');
    expect(r.outcome).toBe('CONFIRMED');
    expect(r.reasons[0]).toMatch(/^WORKING: LIMIT 1 @ 19995 until/);
    expect(r.brokerState?.status).toBe('ACCEPTED');
    expect(onUnknown).not.toHaveBeenCalled();
    const order = store.orders.get(clientOrderIdFor('apr_1'))!;
    expect(order).toMatchObject({ status: 'ACCEPTED', expiresAt: '2026-09-28T15:00:00.000Z' });

    // Exposure counts before the fill: the snapshot details the resting order.
    const snap = await broker.getAccountSnapshot('PAPER-A', 'acct-a');
    expect(snap.pendingOrders).toBe(1);
    expect(snap.workingOrders?.[0]).toMatchObject({ limitPrice: 19_995, stopPrice: 19_980 });

    // A second approval for the symbol is refused while the order rests.
    store.addApproval(approval({ approvalId: 'apr_2', orderPlan: limitPlan(19_990) }));
    expect((await gateway.execute('apr_2')).reasons[0]).toMatch(/still working/);

    clock.advance(60_000);
    broker.onQuote({
      symbol: 'NQ',
      bid: 19_994.5,
      ask: 19_994.75,
      asOf: clock.now().toISOString(),
    });
    const refreshed = await gateway.refresh(order);
    expect(refreshed).toMatchObject({ changed: true, state: { status: 'FILLED' } });
    expect(store.orders.get(order.clientOrderId)).toMatchObject({
      status: 'FILLED',
      averageFillPrice: 19_995, // at the limit, never better
    });
    const after = await broker.getAccountSnapshot('PAPER-A', 'acct-a');
    expect(after.openPositions[0]).toMatchObject({ entryPrice: 19_995, stopPrice: 19_980 });
    expect(after.workingOrders).toEqual([]);
  });

  it('expires unfilled at its expiry, and can be cancelled while it rests', async () => {
    const { gateway, store, clock } = setup();
    store.addApproval(approval({ orderPlan: limitPlan(19_990, '2026-09-28T14:10:00.000Z') }));
    await gateway.execute('apr_1');
    const order = store.orders.get(clientOrderIdFor('apr_1'))!;
    clock.advance(11 * 60_000);
    expect((await gateway.refresh(order)).state?.status).toBe('EXPIRED');

    store.addApproval(
      approval({
        approvalId: 'apr_2',
        expiresAt: '2026-09-28T14:12:00.000Z',
        orderPlan: limitPlan(19_990),
      }),
    );
    expect((await gateway.execute('apr_2')).brokerState?.status).toBe('ACCEPTED');
    const c = await gateway.cancelWorking({
      accountId: 'acct-a',
      clientOrderId: clientOrderIdFor('apr_2'),
      reason: 'kill switch activated',
    });
    expect(c.outcome).toBe('CANCELLED');
    expect(store.orders.get(clientOrderIdFor('apr_2'))?.status).toBe('CANCELLED');
  });

  it('refuses a LIMIT plan without a future expiry', async () => {
    const { gateway, store } = setup();
    store.addApproval(approval({ orderPlan: limitPlan(19_995, '2026-09-28T13:59:00.000Z') }));
    expect((await gateway.execute('apr_1')).reasons[0]).toMatch(/already be expired/);
  });
});
