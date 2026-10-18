/**
 * Mocked provider adapter tests: verify request shapes and response mapping
 * without calling any real (paid) API.
 */
import { describe, expect, it, vi } from 'vitest';
import type { JobRecord, ModelInfo } from '../../shared/api';
import { replicateProvider } from '../../server/providers/replicate';
import { falProvider } from '../../server/providers/fal';
import { runwayProvider } from '../../server/providers/runway';
import { lumaProvider } from '../../server/providers/luma';
import { googleProvider } from '../../server/providers/google';
import { openaiProvider } from '../../server/providers/openai';
import type { Provider, ProviderContext } from '../../server/providers/types';
import { DEFAULT_SETTINGS } from '../../server/storage/settings';
import { loadConfig } from '../../server/config';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const config = loadConfig({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vc-prov-')) });

function job(task: JobRecord['task'], params: Record<string, unknown>, extra: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job_1', task, providerId: 'x', modelId: 'm', projectId: null, shotId: null, status: 'running', progress: null, message: null,
    params: { prompt: 'a cat', compiledPrompt: 'a cat. Camera: slow push-in', ...params }, providerJobId: null, providerState: {}, outputAssetIds: [], result: null, error: null,
    attempts: 1, createdAt: '', updatedAt: '', startedAt: null, finishedAt: null, retryOf: null, ...extra,
  };
}

function ctx(fetchImpl: typeof fetch, creds: Record<string, string>): ProviderContext {
  return {
    creds,
    fetch: fetchImpl,
    assets: { tmpDir: os.tmpdir() } as never,
    config,
    settings: DEFAULT_SETTINGS,
    signal: new AbortController().signal,
    assetDataUri: async () => 'data:image/png;base64,AAAA',
    publicAssetUrl: (id) => `https://public.example/media/${id}`,
    assetPath: () => '/dev/null',
  };
}

function mockFetch(responses: Array<[RegExp, number, unknown]>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const hit = responses.find(([re]) => re.test(url));
    if (!hit) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(hit[2]), { status: hit[1], headers: { 'content-type': 'application/json' } });
  });
  return { f: f as unknown as typeof fetch, calls };
}

const model = (p: Provider, id: string): ModelInfo => p.models(DEFAULT_SETTINGS, config).find((m) => m.id === id)!;

describe('Replicate adapter', () => {
  it('submits to the model predictions endpoint with mapped inputs and maps output', async () => {
    const { f, calls } = mockFetch([
      [/\/models\/google\/veo-3\/predictions$/, 201, { id: 'pred_1', status: 'starting' }],
      [/\/predictions\/pred_1$/, 200, { id: 'pred_1', status: 'succeeded', output: 'https://replicate.delivery/out.mp4' }],
      [/\/predictions\/pred_1\/cancel$/, 200, { id: 'pred_1', status: 'canceled' }],
    ]);
    const m = model(replicateProvider, 'google/veo-3');
    const c = ctx(f, { apiToken: 'r8_test' });
    const sub = await replicateProvider.submit!(job('text-to-video', { aspectRatio: '9:16', negativePrompt: 'blur', resolution: '1080p' }), m, c);
    expect(sub.providerJobId).toBe('pred_1');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.input).toMatchObject({ prompt: 'a cat. Camera: slow push-in', aspect_ratio: '9:16', negative_prompt: 'blur', resolution: '1080p' });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer r8_test');
    const res = await replicateProvider.poll!(job('text-to-video', {}, { providerJobId: 'pred_1' }), m, c);
    expect(res.status).toBe('succeeded');
    expect(res.status === 'succeeded' && res.outputs[0]).toMatchObject({ kind: 'url', url: 'https://replicate.delivery/out.mp4' });
    await replicateProvider.cancel!(job('text-to-video', {}, { providerJobId: 'pred_1' }), m, c);
    expect(calls.at(-1)!.url).toMatch(/cancel$/);
  });

  it('reports failures and running progress', async () => {
    const m = model(replicateProvider, 'minimax/video-01');
    const { f: f1 } = mockFetch([[/predictions\/p$/, 200, { id: 'p', status: 'processing', logs: '  10%|#   \n  42%|####  ' }]]);
    const r1 = await replicateProvider.poll!(job('text-to-video', {}, { providerJobId: 'p' }), m, ctx(f1, { apiToken: 't' }));
    expect(r1).toMatchObject({ status: 'running', progress: 0.42 });
    const { f: f2 } = mockFetch([[/predictions\/p$/, 200, { id: 'p', status: 'failed', error: 'NSFW content detected' }]]);
    const r2 = await replicateProvider.poll!(job('text-to-video', {}, { providerJobId: 'p' }), m, ctx(f2, { apiToken: 't' }));
    expect(r2).toEqual({ status: 'failed', error: 'NSFW content detected' });
  });

  it('requires credentials', async () => {
    const { f } = mockFetch([]);
    await expect(replicateProvider.submit!(job('text-to-video', {}), model(replicateProvider, 'google/veo-3'), ctx(f, {}))).rejects.toThrow(/not configured/);
  });

  it('fills custom model templates', async () => {
    const settings = { ...DEFAULT_SETTINGS, providers: { replicate: { enabled: true, customModels: [{ id: 'me/lipsync', name: 'Lip', tasks: ['tool' as const], inputTemplate: { video: '{{video}}', note: 'p={{prompt}}', seed: '{{seed}}' } }] } } };
    const { f, calls } = mockFetch([[/\/models\/me\/lipsync\/predictions$/, 201, { id: 'x', status: 'starting' }]]);
    const m = replicateProvider.models(settings, config).find((x) => x.id === 'me/lipsync')!;
    await replicateProvider.submit!(job('tool', { sourceVideoAssetId: 'ast_v' }), m, { ...ctx(f, { apiToken: 't' }), settings });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.input).toEqual({ video: 'https://public.example/media/ast_v', note: 'p=a cat. Camera: slow push-in' });
  });
});

