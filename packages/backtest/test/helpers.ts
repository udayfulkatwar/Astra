import { resolve } from 'node:path';
import { decisionConfigView, loadAstraConfig } from '@astra/config';
import { DEFAULT_MONITOR_POLICY, DEFAULT_PROTECTION_POLICY } from '@astra/risk';
import type { BacktestEnvironment } from '../src';

export const config = loadAstraConfig(resolve(import.meta.dirname, '../../../config'));

export function environment(): BacktestEnvironment {
  return {
    config: decisionConfigView(config),
    monitorPolicy: config.system.monitors.positions ?? DEFAULT_MONITOR_POLICY,
    protectionPolicy: config.system.protection ?? DEFAULT_PROTECTION_POLICY,
    structureParams: config.system.structure,
    lateObservationThresholdMs: config.system.tracking.lateObservationThresholdMs,
  };
}
