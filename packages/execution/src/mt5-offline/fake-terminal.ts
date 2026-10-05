/**
 * FAKE terminal for offline conformance. It models nothing about MT5 beyond what the tests script:
 * abstract statuses, throws, and a write-boundary fence. A passing fence test proves the BRIDGE
 * LOGIC against this model, never a real terminal.
 */
import { D } from '@astra/core';
import type { BridgeCommand } from './contract';
import type { BridgeTransport, Fence, TransportResult } from './transport';

export type FakeBehavior =
  | { readonly kind: 'DONE'; readonly ref?: string; readonly remainingLots?: string }
  | { readonly kind: 'REJECT'; readonly reason: string }
  | { readonly kind: 'PARTIAL'; readonly doneLots: string; readonly remainingLots: string }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'THROW_BEFORE_EFFECT' }
  | { readonly kind: 'THROW_AFTER_EFFECT' }
  | { readonly kind: 'MALFORMED' };

export class FakeTerminal implements BridgeTransport {
  readonly invocations: { command: BridgeCommand; fence: Fence }[] = [];
  /** Commands whose effect the fake "applied" (even when the reply was lost). */
  readonly effects: string[] = [];
  private readonly scripted = new Map<string, FakeBehavior>();
  private readonly highestEpoch = new Map<string, bigint>();

  constructor(private readonly defaultBehavior: FakeBehavior = { kind: 'DONE' }) {}

  script(commandId: string, behavior: FakeBehavior): void {
    this.scripted.set(commandId, behavior);
  }

  invoke(command: BridgeCommand, fence: Fence): Promise<unknown> {
    this.invocations.push({ command, fence });
    // Write-boundary fence (fake only): an older epoch than one already seen is refused.
    const seen = this.highestEpoch.get(command.accountRef) ?? 0n;
    const epoch = BigInt(fence.epoch);
    if (epoch < seen) return Promise.resolve({ status: 'FENCED' } satisfies TransportResult);
    this.highestEpoch.set(command.accountRef, epoch);

    const b = this.scripted.get(command.commandId) ?? this.defaultBehavior;
    switch (b.kind) {
      case 'THROW_BEFORE_EFFECT':
        return Promise.reject(new Error('fake transport failed before effect'));
      case 'THROW_AFTER_EFFECT':
        this.effects.push(command.commandId);
        return Promise.reject(new Error('fake transport lost the reply'));
      case 'MALFORMED':
        this.effects.push(command.commandId);
        return Promise.resolve({ status: 'WAT', extra: 1 });
      case 'REJECT':
        return Promise.resolve({ status: 'REJECTED', reason: b.reason });
      case 'NOT_FOUND':
        return Promise.resolve({ status: 'NOT_FOUND' });
      case 'PARTIAL':
        this.effects.push(command.commandId);
        return Promise.resolve({
          status: 'PARTIAL',
          doneLots: b.doneLots,
          remainingLots: b.remainingLots,
        });
      case 'DONE': {
        this.effects.push(command.commandId);
        const remaining = b.remainingLots ?? (command.op === 'CLOSE' ? '0' : null);
        return Promise.resolve({
          status: 'DONE',
          ref: b.ref ?? '1',
          remainingLots: remaining === null ? null : new D(remaining).toString(),
        });
      }
    }
  }
}
