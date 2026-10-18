import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers';

let env: TestEnv;
const KEY = 'r8_THIS_IS_A_TEST_TOKEN_abcdef123456';
beforeAll(async () => {
  env = await makeEnv();
});
afterAll(async () => env.close());

describe('provider configuration & credential protection', () => {
  it('starts in demo mode with only local providers usable', async () => {
    const sys = await env.agent.get('/api/system');
    expect(sys.body.demoMode).toBe(true);
    expect(sys.body.aiProvidersConfigured).toEqual([]);
    const providers = (await env.agent.get('/api/providers')).body as Array<{ id: string; configured: boolean; isAI: boolean }>;
    expect(providers.find((p) => p.id === 'local-test')).toMatchObject({ configured: true, isAI: false });
    expect(providers.filter((p) => p.isAI).every((p) => !p.configured)).toBe(true);
  });

  it('stores keys server-side and only ever returns a masked hint', async () => {
    const res = await env.agent.put('/api/providers/replicate/credentials').send({ apiToken: KEY });
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.credentialHints.apiToken).toEqual({ source: 'store', hint: '••••3456' });
    for (const url of ['/api/providers', '/api/system', '/api/settings', '/api/jobs']) {
      const body = JSON.stringify((await env.agent.get(url)).body);
      expect(body).not.toContain(KEY);
      expect(body).not.toContain('THIS_IS_A_TEST');
    }
    const raw = fs.readFileSync(path.join(env.dataDir, 'secrets.json'), 'utf8');
    expect(raw).not.toContain(KEY);
    expect((await env.agent.get('/api/system')).body.demoMode).toBe(false);
  });

  it('rejects unknown credential fields and whitespace', async () => {
    expect((await env.agent.put('/api/providers/replicate/credentials').send({ password: 'x' })).status).toBe(400);
    expect((await env.agent.put('/api/providers/replicate/credentials').send({ apiToken: 'has space' })).status).toBe(400);
    expect((await env.agent.put('/api/providers/nope/credentials').send({ apiToken: 'x' })).status).toBe(404);
  });

  it('tests connections through the provider (mocked network)', async () => {
    env.ctx.registry.fetchImpl = (async (url: string, init: RequestInit) => {
      expect(String(url)).toBe('https://api.replicate.com/v1/account');
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
      return new Response(JSON.stringify({ username: 'tester' }), { status: 200 });
    }) as typeof fetch;
    const r = await env.agent.post('/api/providers/replicate/test');
    expect(r.body).toEqual({ ok: true, message: 'Connected as tester' });
    env.ctx.registry.fetchImpl = (async () => new Response('{"detail":"Invalid token"}', { status: 401 })) as typeof fetch;
    const bad = await env.agent.post('/api/providers/replicate/test');
    expect(bad.body.ok).toBe(false);
    expect(bad.body.message).toMatch(/Authentication failed/);
    expect(bad.body.message).not.toContain(KEY);
  });

  it('can disable providers and clear credentials', async () => {
    await env.agent.patch('/api/settings').send({ providers: { replicate: { enabled: false } } });
    const job = await env.agent.post('/api/jobs').send({ task: 'text-to-video', providerId: 'replicate', modelId: 'google/veo-3', params: { prompt: 'x' } });
    expect(job.body.error).toMatch(/disabled/);
    await env.agent.patch('/api/settings').send({ providers: { replicate: { enabled: true } } });
    const cleared = await env.agent.delete('/api/providers/replicate/credentials');
    expect(cleared.body.configured).toBe(false);
  });

  it('validates settings and custom models', async () => {
    expect((await env.agent.patch('/api/settings').send({ autosaveSeconds: 1 })).status).toBe(400);
    expect((await env.agent.patch('/api/settings').send({ unknownKey: true })).status).toBe(400);
    const ok = await env.agent.patch('/api/settings').send({ providers: { fal: { enabled: true, customModels: [{ id: 'fal-ai/some/model', name: 'Some', tasks: ['video-to-video'], inputTemplate: { prompt: '{{prompt}}' } }] } } });
    expect(ok.status).toBe(200);
    const fal = (await env.agent.get('/api/providers')).body.find((p: { id: string }) => p.id === 'fal');
    expect(fal.models.some((m: { id: string; custom?: boolean }) => m.id === 'fal-ai/some/model' && m.custom)).toBe(true);
    expect((await env.agent.patch('/api/settings').send({ providers: { fal: { enabled: true, customModels: [{ id: 'bad id!', name: 'x', tasks: ['tool'], inputTemplate: {} }] } } })).status).toBe(400);
  });

  it('rejects cross-origin writes (CSRF) and foreign Host headers', async () => {
    const r = await env.agent.post('/api/projects').set('Origin', 'https://evil.example').send({ name: 'x' });
    expect(r.status).toBe(403);
    const h = await env.agent.get('/api/system').set('Host', 'attacker.example');
    expect(h.status).toBe(403);
  });
});
