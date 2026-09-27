/**
 * Component health registry (spec §21, §38). Components report their state; a report older than
 * the component's staleness limit decays to UNKNOWN — silence is never interpreted as healthy.
 */
import {
  COMPONENT_IDS,
  worstHealth,
  type Clock,
  type ComponentHealth,
  type ComponentId,
  type HealthStatus,
} from '@astra/core';

export interface ComponentHealthPolicy {
  /** A report older than this is UNKNOWN. */
  readonly staleAfterMs: number;
}

interface Report {
  status: HealthStatus;
  detail: string;
  at: number;
  lastOnlineAt: number | undefined;
}

export class ComponentHealthRegistry {
  private readonly reports = new Map<ComponentId, Report>();

  constructor(
    private readonly clock: Clock,
    private readonly policies: Readonly<Record<ComponentId, ComponentHealthPolicy>>,
  ) {}

  /** Records a report; `at` defaults to now (pass it when seeding persisted heartbeats). */
  report(component: ComponentId, status: HealthStatus, detail: string, at?: Date): void {
    const now = (at ?? this.clock.now()).getTime();
    const prev = this.reports.get(component);
    this.reports.set(component, {
      status,
      detail,
      at: now,
      lastOnlineAt: status === 'ONLINE' ? now : prev?.lastOnlineAt,
    });
  }

  get(component: ComponentId): ComponentHealth {
    const now = this.clock.now();
    const r = this.reports.get(component);
    if (!r) {
      return {
        component,
        status: 'UNKNOWN',
        detail: 'no health report received',
        checkedAt: now.toISOString(),
      };
    }
    const base = {
      component,
      checkedAt: new Date(r.at).toISOString(),
      ...(r.lastOnlineAt !== undefined
        ? { lastOnlineAt: new Date(r.lastOnlineAt).toISOString() }
        : {}),
    };
    const age = now.getTime() - r.at;
    if (age > this.policies[component].staleAfterMs) {
      return {
        ...base,
        status: 'UNKNOWN',
        detail: `last report ${Math.round(age / 1000)}s ago exceeds ${Math.round(this.policies[component].staleAfterMs / 1000)}s (${r.status}: ${r.detail})`,
      };
    }
    return { ...base, status: r.status, detail: r.detail };
  }

  snapshot(): ComponentHealth[] {
    return COMPONENT_IDS.map((c) => this.get(c));
  }

  /** Worst status across the given components (UNKNOWN when the list is empty). */
  overall(components: readonly ComponentId[] = COMPONENT_IDS): HealthStatus {
    return worstHealth(components.map((c) => this.get(c).status));
  }
}
