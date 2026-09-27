/**
 * SIMULATED feeds for paper testing (spec §65). Enabled only with ASTRA_SIMULATION=true.
 * Quotes come from the @astra/market-data SimulationAdapter and the economic calendar from the
 * @astra/calendar SimulatedCalendarAdapter (a labelled placeholder schedule). Both are sourceKind
 * SIMULATED, which the gate refuses in SHADOW and LIVE.
 */
import type { AstraConfig } from '@astra/config';
import type { Clock } from '@astra/core';
import { SimulationAdapter } from '@astra/market-data';

export function createSimulation(config: AstraConfig, clock: Clock): SimulationAdapter | null {
  const sim = config.system.simulation;
  if (!sim) return null;
  return new SimulationAdapter({
    intervalMs: sim.quoteIntervalMs,
    instruments: sim.instruments,
    tickSize: (s) => config.instruments.get(s)?.tickSize,
    clock,
  });
}
