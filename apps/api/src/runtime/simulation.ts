/**
 * SIMULATED feeds for paper testing (spec §65). Enabled only with ASTRA_SIMULATION=true.
 * Quotes come from the @astra/market-data SimulationAdapter (sourceKind SIMULATED, refused by
 * the gate in SHADOW and LIVE); after every tick a simulated calendar window is pushed that
 * asserts coverage with no events — meaningful for paper tests only.
 */
import type { AstraConfig } from '@astra/config';
import type { Clock } from '@astra/core';
import { SimulationAdapter } from '@astra/market-data';
import type { CalendarService } from './calendar';

export function createSimulation(
  config: AstraConfig,
  calendar: CalendarService,
  clock: Clock,
): SimulationAdapter | null {
  const sim = config.system.simulation;
  if (!sim) return null;
  return new SimulationAdapter({
    intervalMs: sim.quoteIntervalMs,
    instruments: sim.instruments,
    tickSize: (s) => config.instruments.get(s)?.tickSize,
    clock,
    onTick: (now) =>
      calendar.ingest(
        {
          from: new Date(now.getTime() - 24 * 3_600_000).toISOString(),
          to: new Date(now.getTime() + 7 * 24 * 3_600_000).toISOString(),
          events: [],
        },
        'simulation',
        'SIMULATED',
        now.toISOString(),
      ),
  });
}
