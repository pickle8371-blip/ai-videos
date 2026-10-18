/**
 * fal.ai queue API — https://docs.fal.ai/model-endpoints/queue
 *   POST https://queue.fal.run/{model_id}            -> { request_id, status_url, response_url, cancel_url }
 *   GET  {status_url}                                -> { status: IN_QUEUE | IN_PROGRESS | COMPLETED }
 *   GET  {response_url}                              -> model output
 *   PUT  {cancel_url}
 * Auth header: "Authorization: Key <FAL_KEY>". File inputs accept data URIs.
 */
import type { AppSettings, JobRecord, ModelInfo } from '../../shared/api.js';
import { collectUrls, extFromUrl, fillTemplate, params, pickAspect, pickDuration, pickResolution, promptOf, requireCred } from './common.js';
import { jsonInit, requestJson } from './http.js';
import type { PollResult, Provider, ProviderContext } from './types.js';
import { ProviderError } from './types.js';

const QUEUE = 'https://queue.fal.run';

type Build = (job: JobRecord, model: ModelInfo, ctx: ProviderContext) => Promise<Record<string, unknown>>;
interface Entry extends ModelInfo {
  build: Build;
}

const img = (ctx: ProviderContext, id: string | null | undefined) => (id ? ctx.assetDataUri(id, { maxBytes: 8 * 1024 * 1024, maxDim: 2048 }) : Promise.resolve(undefined));

