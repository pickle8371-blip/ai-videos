/**
 * Runway API — https://docs.dev.runwayml.com/api
 *   POST /v1/image_to_video   { model, promptImage, promptText, ratio, duration, seed }
 *   GET  /v1/tasks/{id}       -> { status: PENDING|THROTTLED|RUNNING|SUCCEEDED|FAILED|CANCELLED, progress, output[], failure }
 *   DELETE /v1/tasks/{id}     (cancel / delete)
 * Header X-Runway-Version is required.
 */
import type { ModelInfo } from '../../shared/api.js';
import type { AspectRatio } from '../../shared/project.js';
import { params, pickAspect, pickDuration, promptOf, requireCred } from './common.js';
import { jsonInit, requestJson } from './http.js';
import type { PollResult, Provider, ProviderContext } from './types.js';
import { ProviderError } from './types.js';

const API = 'https://api.dev.runwayml.com/v1';
const VERSION = '2024-11-06';

const RATIOS: Partial<Record<AspectRatio, string>> = { '16:9': '1280:720', '9:16': '720:1280', '4:3': '1104:832', '3:4': '832:1104', '1:1': '960:960', '21:9': '1584:672' };

const MODELS: ModelInfo[] = [
  {
    id: 'gen4_turbo',
    providerId: 'runway',
    name: 'Runway Gen-4 Turbo',
    tasks: ['image-to-video'],
    capabilities: { durations: [5, 10], aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'], seed: true, camera: 'prompt', imageInput: 'data-uri' },
    docsUrl: 'https://docs.dev.runwayml.com/guides/models',
    notes: 'Requires a start image. Credits are billed per second of output.',
  },
];

interface Task {
  id: string;
  status: 'PENDING' | 'THROTTLED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  progress?: number;
  output?: string[];
  failure?: string;
  failureCode?: string;
}

const headers = (ctx: ProviderContext) => ({ Authorization: `Bearer ${requireCred(ctx.creds, 'apiKey', 'Runway')}`, 'X-Runway-Version': VERSION });

export const runwayProvider: Provider = {
  needsCredentials: true,
  info: {
    id: 'runway',
    name: 'Runway',
    description: 'Gen-4 Turbo image-to-video.',
    isAI: true,
    categories: ['video'],
    docsUrl: 'https://docs.dev.runwayml.com',
    credentialFields: [{ key: 'apiKey', label: 'API secret', envVar: 'RUNWAYML_API_SECRET', secret: true, placeholder: 'key_…' }],
    supportsCancel: true,
    limitations: ['Image-to-video only (a start image is required).', 'Prompt images are sent as data URIs (max ~5 MB).'],
  },
  models: () => MODELS,
  async submit(job, model, ctx) {
    const p = params(job);
    if (!p.startImageAssetId) throw new ProviderError('Runway Gen-4 Turbo requires a start image', 400);
    const body = {
      model: model.id,
      promptImage: await ctx.assetDataUri(p.startImageAssetId, { maxBytes: 4.5 * 1024 * 1024, maxDim: 1920 }),
      promptText: promptOf(job).slice(0, 1000),
      ratio: RATIOS[pickAspect(model, p.aspectRatio)],
      duration: pickDuration(model, p.duration),
      ...(typeof p.seed === 'number' ? { seed: p.seed } : {}),
    };
    const t = await requestJson<{ id: string }>(ctx.fetch, `${API}/image_to_video`, jsonInit('POST', headers(ctx), body), { signal: ctx.signal, retries: 2 });
    if (!t.id) throw new ProviderError('Runway did not return a task id', 502);
    return { providerJobId: t.id };
  },
  async poll(job, _m, ctx): Promise<PollResult> {
    const t = await requestJson<Task>(ctx.fetch, `${API}/tasks/${encodeURIComponent(job.providerJobId!)}`, jsonInit('GET', headers(ctx)), { signal: ctx.signal });
    switch (t.status) {
      case 'SUCCEEDED':
        if (!t.output?.length) return { status: 'failed', error: 'Runway succeeded without output' };
        return { status: 'succeeded', outputs: t.output.map((url, i) => ({ kind: 'url', url, name: `runway-${i + 1}.mp4` })) };
      case 'FAILED':
        return { status: 'failed', error: t.failure ?? t.failureCode ?? 'Task failed' };
      case 'CANCELLED':
        return { status: 'canceled' };
      default:
        return { status: 'running', progress: typeof t.progress === 'number' ? t.progress : null, message: t.status === 'THROTTLED' ? 'Throttled by Runway (queued)' : t.status.toLowerCase() };
    }
  },
  async cancel(job, _m, ctx) {
    if (job.providerJobId) await requestJson(ctx.fetch, `${API}/tasks/${encodeURIComponent(job.providerJobId)}`, jsonInit('DELETE', headers(ctx)), { retries: 1, okStatuses: [404] });
  },
};
