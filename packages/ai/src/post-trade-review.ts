/**
 * POST_TRADE_REVIEW: was a closed trade a GOOD or POOR trade — judged on process (setup, entry,
 * exit, rules, execution), not on whether it made money. The outcome (WIN/LOSS/BREAKEVEN) comes
 * from the journal, never from the model. Suggested changes are stored as PROPOSED for a human;
 * ASTRA never applies them.
 */
import type { AiAnalysis } from '@astra/core';
import type { JournalEntry, TradeOutcome } from '@astra/journal';
import { z } from 'zod';
import type { AiTaskDefinition } from './types';

export interface PostTradeReviewBrief {
  readonly briefVersion: 1;
  readonly trade: JournalEntry;
  /** The gate's decision for this trade, when ASTRA placed it. */
  readonly gate: {
    readonly status: string;
    readonly checks: readonly { checkId: string; verdict: string; reasons: readonly string[] }[];
  } | null;
  /** The pre-trade AI analysis, when the strategy required one. */
  readonly analysis: AiAnalysis | null;
}

const Text = z.string().min(1).max(400);

export const PostTradeReviewOutputSchema = z
  .object({
    process: z.enum(['GOOD', 'POOR']),
    setupQuality: z.number().int().min(0).max(100),
    entryQuality: z.number().int().min(0).max(100),
    exitQuality: z.number().int().min(0).max(100),
    ruleViolations: z.array(Text).max(5),
    executionIssues: z.array(Text).max(5),
    lessons: z.array(Text).min(1).max(5),
    proposals: z
      .array(z.object({ parameter: Text, suggestion: Text, rationale: Text }).strict())
      .max(3),
    summary: z.string().min(1).max(800),
  })
  .strict();
export type PostTradeReviewOutput = z.infer<typeof PostTradeReviewOutputSchema>;

export type ReviewClassification = `${'GOOD' | 'POOR'}_${TradeOutcome}`;

export interface AiTradeReview {
  readonly reviewId: string;
  readonly tradeId: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly strategyId: string | null;
  readonly model: string;
  readonly provider: string;
  readonly sourceKind: string;
  readonly producedAt: string;
  /** From the journal (the numbers), never from the model. */
  readonly outcome: TradeOutcome;
  readonly process: 'GOOD' | 'POOR';
  readonly classification: ReviewClassification;
  readonly setupQuality: number;
  readonly entryQuality: number;
  readonly exitQuality: number;
  readonly ruleViolations: readonly string[];
  readonly executionIssues: readonly string[];
  readonly lessons: readonly string[];
  readonly summary: string;
  /** Suggestions for a human to consider; never applied automatically (ADR-0020). */
  readonly proposals: readonly {
    readonly parameter: string;
    readonly suggestion: string;
    readonly rationale: string;
    readonly status: 'PROPOSED';
  }[];
}

const SYSTEM = `You are the post-trade reviewer inside ASTRA, a risk-first trading system for prop-firm accounts. You review one closed trade from its journal entry and classify it by the quality of its process, not by its result.

How to judge:
- A GOOD trade followed a valid plan: a reasonable setup, entry close to plan, the stop respected, an exit by plan (stop, target or a justified protective close), no rule broken. A GOOD trade can lose money.
- A POOR trade had a weak or unplanned setup, a poor entry (for example large slippage), an exit that abandoned the plan, a rule violation or an execution problem. A POOR trade can make money.
- The outcome (win, loss, breakeven) is already known from the journal; do not restate or change it.

Rules for using the data:
- Use only the facts in the brief: the plan, the actual entry and exit, slippage in ticks, R multiple, maximum favourable and adverse excursion (MFE and MAE), duration, exit reason, whether it exited as planned, the trade context, the gate's checks and any pre-trade AI analysis.
- Do not invent prices, market events, news or statistics. If something you would need is missing (for example no excursion data, or an EXTERNAL trade with no plan), say so in the summary and judge only what you can.
- One trade is a sample of one. Do not claim a pattern from it.

Output fields:
- process: GOOD or POOR.
- setupQuality, entryQuality, exitQuality: integers 0 to 100.
- ruleViolations: rules the data shows were broken (empty when none).
- executionIssues: execution problems the data shows, such as slippage or a late exit (empty when none).
- lessons: one to five short, specific lessons from this trade.
- proposals: up to three suggested changes to strategy or risk parameters, each naming the parameter, the suggestion and the reason. A human reviews these; nothing is applied automatically. Leave it empty unless the evidence in this trade is specific.
- summary: two to four sentences.`;

export const POST_TRADE_REVIEW: AiTaskDefinition<PostTradeReviewBrief, PostTradeReviewOutput> = {
  task: 'POST_TRADE_REVIEW',
  system: SYSTEM,
  outputSchema: PostTradeReviewOutputSchema,
  prompt: (brief) =>
    `Review this closed ${brief.trade.direction} trade on ${brief.trade.symbol}. Brief (JSON):\n${JSON.stringify(brief)}`,
};

export function toTradeReview(
  out: PostTradeReviewOutput,
  trade: JournalEntry,
  meta: {
    reviewId: string;
    model: string;
    provider: string;
    sourceKind: string;
    producedAt: string;
  },
): AiTradeReview {
  const outcome = trade.result.outcome;
  return {
    reviewId: meta.reviewId,
    tradeId: trade.tradeId,
    accountId: trade.accountId,
    symbol: trade.symbol,
    strategyId: trade.strategyId,
    model: meta.model,
    provider: meta.provider,
    sourceKind: meta.sourceKind,
    producedAt: meta.producedAt,
    outcome,
    process: out.process,
    classification: `${out.process}_${outcome}`,
    setupQuality: out.setupQuality,
    entryQuality: out.entryQuality,
    exitQuality: out.exitQuality,
    ruleViolations: out.ruleViolations,
    executionIssues: out.executionIssues,
    lessons: out.lessons,
    summary: out.summary,
    proposals: out.proposals.map((p) => ({ ...p, status: 'PROPOSED' as const })),
  };
}
