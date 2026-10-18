/**
 * Timeline editing → FFmpeg export, validated with ffprobe. These tests use
 * the real render pipeline (no mocks).
 */
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, samples, upload, waitForJob, type TestEnv } from './helpers';
import type { Asset } from '../../shared/api';
import type { Project } from '../../shared/project';
import { addAssetClip, addCue, addTitle, setKeyframe, setTransition, splitAt, addEffect, deleteClips } from '../../shared/ops';
import { probe } from '../../server/media/ffmpeg';
import { EFFECT_TYPES } from '../../shared/project';

let env: TestEnv;
let video: Asset;
let still: Asset;
let tone: Asset;

beforeAll(async () => {
  env = await makeEnv();
  video = (await upload(env, samples.video())).body;
  still = (await upload(env, samples.image())).body;
  tone = (await upload(env, samples.audio())).body;
});
afterAll(async () => env.close());

async function newProject(): Promise<Project> {
  return (await env.agent.post('/api/projects').send({ name: 'Export test', aspectRatio: '16:9', resolution: '720p', fps: 25 })).body;
}

async function exportProject(p: Project, settings: Partial<Project['exportSettings']> = {}) {
  const res = await env.agent.post('/api/exports').send({ project: p, settings: { ...p.exportSettings, width: 640, height: 360, quality: 'draft', ...settings } });
  expect(res.status).toBe(201);
  const job = await waitForJob(env, res.body.id, 120_000);
  return job;
}

function meanVolume(file: string, start: number, dur: number): number {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(start), '-t', String(dur), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume: (-?[\d.]+) dB/.exec(r.stderr);
  return m ? Number(m[1]) : -999;
}