const CATALOG: Entry[] = [
  {
    id: 'fal-ai/kling-video/v2.1/master/text-to-video',
    providerId: 'fal',
    name: 'Kling 2.1 Master — text to video',
    tasks: ['text-to-video'],
    capabilities: { durations: [5, 10], aspectRatios: ['16:9', '9:16', '1:1'], negativePrompt: true, camera: 'prompt' },
    docsUrl: 'https://fal.ai/models/fal-ai/kling-video/v2.1/master/text-to-video/api',
    build: async (job, model) => {
      const p = params(job);
      return { prompt: promptOf(job), duration: String(pickDuration(model, p.duration)), aspect_ratio: pickAspect(model, p.aspectRatio), negative_prompt: p.negativePrompt || undefined };
    },
  },
  {
    id: 'fal-ai/kling-video/v2.1/master/image-to-video',
    providerId: 'fal',
    name: 'Kling 2.1 Master — image to video',
    tasks: ['image-to-video'],
    capabilities: { durations: [5, 10], negativePrompt: true, camera: 'prompt', imageInput: 'data-uri' },
    docsUrl: 'https://fal.ai/models/fal-ai/kling-video/v2.1/master/image-to-video/api',
    build: async (job, model, ctx) => {
      const p = params(job);
      if (!p.startImageAssetId) throw new ProviderError('A start image is required', 400);
      return { prompt: promptOf(job), image_url: await img(ctx, p.startImageAssetId), duration: String(pickDuration(model, p.duration)), negative_prompt: p.negativePrompt || undefined };
    },
  },
  {
    id: 'fal-ai/minimax/hailuo-02/standard/text-to-video',
    providerId: 'fal',
    name: 'MiniMax Hailuo-02 — text to video',
    tasks: ['text-to-video'],
    capabilities: { durations: [6, 10], aspectRatios: ['16:9'], resolutions: ['768p'], camera: 'prompt' },
    docsUrl: 'https://fal.ai/models/fal-ai/minimax/hailuo-02/standard/text-to-video/api',
    build: async (job, model) => ({ prompt: promptOf(job), duration: String(pickDuration(model, params(job).duration)), prompt_optimizer: true }),
  },
  {
    id: 'fal-ai/veo3',
    providerId: 'fal',
    name: 'Google Veo 3 (via fal)',
    tasks: ['text-to-video'],
    capabilities: { durations: [8], aspectRatios: ['16:9', '9:16'], resolutions: ['720p', '1080p'], negativePrompt: true, seed: true, camera: 'prompt', audio: true },
    docsUrl: 'https://fal.ai/models/fal-ai/veo3/api',
    build: async (job, model) => {
      const p = params(job);
      return {
        prompt: promptOf(job),
        aspect_ratio: pickAspect(model, p.aspectRatio),
        duration: '8s',
        resolution: pickResolution(model, p.resolution),
        negative_prompt: p.negativePrompt || undefined,
        seed: p.seed ?? undefined,
        generate_audio: true,
      };
    },
  },
  {
    id: 'fal-ai/flux/schnell',
    providerId: 'fal',
    name: 'FLUX.1 [schnell] — images',
    tasks: ['text-to-image'],
    capabilities: { aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'], maxVariations: 4, seed: true },
    docsUrl: 'https://fal.ai/models/fal-ai/flux/schnell/api',
    build: async (job, model) => {
      const p = params(job);
      const sizes: Record<string, string> = { '16:9': 'landscape_16_9', '9:16': 'portrait_16_9', '1:1': 'square_hd', '4:3': 'landscape_4_3', '3:4': 'portrait_4_3' };
      return { prompt: promptOf(job), image_size: sizes[pickAspect(model, p.aspectRatio)], num_images: Math.min(4, p.variations ?? 1), seed: p.seed ?? undefined };
    },
  },
];

function customModels(settings: AppSettings): Entry[] {
  return (settings.providers.fal?.customModels ?? []).map((m) => ({
    id: m.id,
    providerId: 'fal',
    name: m.name,
    tasks: m.tasks,
    custom: true,
    notes: m.notes ?? 'Custom fal endpoint with user-defined input template.',
    capabilities: { camera: 'prompt', imageInput: 'data-uri' },
    build: async (job, _model, ctx) => {
      const p = params(job);
      return fillTemplate(m.inputTemplate, {
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
      }) as Record<string, unknown>;
    },
  }));
}

const all = (s: AppSettings) => [...CATALOG, ...customModels(s)];
const headers = (ctx: ProviderContext) => ({ Authorization: `Key ${requireCred(ctx.creds, 'apiKey', 'fal.ai')}` });

function assertFalUrl(u: unknown): string {
  if (typeof u !== 'string' || !/^https:\/\/([a-z0-9-]+\.)*fal\.(run|ai)\//.test(u)) throw new ProviderError('fal returned an unexpected queue URL', 502);
  return u;
}

export const falProvider: Provider = {
  needsCredentials: true,
  info: {
    id: 'fal',
    name: 'fal.ai',
    description: 'Fast hosted inference for Kling, MiniMax Hailuo, Veo and FLUX via the fal queue API.',
    isAI: true,
    categories: ['video', 'image', 'tools'],
    docsUrl: 'https://docs.fal.ai',
    credentialFields: [{ key: 'apiKey', label: 'API key', envVar: 'FAL_KEY', secret: true, placeholder: 'key-id:key-secret' }],
    supportsCancel: true,
    limitations: ['Billed per output by fal; prices vary per model.', 'Images are sent as data URIs.', 'Model inputs can change; custom endpoints can be added in Settings.'],
  },
  models: (s) => all(s).map(({ build: _b, ...m }) => m),
  async submit(job, model, ctx) {
    const entry = all(ctx.settings).find((m) => m.id === model.id);
    if (!entry) throw new ProviderError(`Unknown fal model ${model.id}`, 400);
    const input = await entry.build(job, model, ctx);
    for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];
    const r = await requestJson<{ request_id: string; status_url: string; response_url: string; cancel_url: string }>(
      ctx.fetch,
      `${QUEUE}/${model.id}`,
      jsonInit('POST', headers(ctx), input),
      { signal: ctx.signal, retries: 2 },
    );
    if (!r.request_id) throw new ProviderError('fal did not return a request id', 502);
    return { providerJobId: r.request_id, state: { statusUrl: assertFalUrl(r.status_url), responseUrl: assertFalUrl(r.response_url), cancelUrl: assertFalUrl(r.cancel_url) } };
  },
  async poll(job, model, ctx): Promise<PollResult> {
    const st = job.providerState as { statusUrl: string; responseUrl: string };
    const s = await requestJson<{ status: string; queue_position?: number }>(ctx.fetch, assertFalUrl(st.statusUrl), jsonInit('GET', headers(ctx)), { signal: ctx.signal });
    if (s.status === 'IN_QUEUE') return { status: 'running', progress: null, message: s.queue_position !== undefined ? `In queue (position ${s.queue_position})` : 'In queue' };
    if (s.status === 'IN_PROGRESS') return { status: 'running', progress: null, message: 'Generating' };
    if (s.status !== 'COMPLETED') return { status: 'running', message: s.status };
    let out: Record<string, unknown>;
    try {
      out = await requestJson<Record<string, unknown>>(ctx.fetch, assertFalUrl(st.responseUrl), jsonInit('GET', headers(ctx)), { signal: ctx.signal, retries: 2 });
    } catch (err) {
      return { status: 'failed', error: (err as Error).message };
    }
    const preferred = out.video ?? out.videos ?? out.images ?? out.image ?? out.audio ?? out;
    const urls = collectUrls(preferred);
    if (!urls.length) return { status: 'failed', error: 'fal completed but returned no output file' };
    const isImage = model.tasks.includes('text-to-image');
    return { status: 'succeeded', outputs: urls.map((url, i) => ({ kind: 'url', url, name: `${model.id.split('/').slice(-2).join('-')}-${i + 1}.${extFromUrl(url, isImage ? 'png' : 'mp4')}` })) };
  },
  async cancel(job, _model, ctx) {
    const st = job.providerState as { cancelUrl?: string };
    if (st.cancelUrl) await requestJson(ctx.fetch, assertFalUrl(st.cancelUrl), jsonInit('PUT', headers(ctx)), { retries: 1, okStatuses: [400, 404] });
  },
};
