/**
 * The standalone Python kit (packages/research/kit/lsfvg_kit.py) must compute exactly what ASTRA
 * computes: the same engine events, the same gate decisions, the same trades to the cent. Both
 * run here on the kit's synthetic TEST data (a seeded random walk — not market data): ASTRA through
 * its own loader, engine and research replay, the kit through `python3 lsfvg_kit.py parity`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decisionConfigView, loadAstraConfig } from '@astra/config';
import { DEFAULT_MONITOR_POLICY, DEFAULT_PROTECTION_POLICY } from '@astra/risk';
import {
  LsfvgEngine,
  MAX_SCORE,
  type LsfvgCounters,
  type LsfvgEvent,
  type LsfvgSetup,
} from '@astra/strategy-lsfvg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NO_COSTS,
  REALISTIC_COSTS,
  coverage,
  loadSide,
  mid,
  pairSides,
  runResearch,
  type CostModel,
  type ResearchBar,
  type ResearchEngine,
  type ResearchEnvironment,
  type ResearchRun,
} from '../src';

const KIT = resolve(import.meta.dirname, '../kit/lsfvg_kit.py');
const config = loadAstraConfig(resolve(import.meta.dirname, '../../../config'));
const env: ResearchEnvironment = {
  config: decisionConfigView(config),
  instruments: config.instruments,
  monitorPolicy: config.system.monitors.positions ?? DEFAULT_MONITOR_POLICY,
  protectionPolicy: config.system.protection ?? DEFAULT_PROTECTION_POLICY,
  lateObservationThresholdMs: config.system.tracking.lateObservationThresholdMs,
};
const FROM = '2026-01-19T00:00:00.000Z';
const TO = '2026-03-16T00:00:00.000Z';
const SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY'] as const;
const MODELS = [
  { model: 'A', strategyId: 'lsfvg-a', accountId: 'paper-fx' },
  { model: 'B', strategyId: 'lsfvg-b', accountId: 'paper-fx-b' },
] as const;

const python = (...args: string[]) =>
  execFileSync('python3', [KIT, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });

interface KitRun {
  trades: Record<string, unknown>[];
  gate: Record<string, number>;
  blockedBy: Record<string, number>;
  endingBalance: number;
  protectiveCloses: number;
}
interface KitModel {
  funnel: Record<string, Record<string, number>>;
  events: Record<string, unknown>[];
  runs: Record<'after' | 'before' | 'spread2' | 'wait6', KitRun>;
}
interface KitParity {
  coverage: unknown[];
  models: Record<'A' | 'B', KitModel>;
}

let dir: string;
let data: Map<string, ResearchBar[]>;
let kit: KitParity;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'astra-kit-'));
  python('synthetic', '--out', dir);
  data = new Map();
  for (const symbol of SYMBOLS) {
    const side = (name: string) =>
      loadSide([{ name, text: readFileSync(join(dir, name), 'utf8') }], { format: 'dukascopy' })
        .bars;
    const lower = symbol.toLowerCase();
    data.set(
      symbol,
      pairSides(
        { side: 'BID', bars: side(`${lower}-bid.csv`) },
        side(`${lower}-ask.csv`),
        config.instruments.get(symbol)!.tickSize,
        8,
      ),
    );
  }
  kit = JSON.parse(
    python('parity', '--manifest', join(dir, 'manifest.json'), '--from', FROM, '--to', TO),
  ) as KitParity;
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** An engine event in the kit's shape. */
function comparable(symbol: string, index: number, e: LsfvgEvent): Record<string, unknown> {
  if (e.kind === 'INVALIDATED')
    return { symbol, index, kind: e.kind, setupId: e.setupId, at: Date.parse(e.at) };
  const s = e.kind === 'SETUP' ? e.setup : e.rejection.partial;
  const base = {
    symbol,
    index,
    kind: e.kind,
    direction: s.direction,
    model: s.model,
    detectedAt: Date.parse(s.detectedAt),
    liquidity: s.liquidity.name,
    liquidityPrice: s.liquidity.price,
    strong: s.liquidity.strong,
    structure: s.structure.kind,
    sweepExtreme: s.sweep.extreme,
    fvgLow: s.fvg.low,
    fvgHigh: s.fvg.high,
    bias: s.h1Bias.bias,
  };
  if (e.kind === 'REJECTED') return { ...base, stage: e.rejection.stage };
  const x = e.setup;
  return {
    ...base,
    id: x.id,
    expiresAt: Date.parse(x.expiresAt),
    entry: x.entry,
    stop: x.stop,
    target: x.target,
    targetSource: x.targetSource,
    rewardToRisk: x.rewardToRisk,
    atrM5: x.atrM5,
    score: x.score.total,
  };
}

