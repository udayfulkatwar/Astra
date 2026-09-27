import { describe, expect, it } from 'vitest';
import { ago, money, pct, shortHash, utcTime } from './format';
import { toneOf } from './status';

describe('toneOf', () => {
  it('never maps an unrecognised or missing status to a good tone', () => {
    expect(toneOf(undefined)).toBe('unknown');
    expect(toneOf(null)).toBe('unknown');
    expect(toneOf('SOMETHING_NEW')).toBe('unknown');
  });

  it('maps the safety vocabularies consistently', () => {
    expect(toneOf('ONLINE')).toBe('ok');
    expect(toneOf('SAFE')).toBe('ok');
    expect(toneOf('CAUTION')).toBe('warn');
    expect(toneOf('RESTRICTED')).toBe('restricted');
    for (const bad of ['HALTED', 'BREACH_RISK', 'REJECTED', 'FAIL', 'ERROR', 'CRITICAL'])
      expect(toneOf(bad)).toBe('bad');
    for (const unknown of ['UNKNOWN', 'STALE', 'TIMEOUT', 'UNAVAILABLE', 'INVALID'])
      expect(toneOf(unknown)).toBe('unknown');
    expect(toneOf('LIVE')).toBe('live');
    expect(toneOf('SHADOW')).toBe('shadow');
  });
});

describe('format', () => {
  it('shows missing values as a dash, never as zero', () => {
    expect(money(null)).toBe('—');
    expect(money(undefined)).toBe('—');
    expect(pct(null)).toBe('—');
    expect(utcTime(null)).toBe('—');
  });

  it('formats money, percentages, times and hashes', () => {
    expect(money(-1234.5)).toBe('-$1,234.50');
    expect(pct(24.6789)).toBe('24.7%');
    expect(utcTime('2026-09-28T14:05:09.000Z')).toBe('14:05:09Z');
    expect(shortHash('sha256:abcdef0123456789')).toBe('abcdef0123');
  });

  it('describes ages relative to now', () => {
    const now = Date.parse('2026-09-28T14:00:00Z');
    expect(ago('2026-09-28T13:59:30Z', now)).toBe('30s ago');
    expect(ago('2026-09-28T13:00:00Z', now)).toBe('1h ago');
    expect(ago('2026-09-28T14:01:00Z', now)).toBe('in the future');
    expect(ago(null, now)).toBe('never');
  });
});