describe('editing operations affect the exported file', () => {
  it('exports a multi-track edit as a valid MP4 with audio', async () => {
    const p = await newProject();
    addAssetClip(p, video); // 0–3
    addAssetClip(p, still, { duration: 2 }); // 3–5
    const music = p.timeline.tracks.find((t) => t.role === 'music')!;
    addAssetClip(p, tone, { trackId: music.id, start: 0 });
    addTitle(p, 'Hello: world, 100%', 0.5, 2); // tricky characters for drawtext
    addCue(p, 1, 2.5, "It's a subtitle");
    const job = await exportProject(p);
    expect(job.status, job.error ?? '').toBe('succeeded');
    const out = env.ctx.assets.get(job.outputAssetIds[0])!;
    expect(out.origin).toBe('export');
    expect(out.provenance.aiGenerated).toBe(false);
    const info = await probe(env.ctx.assets.filePath(out));
    expect(info.video).toMatchObject({ codec: 'h264', width: 640, height: 360 });
    expect(info.audio?.codec).toBe('aac');
    expect(info.duration).toBeCloseTo(5, 0);
    expect((job.result as { validation: { ok: boolean } }).validation.ok).toBe(true);
  });

  it('applies speed, trims and splits', async () => {
    const p = await newProject();
    const c = addAssetClip(p, video)!; // 3s
    c.speed = 2; // → 1.5s
    const d = addAssetClip(p, video, { start: 1.5 })!;
    d.in = 1;
    d.out = 2; // 1s
    splitAt(p, 2, [d.id]);
    const job = await exportProject(p);
    expect(job.status, job.error ?? '').toBe('succeeded');
    const info = await probe(env.ctx.assets.filePath(env.ctx.assets.get(job.outputAssetIds[0])!));
    expect(info.duration).toBeCloseTo(2.5, 0);
  });

  it('mutes tracks and clips in the mix', async () => {
    const p = await newProject();
    const music = p.timeline.tracks.find((t) => t.role === 'music')!;
    addAssetClip(p, tone, { trackId: music.id, start: 0 });
    const v = addAssetClip(p, still, { duration: 4 })!;
    void v;
    let job = await exportProject(p);
    const loud = meanVolume(env.ctx.assets.filePath(env.ctx.assets.get(job.outputAssetIds[0])!), 0.5, 2);
    music.muted = true;
    job = await exportProject(p);
    const quiet = meanVolume(env.ctx.assets.filePath(env.ctx.assets.get(job.outputAssetIds[0])!), 0.5, 2);
    expect(loud).toBeGreaterThan(-40);
    expect(quiet).toBeLessThan(-80);
  });

  it('renders every effect, transitions and keyframes without errors', async () => {
    const p = await newProject();
    const a = addAssetClip(p, video)!;
    const b = addAssetClip(p, still, { start: 2.5, duration: 2 })!;
    setTransition(p, b.id, { type: 'dissolve', duration: 0.5 });
    const c = addAssetClip(p, still, { start: 4.5, duration: 1.5 })!;
    setTransition(p, c.id, { type: 'slideLeft', duration: 0.5 });
    for (const t of EFFECT_TYPES) addEffect(a, t);
    addEffect({ effects: p.timeline.masterEffects }, 'letterbox');
    setKeyframe(p, b.id, 'opacity', 0, 0.2);
    setKeyframe(p, b.id, 'opacity', 1, 1);
    setKeyframe(p, b.id, 'scale', 0, 0.6);
    setKeyframe(p, b.id, 'scale', 2, 1.1);
    setKeyframe(p, c.id, 'x', 0, -0.2);
    setKeyframe(p, c.id, 'x', 1.5, 0.2);
    a.color = { brightness: 0.05, contrast: 1.2, saturation: 0.8, gamma: 1.1, hue: 10, exposure: 0.3, temperature: 0.4 };
    a.transform = { ...a.transform, crop: { left: 0.1, top: 0.05, right: 0.1, bottom: 0.05 }, fit: 'cover', opacity: 0.9 };
    a.fadeIn = 0.5;
    a.fadeOut = 0.5;
    const job = await exportProject(p);
    expect(job.status, job.error ?? '').toBe('succeeded');
    const info = await probe(env.ctx.assets.filePath(env.ctx.assets.get(job.outputAssetIds[0])!));
    expect(info.duration).toBeCloseTo(6, 0);
  });

  it('supports portrait, WebM and preview renders', async () => {
    const p = (await env.agent.post('/api/projects').send({ name: 'Portrait', aspectRatio: '9:16', resolution: '720p' })).body as Project;
    addAssetClip(p, video);
    const job = await exportProject(p, { width: 360, height: 640, codec: 'vp9', container: 'webm' });
    expect(job.status, job.error ?? '').toBe('succeeded');
    const info = await probe(env.ctx.assets.filePath(env.ctx.assets.get(job.outputAssetIds[0])!));
    expect(info.video).toMatchObject({ codec: 'vp9', width: 360, height: 640 });
    const prev = await env.agent.post('/api/exports').send({ project: p, settings: p.exportSettings, preview: true });
    const pj = await waitForJob(env, prev.body.id);
    expect(pj.status).toBe('succeeded');
    expect(env.ctx.assets.get(pj.outputAssetIds[0])!.tags).toContain('preview');
    expect(Math.min(env.ctx.assets.get(pj.outputAssetIds[0])!.width!, env.ctx.assets.get(pj.outputAssetIds[0])!.height!)).toBeLessThanOrEqual(540);
  });

  it('renders exact single frames', async () => {
    const p = await newProject();
    addAssetClip(p, video);
    const r = await env.agent.post('/api/render/frame').send({ project: p, t: 1, width: 320 }).buffer(true);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/image\/jpeg/);
    expect(r.body.length).toBeGreaterThan(1000);
  });

  it('refuses invalid exports with clear errors', async () => {
    const p = await newProject();
    expect((await env.agent.post('/api/exports').send({ project: p, settings: p.exportSettings })).body.error).toMatch(/empty/);
    addAssetClip(p, video);
    expect((await env.agent.post('/api/exports').send({ project: p, settings: { ...p.exportSettings, codec: 'vp9', container: 'mp4' } })).body.error).toMatch(/WebM/);
    const ghost = addAssetClip(p, { ...video, id: 'ast_missing' })!;
    expect((await env.agent.post('/api/exports').send({ project: p, settings: p.exportSettings })).body.error).toMatch(/missing/);
    deleteClips(p, [ghost.id]);
  });

  it('can cancel an export', async () => {
    const p = await newProject();
    for (let i = 0; i < 6; i++) addAssetClip(p, video);
    const res = await env.agent.post('/api/exports').send({ project: p, settings: { ...p.exportSettings, width: 1280, height: 720, quality: 'master' } });
    const c = await env.agent.post(`/api/jobs/${res.body.id}/cancel`);
    expect(c.body.status).toBe('canceled');
    const job = await waitForJob(env, res.body.id);
    expect(job.status).toBe('canceled');
    expect(job.outputAssetIds).toEqual([]);
  });
});