const ZERO_COUNTERS: LsfvgCounters = {
  m5Candles: 0,
  m15Candles: 0,
  sweeps: 0,
  reclaims: 0,
  displacements: 0,
  fvgs: 0,
  noFvg: 0,
  setups: 0,
  rejectedBias: 0,
  rejectedTarget: 0,
  rejectedRewardToRisk: 0,
  rejectedData: 0,
  invalidated: 0,
};

/** An engine that emits scripted events at given candle indices. */
class ScriptedEngine implements ResearchEngine {
  readonly counters = { ...ZERO_COUNTERS };
  private i = 0;
  constructor(private readonly events: ReadonlyMap<number, LsfvgEvent[]>) {}
  onM5(): LsfvgEvent[] {
    return this.events.get(this.i++) ?? [];
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LEVELS = [
  ['PDL', 'PREVIOUS_DAY', true],
  ['ASIAN_LOW', 'ASIAN', true],
  ['EQUAL_LOWS', 'EQUAL', false],
  ['SWING_LOW', 'SWING', false],
] as const;

/**
 * Dense scripted setups on the synthetic candles: about one in 16 candles per pair, LIMIT entries
 * near the market, 5–25 pip stops, 2–3R targets, 30 min – 2 h windows, a fifth invalidated early.
 */
function script(): {
  perIndex: Map<string, Map<number, LsfvgEvent[]>>;
  json: Record<string, unknown>[];
} {
  const next = mulberry32(99);
  const perIndex = new Map<string, Map<number, LsfvgEvent[]>>();
  const json: Record<string, unknown>[] = [];
  for (const symbol of SYMBOLS) {
    const tick = config.instruments.get(symbol)!.tickSize;
    const bars = data.get(symbol)!;
    const at = new Map<number, LsfvgEvent[]>();
    const px = (ticks: number) => Number((ticks * tick).toFixed(10));
    const plan: { index: number; event: LsfvgEvent; row: Record<string, unknown> }[] = [];
    bars.forEach((bar, i) => {
      if (next() >= 0.06) return;
      const long = next() < 0.5;
      const sign = long ? 1 : -1;
      const e = Math.round(mid(bar).c / tick) - sign * Math.floor(next() * 80);
      // Mostly 5–25 pip stops; some 40–140 pips (positions that live into the weekly close).
      const d = next() < 0.15 ? 400 + Math.floor(next() * 1000) : 50 + Math.floor(next() * 200);
      const rr = [2, 2.5, 3][Math.floor(next() * 3)]!;
      const wait = [6, 12, 24][Math.floor(next() * 3)]!;
      const [name, type, strong] = LEVELS[Math.floor(next() * LEVELS.length)]!;
      const structure = next() < 0.5 ? ('CHOCH' as const) : ('BOS' as const);
      const detected = bar.t + 300_000;
      const direction = long ? ('LONG' as const) : ('SHORT' as const);
      const setup: LsfvgSetup = {
        id: `${symbol}-${direction}-${new Date(detected).toISOString()}`,
        symbol,
        direction,
        model: 'A',
        detectedAt: new Date(detected).toISOString(),
        expiresAt: new Date(detected + wait * 300_000).toISOString(),
        h1Bias: {
          bias: long ? 'BULLISH' : 'BEARISH',
          reason: 'scripted',
          swings: { previous: null, last: null, pivot: null, before: null },
        },
        liquidity: {
          type,
          side: long ? 'SELL_SIDE' : 'BUY_SIDE',
          price: px(e - sign * d),
          formedAt: new Date(bar.t).toISOString(),
          name,
          strong,
        },
        sweptLevels: [],
        sweep: {
          candleTime: new Date(bar.t).toISOString(),
          extreme: px(e - sign * d),
          reclaimedAt: '',
        },
        structure: { kind: structure, swingPrice: px(e), swingTime: '', brokenAt: '' },
        displacement: {
          candleTime: '',
          body: 0,
          range: 0,
          atrM15: 0,
          bodyToRange: 0,
          bodyToAtr: 0,
        },
        fvg: { low: px(e - 5), high: px(e + 5), c1Time: '', c3Time: '' },
        entry: px(e),
        stop: px(e - sign * d),
        target: px(e + sign * Math.ceil(rr * d)),
        targetSource: 'FIXED_2R',
        rewardToRisk: rr,
        atrM5: 0,
        score: {
          total: 10 + Math.floor(next() * 7),
          max: MAX_SCORE,
          retracePending: true,
          components: {
            h1Bias: 2,
            strongLiquidity: 0,
            sweep: 3,
            structure: 3,
            displacement: 2,
            fvg: 2,
            retrace: 0,
            rewardToRisk: 2,
          },
        },
        rationale: ['scripted'],
      };
      plan.push({
        index: i,
        event: { kind: 'SETUP', setup },
        row: {
          kind: 'SETUP',
          symbol,
          index: i,
          id: setup.id,
          direction,
          entry: setup.entry,
          stop: setup.stop,
          target: setup.target,
          detectedAt: detected,
          expiresAt: detected + wait * 300_000,
          liquidity: name,
          strong,
          structure,
          score: setup.score.total,
        },
      });
      if (next() < 0.2) {
        const later = i + 1 + Math.floor(next() * wait);
        plan.push({
          index: later,
          event: { kind: 'INVALIDATED', setupId: setup.id, at: '', reason: 'scripted' },
          row: { kind: 'INVALIDATED', symbol, index: later, setupId: setup.id },
        });
      }
    });
    // Per candle: invalidations first, then the setup (the engine's order).
    plan.sort(
      (a, b) =>
        a.index - b.index ||
        (a.event.kind === 'INVALIDATED' ? 0 : 1) - (b.event.kind === 'INVALIDATED' ? 0 : 1),
    );
    for (const p of plan) {
      at.set(p.index, [...(at.get(p.index) ?? []), p.event]);
      json.push(p.row);
    }
    perIndex.set(symbol, at);
  }
  return { perIndex, json };
}

function astraRun(
  m: (typeof MODELS)[number],
  costs: CostModel,
  paramOverrides = {},
): Promise<ResearchRun> {
  return runResearch({
    env,
    accountId: m.accountId,
    strategyId: m.strategyId,
    data,
    costs,
    calendar: { kind: 'NOT_MODELLED' },
    from: FROM,
    to: TO,
    paramOverrides,
  });
}

function sameRun(astra: ResearchRun, k: KitRun): void {
  expect(k.trades).toEqual(astra.trades);
  const { blockedBy, ...gate } = astra.gate;
  expect(k.gate).toEqual(gate);
  expect(k.blockedBy).toEqual(Object.fromEntries(blockedBy.map((b) => [b.checkId, b.count])));
  expect(k.endingBalance).toBe(astra.endingBalance);
  expect(k.protectiveCloses).toBe(astra.protectiveCloses);
}

describe('the Python kit computes exactly what ASTRA computes', () => {
  it('reads the same candles', () => {
    expect(kit.coverage).toEqual(SYMBOLS.map((s) => coverage(s, data.get(s)!)));
  });

  for (const m of MODELS) {
    it(`Model ${m.model}: the same engine events (setups, rejections, invalidations)`, () => {
      const params = config.strategies.get(m.strategyId)!.rules.params as { model: 'A' | 'B' };
      const events: Record<string, unknown>[] = [];
      const funnel: Record<string, unknown> = {};
      for (const symbol of SYMBOLS) {
        const engine = new LsfvgEngine(symbol, config.instruments.get(symbol)!.tickSize, params);
        data.get(symbol)!.forEach((bar, i) => {
          const x = mid(bar);
          for (const e of engine.onM5({
            openTime: new Date(bar.t).toISOString(),
            closeTime: new Date(bar.t + 300_000).toISOString(),
            open: x.o,
            high: x.h,
            low: x.l,
            close: x.c,
          }))
            events.push(comparable(symbol, i, e));
        });
        funnel[symbol] = engine.counters;
      }
      const kitEvents = kit.models[m.model].events;
      expect(events.filter((e) => e.kind === 'SETUP').length).toBeGreaterThan(10);
      expect(kitEvents).toEqual(events);
      expect(kit.models[m.model].funnel).toEqual(funnel);
    });

    it(`Model ${m.model}: the same trades after costs, before costs and under sensitivity`, async () => {
      const runs = kit.models[m.model].runs;
      const after = await astraRun(m, REALISTIC_COSTS);
      expect(after.trades.length).toBeGreaterThan(5);
      sameRun(after, runs.after);
      sameRun(await astraRun(m, NO_COSTS), runs.before);
      sameRun(await astraRun(m, { ...REALISTIC_COSTS, spreadMultiplier: 2 }), runs.spread2);
      sameRun(await astraRun(m, REALISTIC_COSTS, { entryWaitM5Candles: 6 }), runs.wait6);
    }, 120_000);
  }

  it('scripted setups (dense: every owner limit, fill rule and the weekend close) — the same trades', async () => {
    const { perIndex, json } = script();
    const file = join(dir, 'script.json');
    writeFileSync(file, JSON.stringify(json));
    const k = JSON.parse(
      python(
        'parity',
        '--manifest',
        join(dir, 'manifest.json'),
        '--from',
        FROM,
        '--to',
        TO,
        '--events',
        file,
      ),
    ) as { runs: Record<'after' | 'spread2', KitRun> };
    const scripted = (costs: CostModel) =>
      runResearch({
        env,
        accountId: 'paper-fx',
        strategyId: 'lsfvg-a',
        data,
        costs,
        calendar: { kind: 'NOT_MODELLED' },
        from: FROM,
        to: TO,
        engineFactory: (symbol) => new ScriptedEngine(perIndex.get(symbol)!),
      });
    const after = await scripted(REALISTIC_COSTS);
    sameRun(after, k.runs.after);
    sameRun(await scripted({ ...REALISTIC_COSTS, spreadMultiplier: 2 }), k.runs.spread2);
    // The script reaches the owner's limits and ASTRA's protections, not just plain fills.
    const checks = after.gate.blockedBy.map((b) => b.checkId);
    for (const id of [
      'strategy.limits',
      'risk.capital-preservation',
      'position.duplicates',
      'market.session',
      'prop-firm.rules',
    ])
      expect(checks).toContain(id);
    expect(after.gate.invalidated).toBeGreaterThan(0);
    expect(after.protectiveCloses).toBeGreaterThan(0);
    expect(after.trades.length).toBeGreaterThan(100);
  }, 120_000);

  it('carries ASTRA’s configuration', () => {
    const c = JSON.parse(python('constants')) as {
      instruments: Record<string, Record<string, unknown>>;
      strategy: Record<string, unknown>;
      riskPolicy: Record<string, unknown>;
      system: Record<string, unknown>;
      startingBalance: number;
    };
    for (const symbol of SYMBOLS) {
      const spec = config.instruments.get(symbol)!;
      expect(c.instruments[symbol]).toEqual({
        tickSize: spec.tickSize,
        tickValue: spec.tickValue,
        quoteCurrency: spec.quoteCurrency,
        commission: spec.costs.commissionPerUnitRoundTurn,
        slippageAllowanceTicks: spec.costs.slippageAllowanceTicks,
        maxSpreadTicks: spec.maxSpreadTicks,
        quantityStep: spec.quantityStep,
        minQuantity: spec.minQuantity,
        eventCurrencies: spec.eventCurrencies,
      });
    }
    for (const id of ['lsfvg-a', 'lsfvg-b']) {
      const s = config.strategies.get(id)!;
      expect(c.strategy).toEqual({
        minRewardToRisk: s.minRewardToRisk,
        maxRiskPercentPerTrade: s.maxRiskPercentPerTrade,
        maxTradesPerDay: s.maxTradesPerDay,
        signalTtlSeconds: s.signalTtlSeconds,
        eventBlackout: s.eventBlackout,
        ...s.limits,
      });
    }
    const p = config.riskPolicies.get('lsfvg-fx')!;
    expect(c.riskPolicy).toEqual({
      riskPercentOfEquity: p.perTrade.riskPercentOfEquity,
      minRewardToRisk: p.perTrade.minRewardToRisk,
      ...p.buffers,
      maxOpenRiskPercentOfEquity: p.exposure.maxOpenRiskPercentOfEquity,
      maxOpenPositions: p.exposure.maxOpenPositions,
      maxPositionsPerInstrument: p.exposure.maxPositionsPerInstrument,
      allowPyramiding: p.exposure.allowPyramiding,
      maxTradesPerDay: p.activity.maxTradesPerDay,
      maxConsecutiveLosses: p.activity.maxConsecutiveLosses,
      ...p.health,
      noNewTradesMinutesBeforeFlat: p.timing.noNewTradesMinutesBeforeFlat,
    });
    expect(p.perTrade.maxRiskAmount).toBeNull();
    const protection = config.system.protection ?? DEFAULT_PROTECTION_POLICY;
    expect(c.system).toEqual({
      minMinutesBeforeMarketClose: config.system.decision.minMinutesBeforeMarketClose,
      maxWorkingOrderMinutes: config.system.decision.maxWorkingOrderMinutes,
      eventBlackout: config.system.decision.eventBlackout,
      lateObservationThresholdMs: config.system.tracking.lateObservationThresholdMs,
      flattenMinutesBeforeFlat: protection.flattenMinutesBeforeFlat,
      flattenAtLimitUsagePct: protection.flattenAtLimitUsagePct,
    });
    const profile = config.profiles.get('template-static-50k')!;
    expect(c.startingBalance).toBe(profile.accountSize);
    expect(profile.holding).toMatchObject({
      weekend: 'PROHIBITED',
      weeklyClose: { timeZone: 'America/New_York', day: 'FRI', time: '16:00' },
    });
    expect(profile.tradingDayReset).toEqual({ timeZone: 'America/New_York', time: '17:00' });
  });

  it('refuses a file whose prices are not the pair it is listed as', () => {
    const wrong = join(dir, 'wrong.json');
    writeFileSync(
      wrong,
      JSON.stringify({
        pairs: { EURUSD: { format: 'dukascopy', side: 'BID', files: ['usdjpy-bid.csv'] } },
      }),
    );
    expect(() => python('parity', '--manifest', wrong, '--from', FROM, '--to', TO)).toThrow(
      /EURUSD: the prices in .*usdjpy-bid\.csv have a median of .*which is not EURUSD/,
    );
  });

  it('its selftest recognises ASTRA’s result on the synthetic data', () => {
    const out = python('selftest');
    expect(out).toMatch(/Model A: .* = ASTRA ✓/);
    expect(out).toMatch(/Model B: .* = ASTRA ✓/);
    expect(out).toMatch(/selftest OK/);
  }, 120_000);
});
