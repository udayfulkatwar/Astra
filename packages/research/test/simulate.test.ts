import { resolve } from 'node:path';
import { decisionConfigView, loadAstraConfig } from '@astra/config';
import { DEFAULT_MONITOR_POLICY, DEFAULT_PROTECTION_POLICY } from '@astra/risk';
import { describe, expect, it } from 'vitest';
import { HOUR, M15, h1Path, split as splitM5, type Ohlc } from '../../strategy-lsfvg/test/helpers';
import {
  NO_COSTS,
  REALISTIC_COSTS,
  pairSides,
  runResearch,
  type ResearchBar,
  type ResearchEnvironment,
} from '../src';

const config = loadAstraConfig(resolve(import.meta.dirname, '../../../config'));
const env: ResearchEnvironment = {
  config: decisionConfigView(config),
  instruments: config.instruments,
  monitorPolicy: config.system.monitors.positions ?? DEFAULT_MONITOR_POLICY,
  protectionPolicy: config.system.protection ?? DEFAULT_PROTECTION_POLICY,
  lateObservationThresholdMs: config.system.tracking.lateObservationThresholdMs,
};

const START = Date.parse('2026-03-03T00:00:00Z'); // Tuesday
const H1 = h1Path([
  [0, 1.095],
  [4, 1.09],
  [9, 1.098],
  [14, 1.094],
  [19, 1.105],
  [24, 1.101],
]);
// The engine test's setup (FVG 1.1000–1.1012, entry 1.1006 at 03:00Z on Wednesday) …
const SETUP: Ohlc[] = [
  { o: 1.101, h: 1.1014, l: 1.1006, c: 1.1008 },
  { o: 1.1008, h: 1.101, l: 1.1, c: 1.1002 },
  { o: 1.1002, h: 1.1004, l: 1.099, c: 1.0994 },
  { o: 1.0994, h: 1.1003, l: 1.0993, c: 1.1001 },
  { o: 1.1001, h: 1.1008, l: 1.0998, c: 1.1006 },
  { o: 1.1006, h: 1.1016, l: 1.1004, c: 1.1012 },
  { o: 1.1012, h: 1.102, l: 1.1009, c: 1.1011 },
  { o: 1.1011, h: 1.1013, l: 1.1003, c: 1.1004 },
  { o: 1.1004, h: 1.1006, l: 1.0996, c: 1.0998 },
  { o: 1.0998, h: 1.1, l: 1.0985, c: 1.0995 },
  { o: 1.0995, h: 1.103, l: 1.0993, c: 1.1028 },
  { o: 1.1028, h: 1.1035, l: 1.1012, c: 1.103 },
];
// … then a retrace through the midpoint and a rally beyond the 2R target (≈ 1.1050).
const AFTER: Ohlc[] = [
  { o: 1.103, h: 1.1031, l: 1.1003, c: 1.1008 },
  { o: 1.1008, h: 1.1025, l: 1.1007, c: 1.1022 },
  { o: 1.1022, h: 1.1055, l: 1.1021, c: 1.1052 },
  { o: 1.1052, h: 1.1054, l: 1.1049, c: 1.1051 },
];

function data(): Map<string, ResearchBar[]> {
  const m5 = [];
  let t = START;
  for (const x of H1) {
    m5.push(...splitM5(t, x, 12));
    t += HOUR;
  }
  for (const x of [...SETUP, ...AFTER]) {
    m5.push(...splitM5(t, x, 3));
    t += M15;
  }
  const bars = m5.map((c) => ({
    t: Date.parse(c.openTime),
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
  }));
  // Mid prices from the scenario, 0.5-pip assumed spread around them.
  return new Map([['EURUSD', pairSides({ side: 'MID', bars }, null, 0.00001, 5)]]);
}

const run = (overrides: Partial<Parameters<typeof runResearch>[0]> = {}) =>
  runResearch({
    env,
    accountId: 'paper-fx',
    strategyId: 'lsfvg-a',
    data: data(),
    costs: REALISTIC_COSTS,
    calendar: { kind: 'NOT_MODELLED' },
    from: '2026-03-03T00:00:00Z',
    to: '2026-03-05T00:00:00Z',
    ...overrides,
  });

describe('research replay (real engine, real gate, pessimistic broker)', () => {
  it('trades the setup: LIMIT at the midpoint, filled on the retrace, closed at the 2R target', async () => {
    const r = await run();
    expect(r.gate).toMatchObject({ setups: 1, approved: 1, filled: 1, missed: 0 });
    expect(r.trades).toHaveLength(1);
    const [t] = r.trades;
    expect(t).toMatchObject({
      symbol: 'EURUSD',
      direction: 'LONG',
      entry: 1.1006,
      exitReason: 'TARGET',
      liquidity: 'SWING_LOW',
      structure: 'BOS',
    });
    expect(t!.exit).toBe(t!.target);
    // Net of the $7/lot commission the trade is a little under 2R.
    expect(t!.r).toBeGreaterThan(1.9);
    expect(t!.r).toBeLessThan(2);
    // Risk was sized by the gate: 0.25 % of $50,000.
    expect(t!.riskMoney).toBeLessThanOrEqual(125);
    expect(r.records.find((x) => x.DECISION === 'TRADE')).toMatchObject({ PAIR: 'EURUSD' });
    expect(r.calendar.kind).toBe('NOT_MODELLED');
    expect(r.endingBalance).toBeGreaterThan(r.startingBalance);
  });

  it('before costs (mid prices, no commission) the same trade is exactly the planned R', async () => {
    const r = await run({ costs: NO_COSTS });
    expect(r.trades[0]!.r).toBeCloseTo(2, 1);
    expect(r.trades[0]!.commission).toBe(0);
  });

  it('a limit never reached is MISSED — no trade', async () => {
    const d = data();
    const bars = d.get('EURUSD')!;
    // Remove the retrace: after the setup the price only rises.
    const setupEnd = Date.parse('2026-03-04T03:00:00Z');
    const kept = bars.filter((b) => b.t < setupEnd);
    let t = setupEnd;
    for (let k = 0; k < 24; k++) {
      const p = 1.1032 + k * 0.0001;
      kept.push(
        ...pairSides(
          { side: 'MID', bars: [{ t, o: p, h: p + 0.0002, l: p - 0.0001, c: p + 0.0001 }] },
          null,
          0.00001,
          5,
        ),
      );
      t += 300_000;
    }
    const r = await run({ data: new Map([['EURUSD', kept]]) });
    expect(r.gate).toMatchObject({ approved: 1, filled: 0, missed: 1 });
    expect(r.trades).toEqual([]);
  });

  it('candles before the window only warm the engines up', async () => {
    const r = await run({ from: '2026-03-04T06:00:00Z' });
    expect(r.gate.setups).toBe(0);
    expect(r.trades).toEqual([]);
    expect(r.funnel.EURUSD!.setups).toBe(1); // the engine saw it; nothing was traded on it
  });

  it('refuses a strategy that is not an lsfvg engine or not on the account', async () => {
    await expect(run({ strategyId: 'paper-pipeline-test' })).rejects.toThrow('not an lsfvg-v1');
    await expect(run({ strategyId: 'lsfvg-b' })).rejects.toThrow('not enabled for account');
  });
});
