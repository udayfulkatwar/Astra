/**
 * R004 — `unknown()` reports the ACTUAL persistence outcome: a lost UNKNOWN/evidence/halt write is
 * never presented as recorded (the DIRTY session marker covers the restart).
 */
import { describe, expect, it, vi } from 'vitest';
import { InMemoryExecutionStore } from '../src/memory-store';
import type { BrokerAdapter } from '../src/types';
import { decide, instrument, makeBroker, makeGateway, makeWorld } from './gate-world';

function setup(onUnknown?: (a: string, c: string, r: string) => Promise<void>) {
  const w = makeWorld();
  const store = new InMemoryExecutionStore();
  const paper = makeBroker(w);
  paper.failures.failNextSubmit = true; // the submit errors: the outcome is unknown
  const broker: BrokerAdapter = instrument(w, paper);
  const gateway = makeGateway(w, store, broker, onUnknown ? { onExecutionUnknown: onUnknown } : {});
  const d = decide(w, { approvalId: 'a1', signalId: 's1' });
  store.addApproval(d.approval);
  return { store, gateway, paper };
}

describe('unknown() persistence outcome', () => {
  it('reports lost UNKNOWN/evidence and halt writes; the reservation is kept', async () => {
    const s = setup(() => Promise.reject(new Error('kill switch write down')));
    const real = s.store.updateOrder.bind(s.store);
    s.store.updateOrder = vi.fn(async (id, st) => {
      if (st.status === 'UNKNOWN') throw new Error('orders write down');
      return real(id, st);
    });
    const r = await s.gateway.execute('a1');
    expect(r.outcome).toBe('UNKNOWN');
    expect(r.reasons.join()).toMatch(/UNKNOWN state\/evidence NOT recorded \(orders write down\)/);
    expect(r.reasons.join()).toMatch(/execution halt NOT persisted \(kill switch write down\)/);
    expect((await s.store.accountExposure('acct-a')).reservations).toHaveLength(1);
  });

  it('a fully recorded unknown outcome carries no persistence warning', async () => {
    const s = setup();
    const r = await s.gateway.execute('a1');
    expect(r.outcome).toBe('UNKNOWN');
    expect(r.reasons.join()).not.toMatch(/NOT recorded|NOT persisted/);
  });
});