describe('project bundles', () => {
  it('exports and re-imports a project with media, remapping asset ids', async () => {
    const p = await newProject();
    addAssetClip(p, video);
    p.characters.push({ id: 'chr_1', name: 'Hero', description: '', appearance: '', face: '', body: '', clothing: '', accessories: '', palette: ['#112233'], referenceAssetIds: [still.id], approvedAssetIds: [], rejectedAssetIds: [], notes: '', createdAt: new Date().toISOString() });
    const saved = (await env.agent.put(`/api/projects/${p.id}`).send(p)).body as Project;
    const bundle = await env.agent.get(`/api/projects/${saved.id}/bundle`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(bundle.status).toBe(200);
    const buf = bundle.body as Buffer;
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    const imp = await env.agent.post('/api/projects/import').attach('file', buf, 'film.voidcraft');
    expect(imp.status, JSON.stringify(imp.body)).toBe(201);
    const np = imp.body.project as Project;
    expect(np.id).not.toBe(saved.id);
    const clip = np.timeline.tracks.flatMap((t) => t.clips)[0];
    expect(clip.kind === 'media' && clip.assetId).not.toBe(video.id);
    expect(env.ctx.assets.get((clip as { assetId: string }).assetId)).toBeTruthy();
    expect(np.characters[0].referenceAssetIds[0]).not.toBe(still.id);
  });

  it('imports bare project JSON and rejects junk', async () => {
    const p = await newProject();
    const json = Buffer.from(JSON.stringify({ ...p, name: 'Imported JSON' }));
    const r = await env.agent.post('/api/projects/import').attach('file', json, 'p.json');
    expect(r.status).toBe(201);
    expect(r.body.project.name).toBe('Imported JSON');
    const junk = await env.agent.post('/api/projects/import').attach('file', Buffer.from('hello'), 'x.json');
    expect(junk.status).toBe(400);
    const invalid = await env.agent.post('/api/projects/import').attach('file', Buffer.from(JSON.stringify({ formatVersion: 1, name: 'x' })), 'x.json');
    expect(invalid.status).toBe(400);
  });
});

describe('AI text tools', () => {
  it('runs offline (non-AI) storyboard and prompt tools', async () => {
    const r = await env.agent.post('/api/ai/storyboard').send({ providerId: 'offline-templates', input: { idea: 'A robot wakes up. It walks to the window. The city is flooded.', shotCount: 4 } });
    expect(r.body.isAI).toBe(false);
    expect(r.body.result.shots).toHaveLength(4);
    const e = await env.agent.post('/api/ai/enhance-prompt').send({ providerId: 'offline-templates', input: { prompt: 'a cat at night' } });
    expect(e.body.result.prompt).toMatch(/a cat at night/);
    expect((await env.agent.post('/api/ai/storyboard').send({ providerId: 'anthropic', input: { idea: 'x' } })).body.error).toMatch(/not configured/);
    expect((await env.agent.post('/api/ai/storyboard').send({ providerId: 'offline-templates', input: {} })).status).toBe(400);
  });
});
