import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeFile, makeEnv, samples, upload, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv({ config: { limits: { maxVideoBytes: 50 * 1024 * 1024, maxImageBytes: 5 * 1024, maxAudioBytes: 10 * 1024 * 1024, maxProjectImportBytes: 100 * 1024 * 1024 } } });
});
afterAll(async () => env.close());

describe('uploads and validation', () => {
  it('accepts video, image and audio and extracts metadata', async () => {
    const v = await upload(env, samples.video());
    expect(v.status).toBe(201);
    expect(v.body).toMatchObject({ type: 'video', width: 320, height: 180, hasAudio: true, hasThumbnail: true, origin: 'upload' });
    expect(v.body.duration).toBeCloseTo(3, 0);
    expect(v.body.provenance.aiGenerated).toBe(false);
    const a = await upload(env, samples.audio());
    expect(a.body).toMatchObject({ type: 'audio', hasWaveform: true });
    const thumb = await env.agent.get(`/media/${v.body.id}/thumb.jpg`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers['content-type']).toMatch(/image\/jpeg/);
  });

  it('serves media with range requests', async () => {
    const v = await upload(env, samples.silentVideo());
    const r = await env.agent.get(`/media/${v.body.id}/${v.body.fileName}`).set('Range', 'bytes=0-99');
    expect(r.status).toBe(206);
    expect(Number(r.headers['content-length'])).toBe(100);
    expect((await env.agent.get(`/media/${v.body.id}/../../secrets.json`)).status).toBe(404);
  });

  it('rejects files that are not media, whatever their extension', async () => {
    const r = await upload(env, fakeFile('evil.png', 'This is plainly not an image, just text with a .png name'));
    expect(r.status).toBe(415);
    expect(r.body.error).toMatch(/Unsupported file type/);
  });

  it('rejects corrupt media', async () => {
    const r = await upload(env, fakeFile('broken.mp4', Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(200, 7)])));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/decoded|playable/);
  });

  it('enforces per-type size limits', async () => {
    const big = samples.image(); // ~>40KB PNG test pattern
    const r = await upload(env, big);
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/limit/);
  });

  it('enforces type restrictions for inputs', async () => {
    const r = await upload(env, samples.audio(), { allow: 'image' });
    expect(r.status).toBe(415);
  });

  it('updates tags/favorites and deletes assets', async () => {
    const v = await upload(env, samples.silentVideo());
    const p = await env.agent.patch(`/api/assets/${v.body.id}`).send({ tags: ['hero', ' rain '], favorite: true });
    expect(p.body.tags).toEqual(['hero', 'rain']);
    expect(p.body.favorite).toBe(true);
    expect((await env.agent.patch(`/api/assets/${v.body.id}`).send({ provenance: { aiGenerated: true } })).status).toBe(400);
    expect((await env.agent.delete(`/api/assets/${v.body.id}`)).status).toBe(200);
    expect((await env.agent.get(`/media/${v.body.id}/${v.body.fileName}`)).status).toBe(404);
  });
});
