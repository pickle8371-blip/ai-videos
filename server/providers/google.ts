/**
 * Google Gemini API — Veo video generation (long-running operations).
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:predictLongRunning
 *        { instances: [{ prompt, image? }], parameters: { aspectRatio, negativePrompt, resolution, personGeneration } }
 *   GET  https://generativelanguage.googleapis.com/v1beta/{operation.name}
 *        -> { done, response.generateVideoResponse.generatedSamples[].video.uri, error }
 * Result URIs are downloaded with the same API key header.
 * See https://ai.google.dev/gemini-api/docs/video
 */
import type { ModelInfo } from '../../shared/api.js';
import { params, pickAspect, pickResolution, promptOf, requireCred } from './common.js';
import { jsonInit, requestJson } from './http.js';
import type { PollResult, Provider, ProviderContext } from './types.js';
import { ProviderError } from './types.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';

const MODELS: ModelInfo[] = [
  {
    id: 'veo-3.0-generate-001',
    providerId: 'google',
    name: 'Veo 3',
    tasks: ['text-to-video', 'image-to-video'],
    capabilities: { durations: [8], aspectRatios: ['16:9', '9:16'], resolutions: ['720p', '1080p'], negativePrompt: true, camera: 'prompt', audio: true, imageInput: 'data-uri' },
    docsUrl: 'https://ai.google.dev/gemini-api/docs/video',
    notes: '8-second clips with native audio. 1080p is available for 16:9 only.',
  },
  {
    id: 'veo-3.0-fast-generate-001',
    providerId: 'google',
    name: 'Veo 3 Fast',
    tasks: ['text-to-video', 'image-to-video'],
    capabilities: { durations: [8], aspectRatios: ['16:9', '9:16'], resolutions: ['720p', '1080p'], negativePrompt: true, camera: 'prompt', audio: true, imageInput: 'data-uri' },
    docsUrl: 'https://ai.google.dev/gemini-api/docs/video',
  },
];

interface Operation {
  name: string;
  done?: boolean;
  error?: { message?: string };
  response?: { generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }>; raiMediaFilteredReasons?: string[] } };
}

const headers = (ctx: ProviderContext) => ({ 'x-goog-api-key': requireCred(ctx.creds, 'apiKey', 'Google Gemini API') });

export const googleProvider: Provider = {
  needsCredentials: true,
  info: {
    id: 'google',
    name: 'Google Gemini API (Veo)',
    description: 'Veo 3 text- and image-to-video through the Gemini API.',
    isAI: true,
    categories: ['video'],
    docsUrl: 'https://ai.google.dev/gemini-api/docs/video',
    credentialFields: [{ key: 'apiKey', label: 'Gemini API key', envVar: 'GEMINI_API_KEY', secret: true, placeholder: 'AIza…' }],
    supportsCancel: false,
    limitations: ['Requires a paid Gemini API tier with Veo access.', 'Cancellation is not supported by the API; canceling stops tracking the job.', 'Generated videos are retained by Google for a limited time; Voidcraft downloads them immediately.'],
  },
  models: () => MODELS,
  async testConnection(ctx) {
    await requestJson(ctx.fetch, `${API}/models?pageSize=1`, jsonInit('GET', headers(ctx)), { retries: 0, timeoutMs: 15_000 });
    return { ok: true, message: 'API key accepted' };
  },
  async submit(job, model, ctx) {
    const p = params(job);
    const aspect = pickAspect(model, p.aspectRatio);
    const instance: Record<string, unknown> = { prompt: promptOf(job) };
    if (job.task === 'image-to-video') {
      if (!p.startImageAssetId) throw new ProviderError('A start image is required', 400);
      const uri = await ctx.assetDataUri(p.startImageAssetId, { maxBytes: 8 * 1024 * 1024, maxDim: 1920 });
      const [, mimeType, b64] = /^data:([^;]+);base64,(.*)$/.exec(uri) ?? [];
      instance.image = { bytesBase64Encoded: b64, mimeType };
    }
    const parameters: Record<string, unknown> = { aspectRatio: aspect };
    const res = pickResolution(model, p.resolution);
    if (res && !(res === '1080p' && aspect !== '16:9')) parameters.resolution = res;
    if (p.negativePrompt) parameters.negativePrompt = p.negativePrompt;
    const op = await requestJson<Operation>(ctx.fetch, `${API}/models/${model.id}:predictLongRunning`, jsonInit('POST', headers(ctx), { instances: [instance], parameters }), { signal: ctx.signal, retries: 2 });
    if (!op.name) throw new ProviderError('Gemini API did not return an operation', 502);
    return { providerJobId: op.name };
  },
  async poll(job, model, ctx): Promise<PollResult> {
    if (!/^[A-Za-z0-9/._-]+$/.test(job.providerJobId ?? '')) return { status: 'failed', error: 'Invalid operation name' };
    const op = await requestJson<Operation>(ctx.fetch, `${API}/${job.providerJobId}`, jsonInit('GET', headers(ctx)), { signal: ctx.signal });
    if (!op.done) return { status: 'running', message: 'Generating' };
    if (op.error) return { status: 'failed', error: op.error.message ?? 'Generation failed' };
    const samples = op.response?.generateVideoResponse?.generatedSamples ?? [];
    const filtered = op.response?.generateVideoResponse?.raiMediaFilteredReasons;
    const uris = samples.map((s) => s.video?.uri).filter((u): u is string => Boolean(u));
    if (!uris.length) return { status: 'failed', error: filtered?.length ? `Blocked by safety filters: ${filtered.join('; ')}` : 'No video returned' };
    return { status: 'succeeded', outputs: uris.map((url, i) => ({
        kind: 'url',
        url,
        name: `${model.id}-${i + 1}.mp4`,
        // Only send the key back to Google's own download host.
        headers: /^https:\/\/generativelanguage\.googleapis\.com\//.test(url) ? headers(ctx) : undefined,
      })) };
  },
};

