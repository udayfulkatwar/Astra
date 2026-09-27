/** A trade candidate: a SIGNAL routed to a specific account for a DECISION. */
import { z } from 'zod';
import { IsoDateTimeSchema, SlugSchema } from '../schemas';
import { SignalSchema } from './signal';

export const TradeCandidateSchema = z.object({
  accountId: SlugSchema,
  signal: SignalSchema,
  submittedAt: IsoDateTimeSchema,
  /** Correlates with the n8n execution that submitted it, if any. */
  workflowRunId: z.string().max(200).optional(),
});
export type TradeCandidate = z.infer<typeof TradeCandidateSchema>;
