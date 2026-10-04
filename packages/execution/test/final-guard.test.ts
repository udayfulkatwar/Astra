/**
 * F003 — the final synchronous freshness guard in the gateway (ADR-0027 §3a). The LAST durable
 * wait of the final gate is the shared-ledger read after the full deterministic revalidation; the
 * world is changed while that read waits. Real assembler + Decision Engine + revalidateApprovedEntry.
 */
import { describe, expect, it, vi } from 'vitest';
import { ExecutionGateway } from '../src/gateway';
import { InMemoryExecutionStore } from '../src/memory-store';
import type { BrokerAdapter } from '../src/types';
import {
  accountDef,
  decide,
  instrument,
  makeBroker,
  makeWorld,
  realRevalidator,
  type World,
} from './gate-world';

function setup(w: World = makeWorld()) {
  const store = new InMemoryExecutionStore();
  const paper = makeBroker(w);
  const submit = vi.spyOn(paper, 'submitOrder');
  const broker: BrokerAdapter = instrument(w, paper);
  const events: string[] = [];
  const bound = { adapter: broker, accountRef: 'PAPER-A' };
  const revalidate = realRevalidator(w, store);
  const hooks = {
    revalidate: (req: Parameters<typeof revalidate>[0]) => revalidate(req),
    guard: (g: () => unknown) => g,
  };
  const gateway = new ExecutionGateway({
    store,
    adapter: (id) => (id === bound.adapter.id ? bound.adapter : undefined),
    account: (id) =>
      id === 'acct-a'
        ? ({
            ...accountDef(w),
            broker: { adapterId: 'paper', accountRef: bound.accountRef },
          } as never)
        : undefined,
    mode: () => w.mode,
    killSwitches: (ctx) => w.ks.evaluate(ctx),
    liveTradingEnvironmentAuthorized: () => w.liveEnv,
    onExecutionUnknown: () => Promise.resolve(),
    revalidate: async (req) => {
      const v = await hooks.revalidate(req);
      if (!v.ok) return v;
      const real = v.finalGuard as () => unknown;
      return { ...v, finalGuard: hooks.guard(() => (events.push('guard'), real())) as never };
    },
    revalidationTimeoutMs: 1_000,
    clock: w.clock,
    confirmation: { timeoutMs: 2_000, pollIntervalMs: 250 },
    sleep: (ms) => {
      w.clock.advance(ms);
      return Promise.resolve();
    },
  });
  submit.mockImplementation(((...a: unknown[]) => {
    events.push('submit');
    return (Object.getPrototypeOf(paper) as BrokerAdapter).submitOrder.apply(paper, a as never);
  }) as never);
  const add = (o: Parameters<typeof decide>[1]) => {
    const d = decide(w, o);
    store.addApproval(d.approval);
    return d;
  };

  /** Runs `during()` while the FINAL ledger read (second read of the final gate) is outstanding. */
  const holdFinalLedgerRead = (during: () => void) => {
    let armed = false;
    let reads = 0;
    const realDispatch = store.markDispatching.bind(store);
    store.markDispatching = async (...a: Parameters<typeof realDispatch>) => {
      const r = await realDispatch(...a);
      armed = true;
      return r;
    };
    const realExposure = store.accountExposure.bind(store);
    store.accountExposure = async (id: string) => {
      const out = await realExposure(id);
      if (armed && ++reads === 2) {
        await new Promise((r) => setTimeout(r, 1)); // the DB "took a while"
        during();
      }
      return out;
    };
  };
  return {
    w,
    store,
    paper,
    submit,
    broker,
    bound,
    gateway,
    add,
    events,
    hooks,
    holdFinalLedgerRead,
  };
}
type S = ReturnType<typeof setup>;
const reasons = (r: { reasons: readonly string[] }) => r.reasons.join(' | ');

async function refusedSafely(s: S, why: RegExp) {
  const r = await s.gateway.execute('a1');
  expect(r.outcome).toBe('REJECTED');
  expect(reasons(r)).toMatch(why);
  expect(reasons(r)).toMatch(/nothing was transmitted/);
  expect(s.submit).not.toHaveBeenCalled();
  expect((await s.store.accountExposure('acct-a')).reservations).toHaveLength(0);
  expect(s.store.orders.get('astra-a1')!.status).toBe('REJECTED');
}

