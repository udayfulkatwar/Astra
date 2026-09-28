/**
 * AI orchestration contracts (ARCHITECTURE §8, ADR-0020). Providers are adapters behind one
 * `AiProvider` interface; every task has a Zod output schema; every call is logged.
 */
import type { DataSourceKind } from '@astra/core';
import type { z } from 'zod';

export const AI_TASKS = ['TRADE_ANALYSIS', 'POST_TRADE_REVIEW'] as const;
export type AiTask = (typeof AI_TASKS)[number];

export const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];

/** What one provider call is asked to do. `system` is stable per task (cacheable). */
export interface AiProviderRequest {
  readonly task: AiTask;
  readonly model: string;
  readonly effort: AiEffort | undefined;
  readonly maxOutputTokens: number;
  readonly system: string;
  readonly prompt: string;
  /** The structured brief the prompt was rendered from (the SIMULATED stand-in reads it). */
  readonly input: unknown;
  /** Output contract; adapters pass it to the model as structured output where supported. */
  readonly outputSchema: z.ZodType;
}

/** COMPLETE: the model finished; REFUSED: it declined; TRUNCATED: it hit the output limit. */
export type AiStop = 'COMPLETE' | 'REFUSED' | 'TRUNCATED';

export interface AiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface AiProviderResponse {
  /** Raw model text; the orchestrator parses and validates it (never repairs it). */
  readonly text: string;
  readonly stop: AiStop;
  /** The model that actually answered (differs from the requested one after a fallback). */
  readonly servedModel: string;
  readonly fallbackUsed: boolean;
  readonly usage: AiUsage;
  readonly refusal?: { readonly category: string | null; readonly explanation: string | null };
}

export interface AiProvider {
  readonly id: string;
  /** LIVE for a real model; SIMULATED for the rule-based stand-in (refused in SHADOW/LIVE). */
  readonly kind: DataSourceKind;
  complete(request: AiProviderRequest, signal: AbortSignal): Promise<AiProviderResponse>;
}

/** A task: its stable instructions, output contract and how a brief becomes a prompt. */
export interface AiTaskDefinition<I, O> {
  readonly task: AiTask;
  readonly system: string;
  readonly outputSchema: z.ZodType<O>;
  prompt(input: I): string;
}

export const AI_CALL_STATUSES = [
  'OK',
  /** Output was not valid JSON for the task schema — never repaired. */
  'INVALID',
  'REFUSED',
  'TRUNCATED',
  'TIMEOUT',
  'ERROR',
  /** Not sent: kill switch, disabled, budget, no provider or no price. */
  'BLOCKED',
] as const;
export type AiCallStatus = (typeof AI_CALL_STATUSES)[number];

export type AiBlockReason = 'KILL_SWITCH' | 'DISABLED' | 'BUDGET' | 'NO_PROVIDER' | 'NO_PRICE';

/** One row of the append-only AI call log. */
export interface AiCallRecord {
  readonly callId: string;
  readonly task: AiTask;
  /** Signal id (analysis) or trade id (review). */
  readonly subjectId: string;
  readonly provider: string;
  readonly providerKind: DataSourceKind | null;
  readonly model: string;
  readonly servedModel: string | null;
  readonly status: AiCallStatus;
  readonly blockedBy: AiBlockReason | null;
  readonly startedAt: string;
  readonly latencyMs: number;
  readonly usage: AiUsage | null;
  /** From the configured price table; 0 for calls that were never sent. */
  readonly costUsd: number;
  /** True when no usage came back (timeout) and `costUsd` is the worst-case reservation. */
  readonly costEstimated: boolean;
  readonly fallbackUsed: boolean;
  readonly error: string | null;
}
