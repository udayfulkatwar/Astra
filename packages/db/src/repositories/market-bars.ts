/** Completed OHLC bars (the `BarStore` port of @astra/market-data). */
import { AstraError } from '@astra/core';
import { BarSchema, type Bar, type BarStore, type Timeframe } from '@astra/market-data';
import type { Sql } from '../client';
import { iso } from '../client';

const BATCH_SIZE = 500;

interface BarRow {
  symbol: string;
  timeframe: string;
  open_time: Date;
  close_time: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
  tick_count: number;
  source: string;
  source_kind: string;
}

export class MarketBarRepository implements BarStore {
  constructor(private readonly sql: Sql) {}

  /**
   * Inserts or replaces completed bars (key: symbol, timeframe, open time, source) in batches,
   * atomically. In-progress bars are refused: only finished periods are ever stored.
   */
  async upsert(bars: readonly Bar[]): Promise<void> {
    const open = bars.find((b) => !b.complete);
    if (open) {
      throw new AstraError(
        'VALIDATION',
        `refusing to store in-progress bar ${open.symbol} ${open.timeframe} ${open.openTime}`,
      );
    }
    // One row per key (the newest wins): a statement cannot upsert the same row twice.
    const unique = new Map<string, Bar>();
    for (const b of bars) {
      unique.set(`${b.symbol}|${b.timeframe}|${Date.parse(b.openTime)}|${b.source}`, b);
    }
    const rows = [...unique.values()].map((b) => ({
      symbol: b.symbol,
      timeframe: b.timeframe,
      open_time: b.openTime,
      close_time: b.closeTime,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      tick_count: b.tickCount,
      source: b.source,
      source_kind: b.sourceKind,
    }));
    if (rows.length === 0) return;
    await this.sql.begin(async (tx) => {
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        await tx`
          insert into market_bars ${tx(rows.slice(i, i + BATCH_SIZE))}
          on conflict (symbol, timeframe, open_time, source) do update set
            close_time = excluded.close_time, open = excluded.open, high = excluded.high,
            low = excluded.low, close = excluded.close, volume = excluded.volume,
            tick_count = excluded.tick_count, source_kind = excluded.source_kind`;
      }
    });
  }

  /** The newest `limit` bars of a symbol/timeframe (every source), oldest → newest. */
  async recent(symbol: string, timeframe: Timeframe, limit: number): Promise<Bar[]> {
    const rows = await this.sql<BarRow[]>`
      select * from (
        select * from market_bars where symbol = ${symbol} and timeframe = ${timeframe}
         order by open_time desc, source limit ${limit}
      ) newest order by open_time asc, source`;
    return rows.map((r) =>
      BarSchema.parse({
        symbol: r.symbol,
        timeframe: r.timeframe,
        openTime: iso(r.open_time),
        closeTime: iso(r.close_time),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: r.volume === null ? null : Number(r.volume),
        tickCount: r.tick_count,
        complete: true,
        source: r.source,
        sourceKind: r.source_kind,
      }),
    );
  }
}