describe('a wait on the FINAL ledger read cannot carry aged or revoked evidence to the broker', () => {
  it('quote ages beyond its limit (approval TTL still valid)', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    s.w.quoteAsOf = '2026-09-28T13:59:59.500Z'; // fresh at validation, 5s limit
    s.holdFinalLedgerRead(() => s.w.clock.advance(6_000)); // quote 6.5s old; approval TTL is 30s
    await refusedSafely(s, /\[final-guard\].*quote/i);
  });

  it('the clock crosses into an event blackout (every other input still valid)', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    // HIGH event 14:15:03 → 15 min blackout starts 14:00:03; validated at 14:00:00 → fine.
    s.w.calendarEvents = [
      {
        id: 'cpi',
        title: 'Surprise CPI',
        impact: 'HIGH',
        scheduledAt: '2026-09-28T14:15:03.000Z',
        affectedInstruments: [],
      },
    ];
    s.holdFinalLedgerRead(() => s.w.clock.advance(4_000)); // quote 4.5s old (<5s), snapshot fresh
    await refusedSafely(s, /Surprise CPI/);
  });

  it('a provider that goes ERROR during the wait voids its still-timestamp-fresh evidence', async () => {
    for (const k of ['quote', 'calendar'] as const) {
      const s = setup();
      s.add({ approvalId: 'a1', signalId: 's1' });
      s.holdFinalLedgerRead(() => (s.w.revoked[k] = true));
      await refusedSafely(s, new RegExp(`${k} provider is now ERROR`));
    }
  });

  it('kill switch / mode / readiness changes during the wait refuse (control plane + engine)', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    s.holdFinalLedgerRead(() => (s.w.mode = 'HALTED'));
    await refusedSafely(s, /mode changed/);
  });

  it('adapter replaced during the wait: a fresh control result never authorizes the obsolete adapter', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    const other = instrument(s.w, makeBroker(s.w));
    s.holdFinalLedgerRead(() => (s.bound.adapter = other));
    await refusedSafely(s, /binding changed/);
  });

  it('broker accountRef changed during the wait', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    s.holdFinalLedgerRead(() => (s.bound.accountRef = 'PAPER-OTHER'));
    await refusedSafely(s, /binding changed/);
  });

  it('positive path: fresh valid inputs submit exactly once; the guard is the last step before submit', async () => {
    const s = setup();
    const d = s.add({ approvalId: 'a1', signalId: 's1' });
    s.holdFinalLedgerRead(() => s.w.clock.advance(1_000)); // a wait that keeps everything valid
    const r = await s.gateway.execute('a1');
    expect(r.outcome).toBe('CONFIRMED');
    expect(s.submit).toHaveBeenCalledTimes(1);
    expect(s.submit.mock.calls[0]![0].quantity).toBe(d.approval.orderPlan.quantity);
    const g = s.events.lastIndexOf('guard');
    expect(s.events.slice(g)).toEqual(['guard', 'submit']);
  });

  it('no store, broker or other call sits between the guard and submitOrder', async () => {
    const s = setup();
    s.add({ approvalId: 'a1', signalId: 's1' });
    for (const name of Object.getOwnPropertyNames(
      Object.getPrototypeOf(s.store),
    ) as (keyof typeof s.store)[]) {
      const f = s.store[name] as unknown;
      if (name === 'constructor' || typeof f !== 'function') continue;
      (s.store as unknown as Record<string, unknown>)[name as string] = (...a: unknown[]) => {
        s.events.push(`store.${String(name)}`);
        return (f as (...x: unknown[]) => unknown).apply(s.store, a);
      };
    }
    await s.gateway.execute('a1');
    const g = s.events.lastIndexOf('guard');
    expect(g).toBeGreaterThan(-1);
    expect(s.events[g + 1]).toBe('submit');
  });
});

describe('a missing, throwing, asynchronous or malformed guard never transmits', () => {
  const cases: [string, (g: () => unknown) => unknown, RegExp][] = [
    ['missing', () => undefined, /final guard/i],
    [
      'throwing',
      () => () => {
        throw new Error('boom');
      },
      /threw: boom/,
    ],
    ['thenable', () => () => Promise.resolve({ ok: true }), /thenable/],
    ['malformed', () => () => ({ fine: true }), /malformed/],
    ['refusing', () => () => ({ ok: false, reasons: ['nope'] }), /nope/],
  ];
  for (const [name, make, why] of cases) {
    it(name, async () => {
      const s = setup();
      s.hooks.guard = make as never;
      s.add({ approvalId: 'a1', signalId: 's1' });
      if (name === 'missing') {
        // refused already at the first gate: no reservation is ever made
        const r = await s.gateway.execute('a1');
        expect(r.outcome).toBe('REJECTED');
        expect(reasons(r)).toMatch(why);
        expect(s.submit).not.toHaveBeenCalled();
        expect((await s.store.accountExposure('acct-a')).reservations).toHaveLength(0);
        return;
      }
      await refusedSafely(s, why);
    });
  }

  it('a guard refusal whose reservation cannot be released keeps the reservation for reconciliation', async () => {
    const s = setup();
    s.hooks.guard = (() => () => ({ ok: false, reasons: ['stale'] })) as never;
    s.add({ approvalId: 'a1', signalId: 's1' });
    s.store.releaseUntransmitted = () => Promise.reject(new Error('db down'));
    const r = await s.gateway.execute('a1');
    expect(r.outcome).toBe('REJECTED');
    expect(reasons(r)).toMatch(/reservation kept until reconciliation: db down/);
    expect(s.submit).not.toHaveBeenCalled();
    expect((await s.store.accountExposure('acct-a')).reservations).toHaveLength(1);
  });
});
