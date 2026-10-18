import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers';
import type { Project } from '../../shared/project';

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv();
});
afterAll(async () => env.close());

describe('project management', () => {
  let project: Project;

  it('creates, lists and reopens a project', async () => {
    const res = await env.agent.post('/api/projects').send({ name: 'My film', aspectRatio: '9:16', resolution: '1080p', fps: 24 });
    expect(res.status).toBe(201);
    project = res.body;
    expect(project.settings).toMatchObject({ width: 1080, height: 1920, fps: 24, aspectRatio: '9:16' });
    const list = await env.agent.get('/api/projects');
    expect(list.body.map((p: { id: string }) => p.id)).toContain(project.id);
    const got = await env.agent.get(`/api/projects/${project.id}`);
    expect(got.body.name).toBe('My film');
  });

  it('saves edits and persists them across a server restart', async () => {
    const edited = { ...project, description: 'A short about rain', storyboard: { ...project.storyboard, idea: 'Rain' } };
    const res = await env.agent.put(`/api/projects/${project.id}`).send(edited);
    expect(res.status).toBe(200);
    expect(res.body.updatedAt >= project.updatedAt).toBe(true);
    // New server context on the same data directory = reopen after restart.
    const env2 = await makeEnv({ dataDir: env.dataDir });
    const got = await env2.agent.get(`/api/projects/${project.id}`);
    expect(got.body.description).toBe('A short about rain');
    expect(got.body.storyboard.idea).toBe('Rain');
    await env2.close();
    project = res.body;
  });

  it('rejects invalid project data with details', async () => {
    const bad = { ...project, settings: { ...project.settings, fps: 9999 } };
    const res = await env.agent.put(`/api/projects/${project.id}`).send(bad);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
    expect(res.body.details.join(' ')).toMatch(/fps/);
    const mismatch = await env.agent.put(`/api/projects/${project.id}`).send({ ...project, id: 'prj_other' });
    expect(mismatch.status).toBe(400);
  });

  it('autosaves to a recovery slot that survives restarts until saved', async () => {
    const draft = { ...project, name: 'My film (unsaved edit)' };
    const a = await env.agent.post(`/api/projects/${project.id}/autosave`).send(draft);
    expect(a.status).toBe(200);
    const env2 = await makeEnv({ dataDir: env.dataDir });
    const rec = await env2.agent.get(`/api/projects/${project.id}/recovery`);
    expect(rec.body.project.name).toBe('My film (unsaved edit)');
    const summary = (await env2.agent.get('/api/projects')).body.find((p: { id: string }) => p.id === project.id);
    expect(summary.hasRecovery).toBe(true);
    // The saved project is untouched until an explicit save.
    expect((await env2.agent.get(`/api/projects/${project.id}`)).body.name).toBe('My film');
    await env2.agent.put(`/api/projects/${project.id}`).send(rec.body.project);
    expect((await env2.agent.get(`/api/projects/${project.id}/recovery`)).body).toBeNull();
    await env2.close();
  });

  it('renames, duplicates and saves-as', async () => {
    const r = await env.agent.post(`/api/projects/${project.id}/rename`).send({ name: 'Renamed' });
    expect(r.body.name).toBe('Renamed');
    const d = await env.agent.post(`/api/projects/${project.id}/duplicate`).send({});
    expect(d.status).toBe(201);
    expect(d.body.id).not.toBe(project.id);
    expect(d.body.name).toBe('Renamed copy');
    const s = await env.agent.post('/api/projects/save-as').send({ project: r.body, name: 'Alt cut' });
    expect(s.status).toBe(201);
    expect(s.body.name).toBe('Alt cut');
  });

  it('creates projects from templates and saves templates', async () => {
    const t = await env.agent.post('/api/projects').send({ name: 'From tpl', templateId: 'tpl_cinematic' });
    expect(t.status).toBe(201);
    expect(t.body.settings.fps).toBe(24);
    expect(t.body.storyboard.shots.length).toBeGreaterThan(0);
    expect(t.body.timeline.masterEffects[0].type).toBe('letterbox');
    const saved = await env.agent.post(`/api/projects/${t.body.id}/template`).send({ name: 'My template', description: 'x' });
    expect(saved.status).toBe(201);
    const list = await env.agent.get('/api/templates');
    expect(list.body.some((x: { name: string }) => x.name === 'My template')).toBe(true);
    const fromUser = await env.agent.post('/api/projects').send({ name: 'From user tpl', templateId: saved.body.id });
    expect(fromUser.body.storyboard.shots.length).toBe(t.body.storyboard.shots.length);
    expect((await env.agent.post('/api/projects').send({ name: 'x', templateId: 'nope' })).status).toBe(400);
  });

  it('requires confirmation to delete', async () => {
    const p = (await env.agent.post('/api/projects').send({ name: 'Doomed' })).body;
    expect((await env.agent.delete(`/api/projects/${p.id}`)).status).toBe(400);
    expect((await env.agent.delete(`/api/projects/${p.id}`).send({ confirm: true })).status).toBe(200);
    expect((await env.agent.get(`/api/projects/${p.id}`)).status).toBe(404);
  });

  it('rejects path traversal in ids', async () => {
    expect((await env.agent.get('/api/projects/..%2F..%2Fsecrets')).status).toBe(400);
  });
});
