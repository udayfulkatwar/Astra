import { afterEach, describe, expect, it } from 'vitest';
import {
  renderReportText,
  reportDays,
  tradeTotals,
  windowForKey,
} from '../src/runtime/report-service';
import { H, bringOnline, candidate, createHarness, dbAvailable, type Harness } from './harness';

const available = await dbAvailable();
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type Json = Record<string, any>;
const json = (r: { body: string }) => JSON.parse(r.body) as Json;
const get = async (harness: Harness, url: string, headers = H.automation) =>
  json(await harness.app.inject({ url, headers }));
const NY = { timeZone: 'America/New_York', time: '17:00' };

describe('report periods', () => {
  it('maps trading-day keys to the firm’s windows (DST-aware)', () => {
    const mon = windowForKey('2026-09-28', NY); // EDT: 17:00 NY = 21:00Z
    expect(mon.start.toISOString()).toBe('2026-09-27T21:00:00.000Z');
    expect(mon.end.toISOString()).toBe('2026-09-28T21:00:00.000Z');
    const winter = windowForKey('2026-12-01', NY); // EST: 22:00Z
    expect(winter.start.toISOString()).toBe('2026-11-30T22:00:00.000Z');
    const midnight = windowForKey('2026-09-28', { timeZone: 'Europe/Prague', time: '00:00' });
    expect(midnight.start.toISOString()).toBe('2026-09-27T22:00:00.000Z');
    expect(() => windowForKey('2026-13-40', NY)).toThrow();
  });

  it('defaults to the last completed trading day; weekly is Monday…Sunday', () => {
    const afterClose = new Date('2026-09-28T21:05:00Z'); // Mon 17:05 NY
    expect(reportDays('DAILY', afterClose, NY)).toEqual(['2026-09-28']);
    expect(reportDays('DAILY', afterClose, NY, 'current')).toEqual(['2026-09-29']);
    expect(reportDays('WEEKLY', new Date('2026-10-02T21:05:00Z'), NY)).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
  });

  it('totals trades and renders plain text', () => {
    const t = tradeTotals([]);
    expect(t).toMatchObject({ count: 0, pnl: 0, avgR: null });
    const text = renderReportText({
      kind: 'DAILY',
      generatedAt: '2026-09-28T21:05:00.000Z',
      mode: 'PAPER',
      simulation: true,
      from: '2026-09-27T21:00:00.000Z',
      to: '2026-09-28T21:00:00.000Z',
      accounts: [
        {
          accountId: 'paper-demo',
          name: 'Paper demo',
          currency: 'USD',
          profileId: 'template-static-50k',
          ownerVerified: false,
          period: { days: ['2026-09-28'], from: '', to: '' },
          trades: t,
          decisions: {
            approved: 0,
            rejected: 2,
            topRejectChecks: [{ check: 'news.risk', count: 2 }],
          },
          now: null,
        },
      ],
      ai: { sent: 0, blocked: 0, failed: 0, costUsd: 0, analyses: 0, reviews: 0 },
      system: {
        warn: 1,
        error: 0,
        critical: 0,
        incidents: [],
        killSwitches: [],
        componentsNotOnline: [],
      },
    });
    expect(text).toContain('ASTRA daily report — trading day 2026-09-28 (PAPER, SIMULATED feeds)');
    expect(text).toContain('TEMPLATE/UNVERIFIED config');
    expect(text).toContain('Gate: 0 approved, 2 rejected (most common: news.risk 2)');
    expect(text).toContain('account state unknown');
  });
});

describe.skipIf(!available)('API — reports and alert polling', () => {
  it('reports the day from the records: trades, gate decisions, AI and system events', async () => {
    h = await createHarness();
    await bringOnline(h);
    // One approved and executed trade that hits its target, one rejected candidate.
    const ok = json(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/decisions/evaluate',
        headers: H.automation,
        payload: { candidate: candidate(h), autoExecute: true },
      }),
    );
    expect(ok.execution.outcome).toBe('CONFIRMED');
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/decisions/evaluate',
      headers: H.automation,
      payload: { candidate: candidate(h, { target: 20_000.5 }) }, // R:R far below 1.5
    });
    await h.runtime.cycle();
    h.clock.advance(30_000);
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/market/quotes',
      headers: H.automation,
      payload: {
        source: 'test',
        quotes: [{ symbol: 'MNQ', bid: 20_021, ask: 20_021.25, asOf: h.clock.now().toISOString() }],
      },
    });
    await h.runtime.cycle();

    const r = await get(h, '/api/v1/reports?kind=daily&day=current');
    expect(r).toMatchObject({ kind: 'DAILY', mode: 'PAPER', simulation: false });
    const a = r.accounts[0];
    expect(a).toMatchObject({
      accountId: 'paper-demo',
      ownerVerified: false,
      period: { days: ['2026-09-28'] },
      trades: { count: 1, wins: 1, losses: 0 },
      decisions: { approved: 1, rejected: 1 },
    });
    expect(a.decisions.topRejectChecks[0].check).toBe('risk.capital-preservation');
    expect(a.trades.totalR).toBeGreaterThan(1.5);
    expect(a.now.equity).toBeGreaterThan(50_000);
    expect(r.text).toContain('Trades 1: 1 won, 0 lost');
    expect(r.text).toContain('Gate: 1 approved, 1 rejected');

    const week = await get(h, '/api/v1/reports?kind=weekly&day=current');
    expect(week.accounts[0].period.days).toHaveLength(7);
    expect(week.accounts[0].trades.count).toBe(1);
    // The previous (completed) day is empty.
    expect((await get(h, '/api/v1/reports')).accounts[0].trades.count).toBe(0);
    expect(
      (await h.app.inject({ url: '/api/v1/reports?day=bad', headers: H.viewer })).statusCode,
    ).toBe(400);
  });

  it('serves events oldest-first after a cursor, filtered by level, for the alert poller', async () => {
    h = await createHarness();
    await h.runtime.events.emit({ level: 'INFO', component: 't', type: 'A', message: 'info' });
    await h.runtime.events.emit({ level: 'WARN', component: 't', type: 'B', message: 'warn' });
    await h.runtime.events.emit({ level: 'CRITICAL', component: 't', type: 'C', message: 'crit' });
    const all = (await get(h, '/api/v1/events?order=asc&limit=500')).events;
    const start = all.find((e: Json) => e.message === 'info').seq - 1;
    const { events } = await get(h, `/api/v1/events?afterSeq=${start}&order=asc&minLevel=WARN`);
    expect(events.map((e: Json) => e.message)).toEqual(['warn', 'crit']);
    const next = await get(h, `/api/v1/events?afterSeq=${events[1].seq}&order=asc&minLevel=WARN`);
    expect(next.events).toEqual([]);
    const desc = (await get(h, '/api/v1/events?limit=2')).events;
    expect(desc[0].seq).toBeGreaterThan(desc[1].seq);
  });
});
