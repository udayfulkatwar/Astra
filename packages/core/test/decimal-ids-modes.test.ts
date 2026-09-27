import { describe, expect, it } from 'vitest';
import { dec, floorToStep, ceilToStep, decMin, pct } from '../src/decimal';
import { newId, uuidv7 } from '../src/ids';
import { MODE_POLICIES } from '../src/modes';
import { worstHealth } from '../src/health';

describe('decimal helpers', () => {
  it('avoids binary float drift', () => {
    expect(dec(0.1).plus(0.2).eq(0.3)).toBe(true);
  });

  it('never rounds quantities up', () => {
    expect(floorToStep(dec('0.999999999'), dec(1)).toNumber()).toBe(0);
    expect(floorToStep(dec('2.379'), dec('0.01')).toString()).toBe('2.37');
    expect(ceilToStep(dec('2.371'), dec('0.01')).toString()).toBe('2.38');
  });

  it('rejects non-finite input', () => {
    expect(() => dec(Number.NaN)).toThrow();
    expect(() => dec(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('computes min and percentages', () => {
    expect(decMin(dec(3), dec(1), dec(2)).toNumber()).toBe(1);
    expect(pct(dec(25), dec(200))!.toNumber()).toBe(12.5);
    expect(pct(dec(1), dec(0))).toBeNull();
  });
});

describe('ids', () => {
  it('produces RFC-shaped, time-ordered UUIDv7 values', () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });

  it('prefixes ids by kind', () => {
    expect(newId('decision')).toMatch(/^dec_/);
  });
});

describe('mode policies', () => {
  it('SHADOW never transmits orders and HALTED allows nothing', () => {
    expect(MODE_POLICIES.SHADOW.transmitsOrders).toBe(false);
    expect(MODE_POLICIES.HALTED.newTradesAllowed).toBe(false);
    expect(MODE_POLICIES.HALTED.transmitsOrders).toBe(false);
  });

  it('only LIVE requires verified config and live data', () => {
    expect(MODE_POLICIES.LIVE.allowsUnverifiedConfig).toBe(false);
    expect(MODE_POLICIES.LIVE.acceptedDataSources).toEqual(['LIVE']);
    expect(MODE_POLICIES.SHADOW.acceptedDataSources).toEqual(['LIVE']);
  });
});

describe('worstHealth', () => {
  it('treats an empty set as UNKNOWN and ranks ERROR worst', () => {
    expect(worstHealth([])).toBe('UNKNOWN');
    expect(worstHealth(['ONLINE', 'DEGRADED'])).toBe('DEGRADED');
    expect(worstHealth(['ONLINE', 'UNKNOWN', 'DEGRADED'])).toBe('UNKNOWN');
    expect(worstHealth(['UNKNOWN', 'ERROR'])).toBe('ERROR');
  });
});
