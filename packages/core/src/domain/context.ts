/**
 * CONTEXT: interpretations of DATA (AI analysis, news risk). Context can restrict a trade;
 * it can never approve one on its own.
 */
import { z } from 'zod';
import { IsoDateTimeSchema, SymbolSchema } from '../schemas';

export const AI_VERDICTS = ['SUPPORTS', 'NEUTRAL', 'CONFLICTS'] as const;
export type AiVerdict = (typeof AI_VERDICTS)[number];

/** Structured AI analysis contract (Phase 6 produces it; the gate consumes it now). */
export const AiAnalysisSchema = z.object({
  analysisId: z.string().min(1),
  signalId: z.string().min(1),
  model: z.string().min(1),
  producedAt: IsoDateTimeSchema,
  verdict: z.enum(AI_VERDICTS),
  confidence: z.number().min(0).max(1),
  setupQuality: z.number().min(0).max(100),
  eventRisk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  reasons: z.array(z.string().min(1)).min(1),
  invalidation: z.array(z.string()).default([]),
});
export type AiAnalysis = z.infer<typeof AiAnalysisSchema>;

export const NEWS_RISK_LEVELS = ['NORMAL', 'ELEVATED', 'HIGH'] as const;
export type NewsRiskLevel = (typeof NEWS_RISK_LEVELS)[number];

/** News-risk CONTEXT for one instrument (Phase 4 produces it). */
export const NewsRiskAssessmentSchema = z.object({
  symbol: SymbolSchema,
  level: z.enum(NEWS_RISK_LEVELS),
  assessedAt: IsoDateTimeSchema,
  reasons: z.array(z.string()).default([]),
});
export type NewsRiskAssessment = z.infer<typeof NewsRiskAssessmentSchema>;
