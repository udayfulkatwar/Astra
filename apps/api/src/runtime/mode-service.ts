/**
 * Global trading mode. Until the persisted mode is loaded the effective mode is HALTED
 * (fail-closed startup). The system never boots into LIVE without environment authorization
 * (ADR-0008), and switching to HALTED takes effect immediately even if persistence fails.
 */
import { AstraError, type Clock, type TradingMode } from '@astra/core';
import type { ModeState, SystemStateRepository } from '@astra/db';
import type { EventBus } from './event-bus';

export interface ModeActor {
  readonly type: 'HUMAN' | 'SYSTEM' | 'AUTOMATION';
  readonly id: string;
}

export class ModeService {
  private state: ModeState | null = null;

  constructor(
    private readonly repo: SystemStateRepository,
    private readonly clock: Clock,
    private readonly events: EventBus,
    private readonly liveTradingAuthorized: boolean,
  ) {}

  isLoaded(): boolean {
    return this.state !== null;
  }

  current(): TradingMode {
    return this.state?.mode ?? 'HALTED';
  }

  info(): { mode: TradingMode; loaded: boolean; state: ModeState | null } {
    return { mode: this.current(), loaded: this.isLoaded(), state: this.state };
  }

  async load(): Promise<void> {
    const persisted = await this.repo.get();
    this.state = persisted;
    if (persisted.mode === 'LIVE' && !this.liveTradingAuthorized) {
      await this.set(
        'HALTED',
        { type: 'SYSTEM', id: 'startup' },
        'persisted mode was LIVE but live trading is not authorized in this environment',
      );
    }
  }

  async set(mode: TradingMode, actor: ModeActor, reason: string): Promise<ModeState> {
    if (!this.state)
      throw new AstraError('UNAVAILABLE', 'trading mode not loaded yet (database unavailable?)');
    if (mode === 'LIVE' && !this.liveTradingAuthorized) {
      throw new AstraError(
        'FORBIDDEN',
        'LIVE mode requires ASTRA_LIVE_TRADING_AUTHORIZED=true on the server (ADR-0008)',
      );
    }
    const previous = this.state;
    const at = this.clock.now().toISOString();
    if (mode === 'HALTED') {
      // Safety first: halt in memory before (and regardless of) persistence.
      this.state = {
        ...previous,
        mode: 'HALTED',
        changedAt: at,
        changedBy: `${actor.type}:${actor.id}`,
        reason,
      };
    }
    try {
      const next = await this.repo.setMode({
        mode,
        actor,
        reason,
        expectedVersion: previous.version,
        at,
      });
      this.state = next;
      await this.events.emit({
        level: mode === 'HALTED' || mode === 'LIVE' ? 'WARN' : 'INFO',
        component: 'system',
        type: 'MODE_CHANGED',
        message: `mode ${previous.mode} → ${mode} by ${actor.type}:${actor.id}: ${reason}`,
        data: { from: previous.mode, to: mode },
      });
      return next;
    } catch (err) {
      if (mode === 'HALTED') {
        await this.events.emit({
          level: 'CRITICAL',
          component: 'system',
          type: 'MODE_PERSIST_FAILED',
          message: 'HALTED applied in memory but could not be persisted',
        });
      }
      throw err;
    }
  }
}