describe('fal adapter', () => {
  it('uses the queue URLs returned by fal', async () => {
    const { f, calls } = mockFetch([
      [/queue\.fal\.run\/fal-ai\/kling-video\/v2\.1\/master\/text-to-video$/, 200, { request_id: 'r1', status_url: 'https://queue.fal.run/fal-ai/kling-video/requests/r1/status', response_url: 'https://queue.fal.run/fal-ai/kling-video/requests/r1', cancel_url: 'https://queue.fal.run/fal-ai/kling-video/requests/r1/cancel' }],
      [/requests\/r1\/status$/, 200, { status: 'COMPLETED' }],
      [/requests\/r1$/, 200, { video: { url: 'https://v3.fal.media/files/out.mp4' } }],
    ]);
    const m = model(falProvider, 'fal-ai/kling-video/v2.1/master/text-to-video');
    const c = ctx(f, { apiKey: 'id:secret' });
    const sub = await falProvider.submit!(job('text-to-video', { duration: 9, aspectRatio: '1:1' }), m, c);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ duration: '10', aspect_ratio: '1:1' });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Key id:secret');
    const res = await falProvider.poll!(job('text-to-video', {}, { providerJobId: sub.providerJobId, providerState: sub.state! }), m, c);
    expect(res.status === 'succeeded' && res.outputs[0]).toMatchObject({ url: 'https://v3.fal.media/files/out.mp4' });
  });

  it('refuses unexpected queue hosts', async () => {
    const { f } = mockFetch([[/queue\.fal\.run/, 200, { request_id: 'r', status_url: 'https://evil.example/s', response_url: 'https://evil.example/r', cancel_url: 'https://evil.example/c' }]]);
    await expect(falProvider.submit!(job('text-to-video', {}), model(falProvider, 'fal-ai/veo3'), ctx(f, { apiKey: 'k' }))).rejects.toThrow(/unexpected queue URL/);
  });
});

describe('Runway, Luma, Google and OpenAI adapters', () => {
  it('Runway requires an image and maps ratios', async () => {
    const m = model(runwayProvider, 'gen4_turbo');
    const { f, calls } = mockFetch([
      [/image_to_video$/, 200, { id: 't1' }],
      [/tasks\/t1$/, 200, { id: 't1', status: 'RUNNING', progress: 0.3 }],
    ]);
    await expect(runwayProvider.submit!(job('image-to-video', {}), m, ctx(f, { apiKey: 'k' }))).rejects.toThrow(/start image/);
    await runwayProvider.submit!(job('image-to-video', { startImageAssetId: 'a', aspectRatio: '9:16', duration: 8 }), m, ctx(f, { apiKey: 'k' }));
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ model: 'gen4_turbo', ratio: '720:1280', duration: 10, promptImage: 'data:image/png;base64,AAAA' });
    expect((calls[0].init.headers as Record<string, string>)['X-Runway-Version']).toBeTruthy();
    expect(await runwayProvider.poll!(job('image-to-video', {}, { providerJobId: 't1' }), m, ctx(f, { apiKey: 'k' }))).toMatchObject({ status: 'running', progress: 0.3 });
  });

  it('Luma disables image-to-video without a public URL', () => {
    const noPublic = lumaProvider.models(DEFAULT_SETTINGS, { ...config, publicBaseUrl: null }).find((m) => m.id === 'ray-2')!;
    expect(noPublic.tasks).toEqual(['text-to-video']);
    const withPublic = lumaProvider.models(DEFAULT_SETTINGS, { ...config, publicBaseUrl: 'https://studio.example' }).find((m) => m.id === 'ray-2')!;
    expect(withPublic.tasks).toContain('image-to-video');
  });

  it('Google surfaces safety-filter failures', async () => {
    const m = model(googleProvider, 'veo-3.0-generate-001');
    const { f } = mockFetch([[/operations\/abc$/, 200, { name: 'operations/abc', done: true, response: { generateVideoResponse: { generatedSamples: [], raiMediaFilteredReasons: ['child safety'] } } }]]);
    const r = await googleProvider.poll!(job('text-to-video', {}, { providerJobId: 'models/veo/operations/abc' }), m, ctx(f, { apiKey: 'AIza' }));
    expect(r).toEqual({ status: 'failed', error: 'Blocked by safety filters: child safety' });
  });

  it('OpenAI TTS returns audio synchronously and validates input', async () => {
    const m = model(openaiProvider, 'gpt-4o-mini-tts');
    const f = vi.fn(async () => new Response(new Uint8Array([0xff, 0xfb, 1, 2, 3]), { status: 200 })) as unknown as typeof fetch;
    const sub = await openaiProvider.submit!(job('text-to-speech', { text: 'Hello there', voice: 'nova' }), m, ctx(f, { apiKey: 'sk-test' }));
    expect(sub.immediate?.status).toBe('succeeded');
    await expect(openaiProvider.submit!(job('text-to-speech', { text: '' , prompt: ''}), m, ctx(f, { apiKey: 'sk-test' }))).rejects.toThrow(/empty/);
  });
});
