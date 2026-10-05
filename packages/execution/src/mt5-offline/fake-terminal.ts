/**
 * FAKE terminal for offline conformance. It models nothing about MT5 beyond what the tests script:
 * abstract statuses, throws, lost replies and a write boundary that re-reads the authoritative
 * clock/gate/owner state before applying an effect. A passing test proves the BRIDGE LOGIC against
 * this model, never a real terminal.
 */
import { D } from '@astra/core';
import type { BridgeCommand } from './contract';
import type { BridgeTransport, Fence, TransportResult, WriteBoundary } from './transport';

export type FakeBehavior =
  | { readonly kind: 'DONE'; readonly ref?: string; readonly remainingLots?: string }
  | { readonly kind: 'REJECT'; readonly reason: string }
  | { readonly kind: 'PARTIAL'; readonly doneLots: string; readonly remainingLots: string }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'THROW_BEFORE_EFFECT' }
  | { readonly kind: 'THROW_AFTER_EFFECT' }
  | { readonly kind: 'RAW'; readonly reply: unknown };

export class FakeTerminal implements BridgeTransport {
  readonly invocations: { command: BridgeCommand; fence: Fence }[] = [];
  /** Commands whose effect the fake "applied" (even when the reply was lost). */
  readonly effects: string[] = [];
  private readonly scripted = new Map<string, FakeBehavior>();

  constructor(private readonly defaultBehavior: FakeBehavior = { kind: 'DONE' }) {}

  script(commandId: string, behavior: FakeBehavior): void {
    this.scripted.set(commandId, behavior);
  }

  async invoke(command: BridgeCommand, fence: Fence, boundary: WriteBoundary): Promise<unknown> {
    this.invocations.push({ command, fence });
    // The fence names ONE account; it never authorises another.
    if (fence.accountRef !== command.accountRef)
      return { status: 'FENCED' } satisfies TransportResult;
    const b = this.scripted.get(command.commandId) ?? this.defaultBehavior;
    if (b.kind === 'THROW_BEFORE_EFFECT') throw new Error('fake transport failed before effect');
    // Authoritative re-read at the (modelled) write boundary, AFTER any wait the caller incurred.
    const verdict = await boundary.check();
    if (!verdict.ok)
      return { status: 'BOUNDARY_REFUSED', reason: verdict.reason } satisfies TransportResult;
    switch (b.kind) {
      case 'THROW_AFTER_EFFECT':
        this.effects.push(command.commandId);
        throw new Error('fake transport lost the reply');
      case 'RAW':
        this.effects.push(command.commandId);
        return b.reply;
      case 'REJECT':
        return { status: 'REJECTED', reason: b.reason } satisfies TransportResult;
      case 'NOT_FOUND':
        return { status: 'NOT_FOUND' } satisfies TransportResult;
      case 'PARTIAL':
        this.effects.push(command.commandId);
        return { status: 'PARTIAL', doneLots: b.doneLots, remainingLots: b.remainingLots };
      case 'DONE': {
        this.effects.push(command.commandId);
        const remaining = b.remainingLots ?? (command.op === 'CLOSE' ? '0' : null);
        return {
          status: 'DONE',
          ref: b.ref ?? '1',
          remainingLots: remaining === null ? null : new D(remaining).toString(),
        };
      }
    }
  }
}
