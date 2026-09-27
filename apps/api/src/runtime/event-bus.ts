/**
 * Live activity stream (spec §68): persists system events and fans them out to SSE clients.
 * If persistence fails the event is still broadcast (and logged) — visibility must not depend
 * on the database being healthy.
 */
import type { Clock } from '@astra/core';
import type { EventLevel, EventRepository, SystemEvent } from '@astra/db';
import type { Logger } from 'pino';

export interface EmitInput {
  readonly level: EventLevel;
  readonly component: string;
  readonly type: string;
  readonly message: string;
  readonly accountId?: string | null;
  readonly data?: Record<string, unknown>;
}

export class EventBus {
  private readonly listeners = new Set<(e: SystemEvent) => void>();

  constructor(
    private readonly repo: EventRepository,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  async emit(input: EmitInput): Promise<SystemEvent> {
    const base = {
      at: this.clock.now().toISOString(),
      level: input.level,
      component: input.component,
      type: input.type,
      message: input.message,
      accountId: input.accountId ?? null,
      data: input.data ?? {},
    };
    let event: SystemEvent;
    try {
      event = await this.repo.append(base);
    } catch (err) {
      this.log.error({ err, event: base }, 'failed to persist system event');
      event = { ...base, seq: -1, id: 'unpersisted' };
    }
    const logFn =
      input.level === 'CRITICAL' || input.level === 'ERROR'
        ? 'error'
        : input.level === 'WARN'
          ? 'warn'
          : 'info';
    this.log[logFn](
      { component: input.component, type: input.type, accountId: input.accountId },
      input.message,
    );
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        this.log.warn({ err }, 'event listener failed');
      }
    }
    return event;
  }

  subscribe(listener: (e: SystemEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
