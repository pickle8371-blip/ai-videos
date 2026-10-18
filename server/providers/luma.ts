/**
 * Luma Dream Machine API — https://docs.lumalabs.ai/docs/api
 *   POST /dream-machine/v1/generations         (video: ray-2, ray-flash-2)
 *   POST /dream-machine/v1/generations/image   (image: photon-1)
 *   GET  /dream-machine/v1/generations/{id}    -> { state: queued|dreaming|completed|failed, assets, failure_reason }
 *   DELETE /dream-machine/v1/generations/{id}
 * Keyframe images must be public URLs, so image-to-video needs VOIDCRAFT_PUBLIC_URL.
 */
import type { ModelInfo } from '../../shared/api.js';
import { params, pickAspect, pickDuration, pickResolution, promptOf, requireCred } from './common.js';
import { jsonInit, requestJson } from './http.js';
import type { PollResult, Provider, ProviderContext } from './types.js';
import { ProviderError } from './types.js';

const API = 'https://api.lumalabs.ai/dream-machine/v1';
const ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const;

function models(publicUrl: boolean): ModelInfo[] {
  const videoTasks: ModelInfo['tasks'] = publicUrl ? ['text-to-video', 'image-to-video'] : ['text-to-video'];
  const v = (id: string, name: string): ModelInfo => ({
    id,
    providerId: 'luma',
    name,
    tasks: videoTasks,
    capabilities: { durations: [5, 9], aspectRatios: [...ASPECTS], resolutions: ['540p', '720p', '1080p'], endFrame: publicUrl, camera: 'prompt', imageInput: 'public-url' },
    docsUrl: 'https://docs.lumalabs.ai/docs/video-generation',
    notes: publicUrl ? undefined : 'Image-to-video is disabled: Luma fetches keyframes by URL. Set VOIDCRAFT_PUBLIC_URL to a publicly reachable address to enable it.',
  });
  return [
    v('ray-2', 'Luma Ray 2'),
    v('ray-flash-2', 'Luma Ray Flash 2'),
    {
      id: 'photon-1',
      providerId: 'luma',
      name: 'Luma Photon (images)',
      tasks: ['text-to-image'],
      capabilities: { aspectRatios: [...ASPECTS] },
      docsUrl: 'https://docs.lumalabs.ai/docs/image-generation',
    },
  ];
}

interface Gen {
  id: string;
  state: 'queued' | 'dreaming' | 'completed' | 'failed';
  failure_reason?: string | null;
  assets?: { video?: string; image?: string } | null;
}

const headers = (ctx: ProviderContext) => ({ Authorization: `Bearer ${requireCred(ctx.creds, 'apiKey', 'Luma')}` });

export const lumaProvider: Provider = {
  needsCredentials: true,
  info: {
    id: 'luma',
    name: 'Luma AI',
    description: 'Dream Machine Ray 2 video and Photon image models.',
    isAI: true,
    categories: ['video', 'image'],
    docsUrl: 'https://docs.lumalabs.ai/docs/api',
    credentialFields: [{ key: 'apiKey', label: 'API key', envVar: 'LUMA_API_KEY', secret: true, placeholder: 'luma-…' }],
    supportsCancel: true,
    limitations: ['Keyframe/reference images must be reachable by public URL (VOIDCRAFT_PUBLIC_URL).', 'Billed per generation by Luma.'],
  },
  models: (_s, config) => models(Boolean(config.publicBaseUrl)),
  async submit(job, model, ctx) {
    const p = params(job);
    if (model.id === 'photon-1') {
      const g = await requestJson<Gen>(ctx.fetch, `${API}/generations/image`, jsonInit('POST', headers(ctx), { prompt: promptOf(job), model: 'photon-1', aspect_ratio: pickAspect(model, p.aspectRatio) }), { signal: ctx.signal, retries: 2 });
      return { providerJobId: g.id };
    }
    const body: Record<string, unknown> = {
      prompt: promptOf(job),
      model: model.id,
      aspect_ratio: pickAspect(model, p.aspectRatio),
      duration: `${pickDuration(model, p.duration)}s`,
      resolution: pickResolution(model, p.resolution),
    };
    if (job.task === 'image-to-video') {
      const start = p.startImageAssetId ? ctx.publicAssetUrl(p.startImageAssetId) : null;
      if (!start) throw new ProviderError('Luma image-to-video needs VOIDCRAFT_PUBLIC_URL so Luma can download the keyframe image.', 400);
      const keyframes: Record<string, unknown> = { frame0: { type: 'image', url: start } };
      const end = p.endImageAssetId ? ctx.publicAssetUrl(p.endImageAssetId) : null;
      if (end) keyframes.frame1 = { type: 'image', url: end };
      body.keyframes = keyframes;
    }
    const g = await requestJson<Gen>(ctx.fetch, `${API}/generations`, jsonInit('POST', headers(ctx), body), { signal: ctx.signal, retries: 2 });
    if (!g.id) throw new ProviderError('Luma did not return a generation id', 502);
    return { providerJobId: g.id };
  },
  async poll(job, model, ctx): Promise<PollResult> {
    const g = await requestJson<Gen>(ctx.fetch, `${API}/generations/${encodeURIComponent(job.providerJobId!)}`, jsonInit('GET', headers(ctx)), { signal: ctx.signal });
    if (g.state === 'failed') return { status: 'failed', error: g.failure_reason ?? 'Generation failed' };
    if (g.state !== 'completed') return { status: 'running', message: g.state === 'queued' ? 'Queued' : 'Dreaming' };
    const url = model.id === 'photon-1' ? g.assets?.image : g.assets?.video;
    if (!url) return { status: 'failed', error: 'Luma completed without an output URL' };
    return { status: 'succeeded', outputs: [{ kind: 'url', url, name: `luma-${model.id}.${model.id === 'photon-1' ? 'jpg' : 'mp4'}` }] };
  },
  async cancel(job, _m, ctx) {
    if (job.providerJobId) await requestJson(ctx.fetch, `${API}/generations/${encodeURIComponent(job.providerJobId)}`, jsonInit('DELETE', headers(ctx)), { retries: 1, okStatuses: [404] });
  },
};
