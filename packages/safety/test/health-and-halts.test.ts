import { ManualClock, COMPONENT_IDS, type ComponentId } from '@astra/core';
import { describe, expect, it } from 'vitest';
import { evaluateAccountHaltConditions } from '../src/halt-conditions';
import { ComponentHealthRegistry } from '../src/health-registry';

const policies = Object.fromEntries(
  COMPONENT_IDS.map((c) => [c, { staleAfterMs: 60_000 }]),
) as Record<ComponentId, { staleAfterMs: number }>;

describe('ComponentHealthRegistry', () => {
  it('reports UNKNOWN for components that never reported', () => {
    const r = new ComponentHealthRegistry(new ManualClock('2026-09-28T14:00:00Z'), policies);
    expect(r.get('AUTOMATION').status).toBe('UNKNOWN');
    expect(r.overall()).toBe('UNKNOWN');
  });

  it('decays a silent component to UNKNOWN after its staleness limit', () => {
    const clock = new ManualClock('2026-09-28T14:00:00Z');
    const r = new ComponentHealthRegistry(clock, policies);
    r.report('AUTOMATION', 'ONLINE', 'heartbeat');
    expect(r.get('AUTOMATION').status).toBe('ONLINE');
    clock.advance(61_000);
    const h = r.get('AUTOMATION');
    expect(h.status).toBe('UNKNOWN');
    expect(h.lastOnlineAt).toBe('2026-09-28T14:00:00.000Z');
  });

  it('aggregates the worst status of required components', () => {
    const r = new ComponentHealthRegistry(new ManualClock('2026-09-28T14:00:00Z'), policies);
    r.report('DATABASE', 'ONLINE', 'ok');
    r.report('EXECUTION', 'DEGRADED', 'slow');
    expect(r.overall(['DATABASE', 'EXECUTION'])).toBe('DEGRADED');
    r.report('DATABASE', 'ERROR', 'down');
    expect(r.overall(['DATABASE', 'EXECUTION'])).toBe('ERROR');
  });
});

describe('evaluateAccountHaltConditions', () => {
  const base = {
    accountId: 'a',
    breached: false,
    dayLocked: false,
    nextTradingDayStart: '2026-09-28T21:00:00.000Z',
    unprotectedPositions: [],
  };

  it('no action when healthy', () => {
    expect(evaluateAccountHaltConditions(base)).toEqual([]);
  });

  it('daily lock auto-clears next trading day', () => {
    const [a] = evaluateAccountHaltConditions({ ...base, dayLocked: true });
    expect(a).toMatchObject({
      scope: 'ACCOUNT',
      clearPolicy: 'NEXT_TRADING_DAY',
      autoClearAt: base.nextTradingDayStart,
    });
  });

  it('breach and unprotected positions require manual clearing, merged into one action', () => {
    const actions = evaluateAccountHaltConditions({
      ...base,
      breached: true,
      dayLocked: true,
      unprotectedPositions: ['p1'],
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.clearPolicy).toBe('MANUAL');
    expect(actions[0]!.reason).toMatch(/breached.*without protective stop/);
  });
});
