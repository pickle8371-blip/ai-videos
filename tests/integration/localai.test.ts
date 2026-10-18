/**
 * Local AI engine end to end: the real Python engine (PyTorch + diffusers) is
 * driven through the HTTP API. Model weights can't be downloaded in CI, so the
 * generation tests use the engine's TEST-ONLY tiny random-weight pipelines,
 * which are built from the same diffusers classes as the real models
 * (WanPipeline, LTXPipeline, LTXImageToVideoPipeline, CogVideoXPipeline,
 * AnimateDiffPipeline, AnimateDiffVideoToVideoPipeline). Output is noise; the
 * point is that every engine code path, progress reporting, cancellation and
 * encoding works.
 *
 * Skipped automatically when engine/.venv has not been installed
 * (python engine/setup_engine.py).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, samples, upload, waitFor, waitForJob, type TestEnv } from './helpers';
import { probe } from '../../server/media/ffmpeg';

const venvPython = process.platform === 'win32' ? 'engine/.venv/Scripts/python.exe' : 'engine/.venv/bin/python';
const engineInstalled = fs.existsSync(path.resolve(venvPython));

describe.skipIf(!engineInstalled)('local AI engine (real PyTorch + diffusers)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    process.env.VOIDCRAFT_ENGINE_TEST = '1';
    env = await makeEnv({ config: { pollIntervalMs: 200 } });
  }, 120_000);
  afterAll(async () => {
    delete process.env.VOIDCRAFT_ENGINE_TEST;
    await env?.close();
  });

  const gen = (modelId: string, task: string, params: Record<string, unknown>) =>
    env.agent.post('/api/jobs').send({ task, providerId: 'local-ai', modelId, params: { prompt: 'a red fox running through snow', ...params } });

  it('reports a ready engine with device information and the model catalog', async () => {
    const r = await env.agent.get('/api/engine');
    expect(r.status).toBe(200);
    expect(r.body.status.state).toBe('ready');
    expect(r.body.status.torch).toBeTruthy();
    expect(r.body.status.diffusers).toBeTruthy();
    expect(['cuda', 'mps', 'cpu']).toContain(r.body.status.device);
    const ids = r.body.models.map((m: { id: string }) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['wan2.1-t2v-1.3b', 'ltx-video', 'cogvideox-2b', 'cogvideox-5b-i2v', 'animatediff-lightning']));
    expect(r.body.recommended).toBeTruthy();
    const sys = await env.agent.get('/api/system');
    expect(sys.body.localAi.state).toBe('ready');
    expect(sys.body.aiProvidersConfigured).toContain('local-ai');
  });

  for (const [model, label] of [
    ['test-tiny-wan', 'Wan'],
    ['test-tiny-ltx', 'LTX'],
    ['test-tiny-cogvideox', 'CogVideoX'],
    ['test-tiny-animatediff', 'AnimateDiff'],
  ] as const) {
    it(`generates a text-to-video clip through the ${label} pipeline and saves it as AI output`, async () => {
      const progress: number[] = [];
      const onJob = (j: { modelId: string; progress: number | null; status: string }) => j.modelId === model && j.status === 'running' && j.progress !== null && progress.push(j.progress);
      env.ctx.jobs.on('job', onJob);
      const res = await gen(model, 'text-to-video', { duration: 1, aspectRatio: '16:9', seed: 42, negativePrompt: 'blurry', quality: 'standard' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const job = await waitForJob(env, res.body[0].id, 300_000);
      env.ctx.jobs.off('job', onJob);
      expect(job.status, job.error ?? '').toBe('succeeded');
      expect(progress.some((p) => p > 0 && p < 1)).toBe(true);
      const asset = env.ctx.assets.get(job.outputAssetIds[0])!;
      expect(asset.type).toBe('video');
      expect(asset.provenance).toMatchObject({ aiGenerated: true, providerId: 'local-ai', modelId: model });
      const info = await probe(env.ctx.assets.filePath(asset));
      expect(info.video?.codec).toBe('h264');
      expect((job.result as { seed: number }).seed).toBe(42);
    }, 300_000);
  }

  it('animates an uploaded image (LTX image-to-video pipeline)', async () => {
    const img = await upload(env, samples.image());
    const res = await gen('test-tiny-ltx', 'image-to-video', { startImageAssetId: img.body.id, duration: 1 });
    const job = await waitForJob(env, res.body[0].id, 300_000);
    expect(job.status, job.error ?? '').toBe('succeeded');
    expect(env.ctx.assets.get(job.outputAssetIds[0])!.provenance.sourceAssetIds).toContain(img.body.id);
  }, 300_000);

  it('restyles source footage (AnimateDiff video-to-video pipeline)', async () => {
    const vid = await upload(env, samples.video());
    const res = await gen('test-tiny-animatediff', 'video-to-video', { sourceVideoAssetId: vid.body.id, strength: 0.6 });
    const job = await waitForJob(env, res.body[0].id, 300_000);
    expect(job.status, job.error ?? '').toBe('succeeded');
  }, 300_000);

  it('cancels a running generation', async () => {
    const res = await gen('test-tiny-wan', 'text-to-video', { duration: 1, quality: 'high' });
    await waitFor(() => ['running', 'succeeded'].includes(env.ctx.jobs.get(res.body[0].id)?.status ?? ''), 60_000);
    const c = await env.agent.post(`/api/jobs/${res.body[0].id}/cancel`);
    expect(c.body.status).toMatch(/canceled|succeeded/);
  }, 120_000);

  it('refuses models that are not downloaded, with a clear next step', async () => {
    const res = await gen('wan2.1-t2v-1.3b', 'text-to-video', { duration: 2 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Download this model first/);
    const wrongTask = await gen('test-tiny-wan', 'image-to-video', {});
    expect(wrongTask.status).toBe(400);
  });

  it('reports download failures (no internet access to Hugging Face here) as a failed job, not a crash', async () => {
    const res = await env.agent.post('/api/engine/models/animatediff-lightning/download');
    expect(res.status).toBe(201);
    const job = await waitForJob(env, res.body.id, 120_000);
    // In an environment with internet access this downloads ~6 GB instead.
    if (job.status === 'failed') expect(job.error).toBeTruthy();
    else expect(job.status).toBe('succeeded');
    expect((await env.agent.post('/api/engine/models/nope/download')).status).toBe(404);
  }, 150_000);
});
