/**
 * Anthropic Claude — language model for prompt enhancement, storyboards and
 * other text tools. Uses the official @anthropic-ai/sdk.
 */
import Anthropic from '@anthropic-ai/sdk';
import { requireCred } from './common.js';
import type { Provider } from './types.js';
import { ProviderError } from './types.js';

const MODEL = 'claude-opus-5-5';

function toProviderError(err: unknown): ProviderError {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError(`Authentication failed: ${err.message}. Check the Anthropic API key in Settings → Providers.`, err.status ?? 401);
  }
  if (err instanceof Anthropic.RateLimitError) return new ProviderError(`Rate limited by Anthropic: ${err.message}`, 429, true);
  if (err instanceof Anthropic.BadRequestError) return new ProviderError(`Anthropic rejected the request: ${err.message}`, 400);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('Anthropic request timed out', 504, true);
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError(`Could not reach Anthropic: ${err.message}`, 504, true);
  if (err instanceof Anthropic.APIError) return new ProviderError(`Anthropic error ${err.status ?? ''}: ${err.message}`, err.status ?? 502, (err.status ?? 500) >= 500);
  return new ProviderError((err as Error).message ?? 'Unknown Anthropic error', 502);
}

export const anthropicProvider: Provider = {
  needsCredentials: true,
  info: {
    id: 'anthropic',
    name: 'Anthropic Claude',
    description: 'Claude for prompt enhancement, shot lists, scene continuation and other text tools.',
    isAI: true,
    categories: ['llm'],
    docsUrl: 'https://platform.claude.com/docs',
    credentialFields: [{ key: 'apiKey', label: 'API key', envVar: 'ANTHROPIC_API_KEY', secret: true, placeholder: 'sk-ant-…' }],
    supportsCancel: false,
    limitations: ['Text only — does not generate images or video.', 'Billed per token by Anthropic.'],
  },
  models: () => [
    { id: MODEL, providerId: 'anthropic', name: 'Claude Opus 5.5', tasks: [], capabilities: {}, docsUrl: 'https://platform.claude.com/docs/en/about-claude/models/overview' },
  ],
  async testConnection(ctx) {
    const client = new Anthropic({ apiKey: requireCred(ctx.creds, 'apiKey', 'Anthropic'), maxRetries: 0, timeout: 15_000 });
    try {
      await client.models.retrieve(MODEL);
      return { ok: true, message: `API key accepted (${MODEL} available)` };
    } catch (err) {
      throw toProviderError(err);
    }
  },
  async llm(req, ctx) {
    const client = new Anthropic({ apiKey: requireCred(ctx.creds, 'apiKey', 'Anthropic'), maxRetries: 2, timeout: 180_000 });
    try {
      const response = await client.beta.messages.create(
        {
          model: MODEL,
          max_tokens: req.maxTokens ?? 16000,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          output_config: { effort: 'medium', ...(req.jsonSchema ? { format: { type: 'json_schema', schema: req.jsonSchema } } : {}) },
          // Retry on Anthropic's recommended model if a safety classifier declines.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        },
        { signal: ctx.signal },
      );
      if (response.stop_reason === 'refusal') throw new ProviderError('Claude declined this request. Rephrase the prompt and try again.', 422);
      const text = response.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (!text) throw new ProviderError('Claude returned an empty response', 502);
      if (response.stop_reason === 'max_tokens') throw new ProviderError('Claude response was cut off (max_tokens); try a shorter request', 502);
      return text;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw toProviderError(err);
    }
  },
};
