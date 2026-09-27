/**
 * SIMULATED M1 bars for engine tests and the demo: a seeded random walk with drifting regimes,
 * generated only while the instrument's market is open. Every bar is labelled SIMULATED, which
 * the gate refuses in SHADOW and LIVE. It is not market data and says nothing about any market.
 */
import { dec, marketStatus, toNum, type TradingHours } from '@astra/core';
import type { Bar } from '@astra/market-data';

export interface SimulationOptions {
  readonly symbol: string;
  readonly tickSize: number;
  readonly startPrice: number;
  readonly from: string;
  readonly to: string;
  readonly hours: TradingHours;
  readonly seed: number;
  /** Typical one-minute move, in ticks. */
  readonly volatilityTicks?: number;
  readonly source?: string;
}

/** Small deterministic PRNG (mulberry32): same seed → same series on every platform. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function simulateM1Bars(opts: SimulationOptions): Bar[] {
  const rand = seededRandom(opts.seed);
  const gauss = () => {
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  const vol = opts.volatilityTicks ?? 8;
  const tick = opts.tickSize;
  const onGrid = (p: number) => toNum(dec(Math.round(p / tick)).mul(tick), 10);
  const bars: Bar[] = [];
  const end = Date.parse(opts.to);
  let t = Math.ceil(Date.parse(opts.from) / 60_000) * 60_000;
  let price = onGrid(opts.startPrice);
  let drift = 0;
  let regimeLeft = 0;
  let openUntil = -Infinity; // the market is known to be open until this time

  while (t + 60_000 <= end) {
    if (t >= openUntil) {
      const status = marketStatus(new Date(t), opts.hours);
      if (!status.open) {
        if (!status.nextOpen) break;
        t = Math.ceil(Date.parse(status.nextOpen) / 60_000) * 60_000;
        continue;
      }
      openUntil = status.nextClose ? Date.parse(status.nextClose) : Infinity;
    }
    if (t + 60_000 > openUntil) {
      t = openUntil; // no complete minute left in this session
      continue;
    }
    if (regimeLeft <= 0) {
      // Trends and ranges alternate so that structure breaks, sweeps and gaps all occur.
      drift = [-0.35, -0.15, 0, 0, 0.15, 0.35][Math.floor(rand() * 6)]! * vol;
      regimeLeft = 30 + Math.floor(rand() * 150);
    }
    regimeLeft--;
    const open = price;
    let high = open;
    let low = open;
    let p = open;
    for (let i = 0; i < 4; i++) {
      p = p + (drift / 4 + (gauss() * vol) / 2) * tick;
      high = Math.max(high, p);
      low = Math.min(low, p);
    }
    const close = onGrid(Math.max(p, tick));
    const bar: Bar = {
      symbol: opts.symbol,
      timeframe: 'M1',
      openTime: new Date(t).toISOString(),
      closeTime: new Date(t + 60_000).toISOString(),
      open,
      high: Math.max(onGrid(high), open, close),
      low: Math.max(tick, Math.min(onGrid(low), open, close)),
      close,
      volume: null,
      tickCount: 0,
      complete: true,
      source: opts.source ?? 'backtest-simulation',
      sourceKind: 'SIMULATED',
    };
    bars.push(bar);
    price = close;
    t += 60_000;
  }
  return bars;
}
