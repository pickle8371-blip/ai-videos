/**
 * Replicate — https://replicate.com/docs/reference/http
 * Uses the official-model predictions endpoint:
 *   POST /v1/models/{owner}/{name}/predictions   { input }
 *   GET  /v1/predictions/{id}
 *   POST /v1/predictions/{id}/cancel
 * Model input names differ per model; the built-in catalog maps Voidcraft
 * parameters to each model's documented inputs, and custom models can be
 * registered with an input template in Settings.
 */
import type { AppSettings, JobRecord, ModelInfo } from '../../shared/api.js';
import { collectUrls, extFromUrl, fillTemplate, params, pickAspect, pickDuration, pickResolution, promptOf, requireCred } from './common.js';
import { jsonInit, requestJson } from './http.js';
import type { PollResult, Provider, ProviderContext } from './types.js';
import { ProviderError } from './types.js';

const API = 'https://api.replicate.com/v1';

type InputBuilder = (job: JobRecord, model: ModelInfo, ctx: ProviderContext) => Promise<Record<string, unknown>>;

interface CatalogEntry extends ModelInfo {
  build: InputBuilder;
}

const img = async (ctx: ProviderContext, id: string | null | undefined) => (id ? ctx.assetDataUri(id, { maxBytes: 7 * 1024 * 1024, maxDim: 2048 }) : undefined);

const CATALOG: CatalogEntry[] = [
  {
    id: 'google/veo-3',
    providerId: 'replicate',
    name: 'Google Veo 3 (via Replicate)',
    tasks: ['text-to-video', 'image-to-video'],
    capabilities: { durations: [8], aspectRatios: ['16:9', '9:16'], resolutions: ['720p', '1080p'], negativePrompt: true, seed: true, camera: 'prompt', audio: true, imageInput: 'data-uri' },
    docsUrl: 'https://replicate.com/google/veo-3',
    notes: 'Generates synchronized audio. Billed per second by Replicate.',
    build: async (job, model, ctx) => {
      const p = params(job);
      return {
        prompt: promptOf(job),
        negative_prompt: p.negativePrompt || undefined,
        aspect_ratio: pickAspect(model, p.aspectRatio),
        resolution: pickResolution(model, p.resolution),
        seed: p.seed ?? undefined,
        image: await img(ctx, p.startImageAssetId),
      };
    },
  },
  {
    id: 'bytedance/seedance-1-pro',
    providerId: 'replicate',
    name: 'Seedance 1 Pro (via Replicate)',
    tasks: ['text-to-video', 'image-to-video'],
    capabilities: { durations: [5, 10], aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], resolutions: ['480p', '1080p'], fps: [24], seed: true, camera: 'prompt', imageInput: 'data-uri' },
    docsUrl: 'https://replicate.com/bytedance/seedance-1-pro',
    build: async (job, model, ctx) => {
      const p = params(job);
      return {
        prompt: promptOf(job),
        duration: pickDuration(model, p.duration),
        resolution: pickResolution(model, p.resolution === '720p' ? '480p' : p.resolution),
        aspect_ratio: pickAspect(model, p.aspectRatio),
        fps: 24,
        camera_fixed: p.camera?.move === 'static',
        seed: p.seed ?? undefined,
        image: await img(ctx, p.startImageAssetId),
      };
    },
  },
  {
    id: 'minimax/video-01',
    providerId: 'replicate',
    name: 'MiniMax Video-01 / Hailuo (via Replicate)',
    tasks: ['text-to-video', 'image-to-video'],
    capabilities: { durations: [6], aspectRatios: ['16:9'], resolutions: ['720p'], camera: 'prompt', imageInput: 'data-uri' },
    docsUrl: 'https://replicate.com/minimax/video-01',
    notes: 'Fixed 6 s, 720p, 25 fps.',
    build: async (job, _model, ctx) => {
      const p = params(job);
      return { prompt: promptOf(job), prompt_optimizer: true, first_frame_image: await img(ctx, p.startImageAssetId) };
    },
  },
  {
    id: 'kwaivgi/kling-v2.1',
    providerId: 'replicate',
    name: 'Kling 2.1 (via Replicate)',
    tasks: ['image-to-video'],
    capabilities: { durations: [5, 10], negativePrompt: true, endFrame: true, camera: 'prompt', imageInput: 'data-uri' },
    docsUrl: 'https://replicate.com/kwaivgi/kling-v2.1',
    notes: 'Image-to-video only on this endpoint. End frame requires "pro" mode.',
    build: async (job, model, ctx) => {
      const p = params(job);
      if (!p.startImageAssetId) throw new ProviderError('Kling 2.1 requires a start image', 400);
      return {
        prompt: promptOf(job),
        start_image: await img(ctx, p.startImageAssetId),
        end_image: await img(ctx, p.endImageAssetId),
        mode: p.endImageAssetId ? 'pro' : p.resolution === '1080p' ? 'pro' : 'standard',
        duration: pickDuration(model, p.duration),
        negative_prompt: p.negativePrompt || undefined,
      };
    },
  },
  {
    id: 'black-forest-labs/flux-schnell',
    providerId: 'replicate',
    name: 'FLUX.1 [schnell] (via Replicate)',
    tasks: ['text-to-image'],
    capabilities: { aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], maxVariations: 4, seed: true },
    docsUrl: 'https://replicate.com/black-forest-labs/flux-schnell',
    build: async (job, model) => {
      const p = params(job);
      return { prompt: promptOf(job), aspect_ratio: pickAspect(model, p.aspectRatio), num_outputs: Math.min(4, p.variations ?? 1), output_format: 'png', seed: p.seed ?? undefined };
    },
  },
];

