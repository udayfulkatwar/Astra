/**
 * Anthropic (Claude) provider adapter — server-side only (`@astra/ai/anthropic`).
 *
 * - Structured output: the task's Zod schema goes to the API as `output_config.format`; the
 *   orchestrator still validates the text itself (never trusts the adapter).
 * - Refusals: `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) lets the API re-run
 *   a declined request on Anthropic's recommended fallback model. A final `refusal` stop is
 *   reported as REFUSED — never read as an answer. `max_tokens` is reported as TRUNCATED.
 * - The stable task instructions are prompt-cached; the API key comes from the composition
 *   root (read from the env var NAMED in config), never from config itself.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { AiProvider, AiProviderRequest, AiProviderResponse } from './types';

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly maxRetries: number;
  readonly serverSideFallbacks: boolean;
  /** Tests inject a fetch; production uses the runtime's. */
  readonly fetch?: typeof globalThis.fetch;
  readonly baseURL?: string;
}

export const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic';
  readonly kind = 'LIVE' as const;
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      maxRetries: opts.maxRetries,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async complete(req: AiProviderRequest, signal: AbortSignal): Promise<AiProviderResponse> {
    const format = betaZodOutputFormat(req.outputSchema);
    const message = await this.client.beta.messages.create(
      {
        model: req.model,
        max_tokens: req.maxOutputTokens,
        ...(this.opts.serverSideFallbacks
          ? { betas: [SERVER_SIDE_FALLBACK_BETA], fallbacks: 'default' as const }
          : {}),
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: req.prompt }],
        output_config: {
          format: { type: 'json_schema', schema: format.schema },
          ...(req.effort ? { effort: req.effort } : {}),
        },
      },
      { signal },
    );

    const u = message.usage;
    const usage = {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    };
    const fallbackUsed = (u.iterations ?? []).some((i) => i.type === 'fallback_message');
    const base = { servedModel: message.model, fallbackUsed, usage };

    // Branch on stop_reason before reading content (a refusal may have no content at all).
    if (message.stop_reason === 'refusal') {
      return {
        ...base,
        text: '',
        stop: 'REFUSED',
        refusal: {
          category: message.stop_details?.category ?? null,
          explanation: message.stop_details?.explanation ?? null,
        },
      };
    }
    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (
      message.stop_reason === 'max_tokens' ||
      message.stop_reason === 'model_context_window_exceeded'
    ) {
      return { ...base, text, stop: 'TRUNCATED' };
    }
    return { ...base, text, stop: 'COMPLETE' };
  }
}
