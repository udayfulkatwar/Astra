import { ManualClock } from '@astra/core';
import { describe, expect, it } from 'vitest';
import { KillSwitchRegistry } from '../src/kill-switch';

const human = { type: 'HUMAN' as const, id: 'owner' };
const system = { type: 'SYSTEM' as const, id: 'halt-monitor' };

function loaded() {
  const clock = new ManualClock('2026-09-28T14:00:00Z');
  const r = new KillSwitchRegistry(clock);
  r.load([]);
  return { r, clock };
}

describe('KillSwitchRegistry', () => {
  it('blocks everything until persisted state is loaded (fail-closed)', () => {
    const r = new KillSwitchRegistry(new ManualClock('2026-09-28T14:00:00Z'));
    const e = r.evaluate({ accountId: 'a' });
    expect(e.blocked).toBe(true);
    expect(e.loaded).toBe(false);
  });

  it('allows when loaded and nothing is active', () => {
    expect(loaded().r.evaluate({ accountId: 'a', strategyId: 's', symbol: 'NQ' }).blocked).toBe(
      false,
    );
  });

  it.each([
    ['GLOBAL', null, {}],
    ['ACCOUNT', 'a', { accountId: 'a' }],
    ['STRATEGY', 's', { strategyId: 's' }],
    ['INSTRUMENT', 'NQ', { symbol: 'NQ' }],
    ['EXECUTION', null, { accountId: 'a' }],
    ['EXECUTION', 'a', { accountId: 'a' }],
    ['NEWS', null, { symbol: 'NQ' }],
    ['NEWS', 'NQ', { symbol: 'NQ' }],
    ['AI', null, { requiresAi: true }],
  ] as const)('%s(%s) blocks a matching candidate', (scope, target, ctx) => {
    const { r } = loaded();
    r.activate({ scope, target, reason: 'test', actor: human });
    expect(r.evaluate(ctx).blocked).toBe(true);
  });

  it('isolates accounts, strategies and instruments', () => {
    const { r } = loaded();
    r.activate({ scope: 'ACCOUNT', target: 'a', reason: 'x', actor: human });
    r.activate({ scope: 'STRATEGY', target: 's1', reason: 'x', actor: human });
    r.activate({ scope: 'INSTRUMENT', target: 'NQ', reason: 'x', actor: human });
    r.activate({ scope: 'EXECUTION', target: 'a', reason: 'x', actor: human });
    expect(r.evaluate({ accountId: 'b', strategyId: 's2', symbol: 'ES' }).blocked).toBe(false);
  });

  it('the AI switch only blocks candidates that require AI', () => {
    const { r } = loaded();
    r.activate({ scope: 'AI', target: null, reason: 'x', actor: human });
    expect(r.evaluate({ requiresAi: false }).blocked).toBe(false);
  });

  it('validates targets per scope', () => {
    const { r } = loaded();
    expect(() =>
      r.activate({ scope: 'ACCOUNT', target: null, reason: 'x', actor: human }),
    ).toThrow();
    expect(() => r.activate({ scope: 'GLOBAL', target: 'a', reason: 'x', actor: human })).toThrow();
  });

  it('deactivation is planned, not applied, until the caller persists it', () => {
    const { r } = loaded();
    r.activate({ scope: 'GLOBAL', target: null, reason: 'x', actor: human });
    const change = r.planDeactivation({
      scope: 'GLOBAL',
      target: null,
      reason: 'resolved',
      actor: human,
    });
    expect(r.evaluate({}).blocked).toBe(true);
    r.apply(change);
    expect(r.evaluate({}).blocked).toBe(false);
  });

  it('the system cannot clear a MANUAL switch', () => {
    const { r } = loaded();
    r.activate({ scope: 'ACCOUNT', target: 'a', reason: 'breach', actor: system });
    expect(() =>
      r.planDeactivation({ scope: 'ACCOUNT', target: 'a', reason: 'x', actor: system }),
    ).toThrow(/human/);
  });

  it('the system clears NEXT_TRADING_DAY switches only once due', () => {
    const { r, clock } = loaded();
    r.activate({
      scope: 'ACCOUNT',
      target: 'a',
      reason: 'daily loss',
      actor: system,
      clearPolicy: 'NEXT_TRADING_DAY',
      autoClearAt: '2026-09-28T21:00:00Z',
    });
    expect(r.dueForAutoClear()).toHaveLength(0);
    expect(() =>
      r.planDeactivation({ scope: 'ACCOUNT', target: 'a', reason: 'x', actor: system }),
    ).toThrow();
    clock.set('2026-09-28T21:00:01Z');
    expect(r.dueForAutoClear()).toHaveLength(1);
    r.apply(
      r.planDeactivation({
        scope: 'ACCOUNT',
        target: 'a',
        reason: 'new trading day',
        actor: system,
      }),
    );
    expect(r.evaluate({ accountId: 'a' }).blocked).toBe(false);
  });

  it('restores persisted state on load (restart recovery)', () => {
    const { r } = loaded();
    r.activate({ scope: 'GLOBAL', target: null, reason: 'x', actor: human });
    const r2 = new KillSwitchRegistry(new ManualClock('2026-09-28T15:00:00Z'));
    r2.load(r.list());
    expect(r2.evaluate({}).blocked).toBe(true);
  });
});