function customModels(settings: AppSettings): CatalogEntry[] {
  return (settings.providers.replicate?.customModels ?? []).map((m) => ({
    id: m.id,
    providerId: 'replicate',
    name: m.name,
    tasks: m.tasks,
    custom: true,
    notes: m.notes ?? 'Custom model with user-defined input template.',
    capabilities: { camera: 'prompt', negativePrompt: JSON.stringify(m.inputTemplate).includes('negative_prompt'), seed: JSON.stringify(m.inputTemplate).includes('{{seed}}'), imageInput: 'data-uri' },
    build: async (job, model, ctx) => {
      const p = params(job);
      const values: Record<string, unknown> = {
        prompt: promptOf(job),
        negative_prompt: p.negativePrompt ?? '',
        duration: p.duration,
        aspect_ratio: p.aspectRatio,
        seed: p.seed ?? null,
        image: await img(ctx, p.startImageAssetId ?? (job.params as { sourceAssetId?: string }).sourceAssetId),
        end_image: await img(ctx, p.endImageAssetId),
        video: p.sourceVideoAssetId ? ctx.publicAssetUrl(p.sourceVideoAssetId) : null,
        audio: p.audioAssetId ? ctx.publicAssetUrl(p.audioAssetId) : null,
        text: p.text ?? '',
      };
      return fillTemplate(m.inputTemplate, values) as Record<string, unknown>;
    },
  }));
}

function allModels(settings: AppSettings): CatalogEntry[] {
  return [...CATALOG, ...customModels(settings)];
}

interface Prediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: unknown;
  error?: string | null;
  logs?: string;
}

const headers = (ctx: ProviderContext) => ({ Authorization: `Bearer ${requireCred(ctx.creds, 'apiToken', 'Replicate')}` });

function progressFromLogs(logs: string | undefined): number | null {
  if (!logs) return null;
  const matches = [...logs.matchAll(/(\d{1,3})%\|/g)];
  if (!matches.length) return null;
  return Math.min(1, Number(matches[matches.length - 1][1]) / 100);
}

export const replicateProvider: Provider = {
  needsCredentials: true,
  info: {
    id: 'replicate',
    name: 'Replicate',
    description: 'Hosted open and commercial models (Veo, Seedance, Kling, MiniMax, FLUX) plus any custom Replicate model.',
    isAI: true,
    categories: ['video', 'image', 'tools'],
    docsUrl: 'https://replicate.com/docs',
    credentialFields: [{ key: 'apiToken', label: 'API token', envVar: 'REPLICATE_API_TOKEN', secret: true, placeholder: 'r8_…' }],
    supportsCancel: true,
    limitations: [
      'Model input names change between model versions — verify on the model page and use a custom model template if needed.',
      'Reference images are sent as data URIs (≤ ~7 MB after downscaling).',
      'Video/audio inputs for custom models require VOIDCRAFT_PUBLIC_URL so Replicate can fetch them.',
      'Usage is billed by Replicate per second or per output; see each model page.',
    ],
  },
  models: (settings) => allModels(settings).map(({ build: _b, ...m }) => m),
  async testConnection(ctx) {
    const acct = await requestJson<{ username?: string }>(ctx.fetch, `${API}/account`, jsonInit('GET', headers(ctx)), { retries: 0, timeoutMs: 15_000 });
    return { ok: true, message: `Connected as ${acct.username ?? 'unknown account'}` };
  },
  async submit(job, model, ctx) {
    const entry = allModels(ctx.settings).find((m) => m.id === model.id);
    if (!entry) throw new ProviderError(`Unknown Replicate model ${model.id}`, 400);
    const input = await entry.build(job, model, ctx);
    for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];
    const [owner, name] = model.id.split(':')[0].split('/');
    const version = model.id.includes(':') ? model.id.split(':')[1] : null;
    const pred = version
      ? await requestJson<Prediction>(ctx.fetch, `${API}/predictions`, jsonInit('POST', headers(ctx), { version, input }), { signal: ctx.signal, retries: 2 })
      : await requestJson<Prediction>(ctx.fetch, `${API}/models/${owner}/${name}/predictions`, jsonInit('POST', headers(ctx), { input }), { signal: ctx.signal, retries: 2 });
    if (!pred.id) throw new ProviderError('Replicate did not return a prediction id', 502);
    return { providerJobId: pred.id };
  },
  async poll(job, model, ctx): Promise<PollResult> {
    const pred = await requestJson<Prediction>(ctx.fetch, `${API}/predictions/${encodeURIComponent(job.providerJobId!)}`, jsonInit('GET', headers(ctx)), { signal: ctx.signal });
    switch (pred.status) {
      case 'succeeded': {
        const urls = collectUrls(pred.output);
        if (!urls.length) return { status: 'failed', error: 'Replicate reported success but returned no output file' };
        const isImage = model.tasks.includes('text-to-image') && !model.tasks.some((t) => t.includes('video'));
        return { status: 'succeeded', outputs: urls.map((url, i) => ({ kind: 'url', url, name: `${model.id.split('/').pop()}-${i + 1}.${extFromUrl(url, isImage ? 'png' : 'mp4')}` })) };
      }
      case 'failed':
        return { status: 'failed', error: pred.error ?? 'Prediction failed' };
      case 'canceled':
        return { status: 'canceled' };
      default:
        return { status: 'running', progress: progressFromLogs(pred.logs), message: pred.status === 'starting' ? 'Starting (model may be cold-booting)' : 'Processing' };
    }
  },
  async cancel(job, _model, ctx) {
    if (!job.providerJobId) return;
    await requestJson(ctx.fetch, `${API}/predictions/${encodeURIComponent(job.providerJobId)}/cancel`, jsonInit('POST', headers(ctx)), { retries: 1 });
  },
};
