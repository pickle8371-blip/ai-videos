/**
 * Generation job lifecycle with MOCKED providers (no paid API calls):
 * submission, polling, progress, result download, errors, timeouts,
 * cancellation, retries and recovery after a restart.
 */
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileServer, makeEnv, samples, upload, waitFor, waitForJob, type TestEnv } from './helpers';
import type { PollResult, Provider } from '../../server/providers/types';
import { ProviderError } from '../../server/providers/types';
import { ALL_PROVIDERS } from '../../server/providers/registry';

type Script = { polls: PollResult[]; submitError?: string; canceled?: boolean };
const scripts = new Map<string, Script>();
let submitCount = 0;

/** A configurable fake AI provider. The test controls what each poll returns. */
const fakeProvider: Provider = {
  needsCredentials: true,
  info: {
    id: 'fake-ai',
    name: 'Fake AI (test double)',
    description: 'Mock provider for automated tests',
    isAI: true,
    categories: ['video'],
    docsUrl: 'https://example.invalid',
    credentialFields: [{ key: 'apiKey', label: 'API key', envVar: 'FAKE_AI_KEY_UNSET', secret: true }],
    supportsCancel: true,
    limitations: [],
  },
  models: () => [
    {
      id: 'fake-video',
      providerId: 'fake-ai',
      name: 'Fake video',
      tasks: ['text-to-video', 'image-to-video'],
      capabilities: { durations: [4, 8], aspectRatios: ['16:9', '9:16'], negativePrompt: false, seed: true, camera: 'prompt' },
    },
  ],
  async submit(job) {
    submitCount++;
    const prompt = String((job.params as { prompt?: string }).prompt);
    const s = scripts.get(prompt);
    if (s?.submitError) throw new ProviderError(s.submitError, 400);
    return { providerJobId: `fake_${prompt}` };
  },
  async poll(job) {
    const prompt = String((job.params as { prompt?: string }).prompt);
    const s = scripts.get(prompt);
    if (!s) return { status: 'running', progress: null };
    return s.polls.length > 1 ? s.polls.shift()! : s.polls[0];
  },
  async cancel(job) {
    const prompt = String((job.params as { prompt?: string }).prompt);
    const s = scripts.get(prompt);
    if (s) s.canceled = true;
  },
};

let env: TestEnv;
let files: Awaited<ReturnType<typeof fileServer>>;
const providers = [...ALL_PROVIDERS, fakeProvider];

beforeAll(async () => {
  env = await makeEnv({ providers, config: { jobTimeoutMs: 3000 } });
  files = await fileServer({ '/result.mp4': samples.video(), '/garbage.mp4': samples.audio().replace('.wav', '.missing') });
  await env.agent.put('/api/providers/fake-ai/credentials').send({ apiKey: 'fake-secret-key-123456' });
});
afterAll(async () => {
  await env.close();
  await files.close();
});

const create = (prompt: string, extra: Record<string, unknown> = {}) =>
  env.agent.post('/api/jobs').send({ task: 'text-to-video', providerId: 'fake-ai', modelId: 'fake-video', params: { prompt, duration: 5, camera: { move: 'orbit', framing: 'wide', speed: 0.5, intensity: 0.5, subjectFocus: '', direction: 'auto' }, ...extra } });

