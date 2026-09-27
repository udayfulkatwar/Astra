/**
 * Component health vocabulary (spec §21, §38). Every subsystem reports one of four states.
 * UNKNOWN is never treated as healthy.
 */
import { z } from 'zod';

export const HEALTH_STATUSES = ['ONLINE', 'DEGRADED', 'ERROR', 'UNKNOWN'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];
export const HealthStatusSchema = z.enum(HEALTH_STATUSES);

export const COMPONENT_IDS = [
  'DATABASE',
  'MARKET_DATA',
  'NEWS',
  'CALENDAR',
  'AI',
  'AUTOMATION',
  'EXECUTION',
  'RISK_ENGINE',
  'PROP_FIRM_ADAPTER',
  'NOTIFICATIONS',
] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];
export const ComponentIdSchema = z.enum(COMPONENT_IDS);

export interface ComponentHealth {
  readonly component: ComponentId;
  readonly status: HealthStatus;
  readonly detail: string;
  /** ISO-8601 UTC time the status was determined. */
  readonly checkedAt: string;
  /** ISO-8601 UTC time the component was last ONLINE, if ever. */
  readonly lastOnlineAt?: string;
}

/** Severity ordering used when aggregating: higher is worse. */
const SEVERITY: Record<HealthStatus, number> = { ONLINE: 0, DEGRADED: 1, UNKNOWN: 2, ERROR: 3 };

export function worstHealth(statuses: readonly HealthStatus[]): HealthStatus {
  if (statuses.length === 0) return 'UNKNOWN';
  return statuses.reduce((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst), 'ONLINE');
}
