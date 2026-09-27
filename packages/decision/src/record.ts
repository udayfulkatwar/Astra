/**
 * Persistence gate (spec §54): a decision that cannot be persisted is not approved.
 */
import { errorMessage } from '@astra/core';
import type { DecisionEngine } from './engine';
import type { DecisionInputs, TradeDecision } from './types';

export interface DecisionRecorder {
  /** Must durably persist the decision and its inputs (atomically) or throw. */
  record(decision: TradeDecision, inputs: DecisionInputs): Promise<void>;
}

export interface RecordedDecision {
  readonly decision: TradeDecision;
  readonly persisted: boolean;
  readonly persistenceError?: string;
}

export async function decideAndRecord(
  engine: DecisionEngine,
  inputs: DecisionInputs,
  recorder: DecisionRecorder,
): Promise<RecordedDecision> {
  const decision = engine.evaluate(inputs);
  try {
    await recorder.record(decision, inputs);
    return { decision, persisted: true };
  } catch (err) {
    const message = errorMessage(err);
    const rejected: TradeDecision = {
      ...decision,
      status: 'REJECTED',
      approval: null,
      orderPlan: null,
      sizing: null,
      reasons: [
        ...decision.reasons,
        `[system.persistence] decision could not be persisted: ${message}`,
      ],
      explanation: {
        ...decision.explanation,
        what: `NO TRADE: decision could not be persisted (${message})`,
      },
    };
    return { decision: rejected, persisted: false, persistenceError: message };
  }
}
