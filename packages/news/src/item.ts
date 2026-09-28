/**
 * News DATA as delivered by a provider (spec §15). A headline is data; what it means for an
 * instrument is CONTEXT, produced by the classifier. Nothing here is ever invented: fields a
 * provider does not give are absent, never guessed.
 */
import { IsoDateTimeSchema, SymbolSchema } from '@astra/core';
import { z } from 'zod';

export const NEWS_IMPACTS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type NewsImpact = (typeof NEWS_IMPACTS)[number];

export const SENTIMENT_LABELS = [
  'VERY_BULLISH',
  'BULLISH',
  'NEUTRAL',
  'BEARISH',
  'VERY_BEARISH',
] as const;
export type SentimentLabel = (typeof SENTIMENT_LABELS)[number];

export const NewsItemSchema = z
  .object({
    /** Provider's id, unique within its source. */
    id: z.string().min(1).max(200),
    headline: z.string().trim().min(1).max(500),
    summary: z.string().max(4_000).optional(),
    /** Publisher named by the provider (e.g. a wire service). */
    publisher: z.string().max(200).optional(),
    url: z.url().max(2_000).optional(),
    publishedAt: IsoDateTimeSchema,
    /** ISO 3166 alpha-2 country codes the provider tags. */
    countries: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .max(50)
      .optional(),
    /** ISO 4217 currency codes the provider tags. */
    currencies: z
      .array(z.string().regex(/^[A-Z]{3}$/))
      .max(50)
      .optional(),
    /** ASTRA instrument symbols the provider (or the n8n mapping) tags. */
    symbols: z.array(SymbolSchema).max(50).optional(),
    /** The provider's own importance rating, when it gives one. */
    providerImpact: z.enum(NEWS_IMPACTS).optional(),
    /** The provider's own sentiment, when it gives one (ASTRA never derives it from keywords). */
    providerSentiment: z
      .object({ label: z.enum(SENTIMENT_LABELS), confidence: z.number().min(0).max(1) })
      .optional(),
  })
  .strict();
export type NewsItem = z.infer<typeof NewsItemSchema>;
