import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  applyFreshness,
  notObserved,
  observeWithTimeout,
  observed,
  validateObserved,
} from '../src/observed';

const now = new Date('2026-09-28T14:00:00.000Z');
const policy = { maxAgeMs: 5_000, maxFutureSkewMs: 1_000 };
const meta = { source: 'test-feed', sourceKind: 'LIVE' as const };

describe('applyFreshness', () => {
  it('keeps a fresh observation OK', () => {
    const o = observed(1, { ...meta, asOf: '2026-09-28T13:59:57.000Z' });
    expect(applyFreshness(o, now, policy).status).toBe('OK');
  });

  it('marks an old observation STALE', () => {
    const o = observed(1, { ...meta, asOf: '2026-09-28T13:59:50.000Z' });
    const r = applyFreshness(o, now, policy);
    expect(r.status).toBe('STALE');
  });

  it('marks a timestamp beyond the future skew INVALID', () => {
    const o = observed(1, { ...meta, asOf: '2026-09-28T14:00:05.000Z' });
    expect(applyFreshness(o, now, policy).status).toBe('INVALID');
  });

  it('tolerates small future skew', () => {
    const o = observed(1, { ...meta, asOf: '2026-09-28T14:00:00.500Z' });
    expect(applyFreshness(o, now, policy).status).toBe('OK');
  });

  it('marks an unparseable timestamp INVALID', () => {
    const o = observed(1, { ...meta, asOf: 'not-a-date' });
    expect(applyFreshness(o, now, policy).status).toBe('INVALID');
  });

  it('passes non-OK observations through unchanged', () => {
    const o = notObserved('UNAVAILABLE', 'feed down', 'test-feed');
    expect(applyFreshness(o, now, policy)).toBe(o);
  });
});

describe('validateObserved', () => {
  it('turns a schema violation into INVALID instead of coercing', () => {
    const o = observed<unknown>({ price: 'abc' }, { ...meta, asOf: now.toISOString() });
    const r = validateObserved(o, z.object({ price: z.number() }));
    expect(r.status).toBe('INVALID');
  });

  it('keeps valid values', () => {
    const o = observed<unknown>({ price: 1.5 }, { ...meta, asOf: now.toISOString() });
    const r = validateObserved(o, z.object({ price: z.number() }));
    expect(r).toMatchObject({ status: 'OK', value: { price: 1.5 } });
  });
});

describe('observeWithTimeout', () => {
  it('returns TIMEOUT when the provider does not answer in time', async () => {
    const r = await observeWithTimeout('slow', 20, () => new Promise<never>(() => undefined));
    expect(r.status).toBe('TIMEOUT');
  });

  it('returns ERROR when the provider throws', async () => {
    const r = await observeWithTimeout('broken', 1_000, () => Promise.reject(new Error('boom')));
    expect(r).toMatchObject({ status: 'ERROR', reason: 'boom' });
  });

  it('returns the provider result when it answers in time', async () => {
    const r = await observeWithTimeout('fast', 1_000, () =>
      Promise.resolve(observed(42, { ...meta, asOf: now.toISOString() })),
    );
    expect(r).toMatchObject({ status: 'OK', value: 42 });
  });

  it('aborts the provider signal on timeout', async () => {
    let aborted = false;
    await observeWithTimeout('slow', 10, (signal) => {
      signal.addEventListener('abort', () => (aborted = true));
      return new Promise<never>(() => undefined);
    });
    expect(aborted).toBe(true);
  });
});
