/**
 * Global trading modes (spec §34) and what each mode permits.
 * Progression: BACKTEST → PAPER → SHADOW → LIVE. HALTED stops all new activity.
 */
import { z } from 'zod';
import type { DataSourceKind } from './observed';

export const TRADING_MODES = ['BACKTEST', 'PAPER', 'SHADOW', 'LIVE', 'HALTED'] as const;
export type TradingMode = (typeof TRADING_MODES)[number];
export const TradingModeSchema = z.enum(TRADING_MODES);

export type BrokerKind = 'PAPER' | 'LIVE';

export interface ModePolicy {
  /** Whether the real-time decision gate may approve new trades in this mode. */
  readonly newTradesAllowed: boolean;
  /** Whether approved orders are transmitted to a broker adapter. SHADOW never transmits. */
  readonly transmitsOrders: boolean;
  /** Which broker adapter kind is acceptable. */
  readonly brokerKind: BrokerKind | null;
  /** Data source kinds acceptable as decision inputs. */
  readonly acceptedDataSources: readonly DataSourceKind[];
  /** Whether UNVERIFIED rule profiles / instrument specs may be used. */
  readonly allowsUnverifiedConfig: boolean;
}

export const MODE_POLICIES: Readonly<Record<TradingMode, ModePolicy>> = {
  // The real-time pipeline never trades in BACKTEST; backtests run in their own simulator.
  BACKTEST: {
    newTradesAllowed: false,
    transmitsOrders: false,
    brokerKind: null,
    acceptedDataSources: ['HISTORICAL', 'SIMULATED'],
    allowsUnverifiedConfig: true,
  },
  PAPER: {
    newTradesAllowed: true,
    transmitsOrders: true,
    brokerKind: 'PAPER',
    acceptedDataSources: ['LIVE', 'SIMULATED', 'MANUAL'],
    allowsUnverifiedConfig: true,
  },
  SHADOW: {
    newTradesAllowed: true,
    transmitsOrders: false,
    brokerKind: null,
    acceptedDataSources: ['LIVE'],
    allowsUnverifiedConfig: true,
  },
  LIVE: {
    newTradesAllowed: true,
    transmitsOrders: true,
    brokerKind: 'LIVE',
    acceptedDataSources: ['LIVE'],
    allowsUnverifiedConfig: false,
  },
  HALTED: {
    newTradesAllowed: false,
    transmitsOrders: false,
    brokerKind: null,
    acceptedDataSources: [],
    allowsUnverifiedConfig: false,
  },
};

export function modePolicy(mode: TradingMode): ModePolicy {
  return MODE_POLICIES[mode];
}