describe('job lifecycle (mocked provider)', () => {
  it('runs submit → running (with progress) → download → succeeded', async () => {
    scripts.set('happy', {
      polls: [
        { status: 'running', progress: 0.25, message: 'Generating' },
        { status: 'running', progress: 0.75, message: 'Generating' },
        { status: 'succeeded', outputs: [{ kind: 'url', url: `${files.url}/result.mp4`, name: 'out.mp4' }] },
      ],
    });
    const progress: number[] = [];
    env.ctx.jobs.on('job', (j) => j.params.prompt === 'happy' && j.progress !== null && progress.push(j.progress));
    const res = await create('happy');
    expect(res.status).toBe(201);
    const job = await waitForJob(env, res.body[0].id);
    expect(job.status).toBe('succeeded');
    expect(progress).toEqual(expect.arrayContaining([0.25, 0.75]));
    // Duration snapped to a supported value; camera folded into the prompt.
    expect(job.params).toMatchObject({ duration: 4 });
    expect(String((job.params as { compiledPrompt: string }).compiledPrompt)).toMatch(/orbits around the subject/);
    const asset = env.ctx.assets.get(job.outputAssetIds[0])!;
    expect(asset.type).toBe('video');
    expect(asset.provenance).toMatchObject({ aiGenerated: true, providerId: 'fake-ai', modelId: 'fake-video', jobId: job.id });
    expect(fs.existsSync(env.ctx.assets.filePath(asset))).toBe(true);
  });

  it('creates one job per requested variation', async () => {
    scripts.set('vars', { polls: [{ status: 'failed', error: 'stop' }] });
    const res = await create('vars', { variations: 3, seed: 10 });
    expect(res.body).toHaveLength(3);
    expect(res.body.map((j: { params: { seed: number } }) => j.params.seed)).toEqual([10, 11, 12]);
  });

  it('reports provider failures without losing parameters, and retries', async () => {
    scripts.set('fails', { polls: [{ status: 'failed', error: 'Content policy violation' }] });
    const res = await create('fails');
    const job = await waitForJob(env, res.body[0].id);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('Content policy violation');
    scripts.set('fails', { polls: [{ status: 'succeeded', outputs: [{ kind: 'url', url: `${files.url}/result.mp4`, name: 'out.mp4' }] }] });
    const retry = await env.agent.post(`/api/jobs/${job.id}/retry`);
    expect(retry.status).toBe(201);
    expect(retry.body[0].retryOf).toBe(job.id);
    expect((await waitForJob(env, retry.body[0].id)).status).toBe('succeeded');
  });

  it('fails cleanly when submission is rejected', async () => {
    scripts.set('reject', { polls: [], submitError: 'Invalid aspect ratio for this model' });
    const job = await waitForJob(env, (await create('reject')).body[0].id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/Invalid aspect ratio/);
  });

  it('fails when the result cannot be downloaded or is not valid media', async () => {
    scripts.set('baddl', { polls: [{ status: 'succeeded', outputs: [{ kind: 'url', url: `${files.url}/nope.mp4`, name: 'x.mp4' }] }] });
    const job = await waitForJob(env, (await create('baddl')).body[0].id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/could not be saved/);
  });

  it('times out jobs that never finish and asks the provider to cancel', async () => {
    scripts.set('slow', { polls: [{ status: 'running', progress: 0.1 }] });
    const job = await waitForJob(env, (await create('slow')).body[0].id, 20_000);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/Timed out/);
    expect(scripts.get('slow')!.canceled).toBe(true);
  });

  it('cancels a running job', async () => {
    scripts.set('cancel-me', { polls: [{ status: 'running', progress: 0.5 }] });
    const res = await create('cancel-me');
    await waitFor(() => env.ctx.jobs.get(res.body[0].id)?.status === 'running');
    const c = await env.agent.post(`/api/jobs/${res.body[0].id}/cancel`);
    expect(c.body.status).toBe('canceled');
    expect(scripts.get('cancel-me')!.canceled).toBe(true);
  });

  it('validates requests against model capabilities', async () => {
    expect((await env.agent.post('/api/jobs').send({ task: 'video-to-video', providerId: 'fake-ai', modelId: 'fake-video', params: { prompt: 'x' } })).status).toBe(400);
    expect((await env.agent.post('/api/jobs').send({ task: 'text-to-video', providerId: 'fake-ai', modelId: 'nope', params: { prompt: 'x' } })).status).toBe(404);
    expect((await env.agent.post('/api/jobs').send({ task: 'text-to-video', providerId: 'fake-ai', modelId: 'fake-video', params: { prompt: '   ' } })).body.error).toMatch(/Prompt is empty/);
    const i2v = await env.agent.post('/api/jobs').send({ task: 'image-to-video', providerId: 'fake-ai', modelId: 'fake-video', params: { prompt: 'x' } });
    expect(i2v.body.error).toMatch(/start image/);
    const audio = await upload(env, samples.audio());
    const wrong = await env.agent.post('/api/jobs').send({ task: 'image-to-video', providerId: 'fake-ai', modelId: 'fake-video', params: { prompt: 'x', startImageAssetId: audio.body.id } });
    expect(wrong.body.error).toMatch(/must be a image/);
    // Unconfigured providers are refused.
    expect((await env.agent.post('/api/jobs').send({ task: 'text-to-video', providerId: 'replicate', modelId: 'google/veo-3', params: { prompt: 'x' } })).body.error).toMatch(/not configured/);
  });

  it('resumes polling remote jobs after a restart', async () => {
    scripts.set('survivor', { polls: [{ status: 'running', progress: 0.3 }] });
    const res = await create('survivor');
    await waitFor(() => env.ctx.jobs.get(res.body[0].id)?.status === 'running');
    // Simulate the server stopping.
    env.ctx.jobs.shutdown();
    scripts.set('survivor', { polls: [{ status: 'succeeded', outputs: [{ kind: 'url', url: `${files.url}/result.mp4`, name: 'out.mp4' }] }] });
    const env2 = await makeEnv({ dataDir: env.dataDir, providers, config: { jobTimeoutMs: 30_000 } });
    const job = await waitForJob(env2, res.body[0].id);
    expect(job.status).toBe('succeeded');
    expect(job.outputAssetIds).toHaveLength(1);
    await env2.close();
    // Later tests render real video; give them a realistic timeout.
    env = await makeEnv({ dataDir: env.dataDir, providers, config: { jobTimeoutMs: 180_000 } });
  });
});

describe('FFmpeg tools (real FFmpeg, not AI)', () => {
  it('extracts a frame and detects scene cuts', async () => {
    const vid = await upload(env, samples.video());
    const frame = await env.agent.post('/api/jobs').send({ task: 'tool', providerId: 'local-tools', modelId: 'extract-frame', params: { sourceAssetId: vid.body.id, time: 1 } });
    const f = await waitForJob(env, frame.body[0].id);
    expect(f.status, f.error ?? '').toBe('succeeded');
    const img = env.ctx.assets.get(f.outputAssetIds[0])!;
    expect(img.type).toBe('image');
    expect(img.provenance.aiGenerated).toBe(false);
    const scenes = await env.agent.post('/api/jobs').send({ task: 'tool', providerId: 'local-tools', modelId: 'scene-detect', params: { sourceAssetId: vid.body.id } });
    const s = await waitForJob(env, scenes.body[0].id);
    expect(s.status).toBe('succeeded');
    expect(Array.isArray((s.result as { cuts: number[] }).cuts)).toBe(true);
  });
});
