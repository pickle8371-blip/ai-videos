import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import { z } from 'zod';
import type { SystemStatus } from '../shared/api.js';
import { loadConfig, type ServerConfig } from './config.js';
import { log } from './logger.js';
import { AssetStore } from './storage/assets.js';
import { ProjectStore, ValidationError, validateProject } from './storage/projects.js';
import { SecretStore } from './storage/secrets.js';
import { SettingsStore } from './storage/settings.js';
import { ProviderRegistry } from './providers/registry.js';
import type { Provider } from './providers/types.js';
import { ProviderError } from './providers/types.js';
import { JobManager } from './jobs/manager.js';
import { ExportService, renderAssetsFor } from './exports.js';
import { detectFfmpeg, MediaError } from './media/ffmpeg.js';
import { compileRender } from './media/render.js';
import { runFfmpeg } from './media/ffmpeg.js';
import { AI_TASKS, runAiTask, type AiTask } from './ai.js';
import { LocalEngine, createLocalAiProvider, runSetup } from './providers/localai.js';
import { newId } from '../shared/factory.js';

export interface AppContext {
  config: ServerConfig;
  assets: AssetStore;
  projects: ProjectStore;
  secrets: SecretStore;
  settings: SettingsStore;
  registry: ProviderRegistry;
  jobs: JobManager;
  exports: ExportService;
  engine: LocalEngine;
}

export async function createContext(overrides: Partial<ServerConfig> = {}, providers?: Provider[]): Promise<AppContext> {
  const config = loadConfig(overrides);
  detectFfmpeg(config.ffmpegPath, config.ffprobePath);
  const assets = new AssetStore(config);
  const secrets = new SecretStore(config.dataDir);
  const settings = new SettingsStore(config.dataDir);
  const projects = new ProjectStore(config.dataDir, assets);
  const registry = new ProviderRegistry(config, secrets, settings, assets, providers);
  const engine = new LocalEngine(config);
  registry.register(createLocalAiProvider(engine));
  const jobs = new JobManager(config, registry, assets, settings, projects);
  const exports = new ExportService(config.dataDir, assets, jobs, settings);
  await Promise.all([assets.load(), secrets.load(), settings.load()]);
  await projects.load();
  await registry.load();
  // The engine check imports PyTorch, which can take a while; never hold up the web server for it.
  void engine.refresh().then(() => registry.load()).catch(() => undefined);
  registerEngineJobs(jobs, engine);
  await jobs.load();
  return { config, assets, projects, secrets, settings, registry, jobs, exports, engine };
}

/** Engine installation and model downloads run as jobs so the UI shows progress and they can be canceled. */
function registerEngineJobs(jobs: JobManager, engine: LocalEngine) {
  jobs.registerLocalHandler('engine-setup', async (job, ctx) => {
    let lines = 0;
    const log: string[] = [];
    await runSetup(engine, {
      cpu: Boolean((job.params as { cpu?: boolean }).cpu),
      signal: ctx.signal,
      onLine: (line) => {
        lines++;
        log.push(line);
        // pip prints a lot; show the latest line and a rough progress estimate.
        const f = /Successfully installed|Engine ready/.test(line) ? 0.95 : Math.min(0.9, lines / 400);
        ctx.progress(f, line.slice(0, 200));
      },
    });
    const status = await engine.refresh();
    if (status.state !== 'ready') throw new Error(`Installed, but the self-check failed: ${status.message}`);
    return { outputAssetIds: [], result: { status, log: log.slice(-40) } };
  });
  jobs.registerLocalHandler('model-download', async (job, ctx) => {
    const id = String((job.params as { modelId?: string }).modelId);
    await engine.run(['download', '--model', id], {
      signal: ctx.signal,
      onEvent: (ev) => {
        if (ev.type === 'status') ctx.progress(0, String(ev.message));
        if (ev.type === 'progress' && typeof ev.fraction === 'number') {
          const gb = (n: unknown) => (Number(n) / 1024 ** 3).toFixed(1);
          ctx.progress(ev.fraction, `${gb(ev.bytes)} / ${gb(ev.totalBytes)} GB`);
        }
      },
    });
    const status = await engine.refresh();
    if (!status.installed[id]) throw new Error('Download finished but the model files are incomplete. Try again.');
    return { outputAssetIds: [], result: { modelId: id } };
  });
}

const asyncRoute = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

function bad(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError('Invalid request', r.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`));
  return r.data;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  try {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) total += await dirSize(p);
      else total += (await fsp.stat(p)).size;
    }
  } catch {
    /* missing dir */
  }
  return total;
}

export function createApp(ctx: AppContext): express.Express {
  const { config, assets, projects, secrets, settings, registry, jobs, exports } = ctx;
  const app = express();
  app.disable('x-powered-by');

  // ---- request guards: host allow-list (DNS rebinding) and same-origin for writes (CSRF).
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', config.host]);
  if (config.publicBaseUrl) allowedHosts.add(new URL(config.publicBaseUrl).hostname);
  for (const h of (process.env.VOIDCRAFT_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) allowedHosts.add(h);
  app.use((req, res, next) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (config.host !== '0.0.0.0' && host && !allowedHosts.has(host)) return res.status(403).json({ error: 'Host not allowed' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== 'null') {
        try {
          if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'Cross-origin request rejected' });
        } catch {
          return res.status(403).json({ error: 'Bad origin' });
        }
      }
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.use('/api', express.json({ limit: '25mb' }));

  const upload = multer({
    dest: assets.tmpDir,
    limits: { fileSize: Math.max(config.limits.maxVideoBytes, config.limits.maxProjectImportBytes), files: 1, fields: 20 },
  });

  /* ------------------------------------------------------------- system */

  app.get('/api/health', (_req, res) => res.json({ ok: true, version: config.version }));

  app.get(
    '/api/system',
    asyncRoute(async (_req, res) => {
      const ff = detectFfmpeg();
      let freeBytes: number | null = null;
      try {
        const st = await fsp.statfs(config.dataDir);
        freeBytes = Number(st.bavail) * Number(st.bsize);
      } catch {
        freeBytes = null;
      }
      const status: SystemStatus = {
        version: config.version,
        ffmpeg: { available: ff.available, version: ff.version, path: ff.ffmpeg, drawtext: ff.drawtext, error: ff.error },
        dataDir: config.dataDir,
        storage: {
          assetsBytes: await assets.totalBytes((a) => a.origin !== 'export'),
          exportsBytes: await assets.totalBytes((a) => a.origin === 'export'),
          freeBytes,
        },
        localAi: {
          state: ctx.engine.status.state,
          message: ctx.engine.status.message,
          device: ctx.engine.status.device,
          gpu: ctx.engine.status.gpu,
          modelsInstalled: ctx.engine.catalog.filter((m) => !m.test && ctx.engine.status.installed[m.id]).length,
        },
        aiProvidersConfigured: registry.configuredAiProviders(),
        limits: { maxVideoBytes: config.limits.maxVideoBytes, maxImageBytes: config.limits.maxImageBytes, maxAudioBytes: config.limits.maxAudioBytes },
      };
      res.json(status);
    }),
  );

  app.post(
    '/api/system/clear-temp',
    asyncRoute(async (_req, res) => {
      const before = await dirSize(assets.tmpDir);
      const active = new Set(jobs.list().filter((j) => !['succeeded', 'failed', 'canceled'].includes(j.status)).map((j) => j.id));
      for (const f of await fsp.readdir(assets.tmpDir)) {
        if ([...active].some((id) => f.includes(id))) continue;
        await fsp.rm(path.join(assets.tmpDir, f), { recursive: true, force: true });
      }
      res.json({ freedBytes: before - (await dirSize(assets.tmpDir)) });
    }),
  );

  app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    res.write(`retry: 3000\n\n`);
    const onJob = (job: unknown) => res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
    jobs.on('job', onJob);
    const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      jobs.off('job', onJob);
    });
  });

  /* -------------------------------------------------------- local engine */

  const engineView = () => ({
    status: ctx.engine.status,
    recommended: ctx.engine.recommended(),
    models: ctx.engine.catalog.map((m) => ({ ...m, installed: ctx.engine.status.installed[m.id] === true, estimate: ctx.engine.estimate(m) })),
  });
  app.get('/api/engine', (_req, res) => res.json(engineView()));
  app.post(
    '/api/engine/refresh',
    asyncRoute(async (_req, res) => {
      await ctx.engine.refresh();
      await registry.load();
      res.json(engineView());
    }),
  );
  const activeJob = (task: string, key?: (p: Record<string, unknown>) => boolean) =>
    jobs.list().find((j) => j.task === task && !['succeeded', 'failed', 'canceled'].includes(j.status) && (!key || key(j.params as Record<string, unknown>)));
  app.post(
    '/api/engine/setup',
    asyncRoute(async (req, res) => {
      const running = activeJob('engine-setup');
      if (running) return res.json(running);
      const [job] = await jobs.create({ task: 'engine-setup', providerId: 'local', modelId: 'engine', params: { cpu: req.body?.cpu === true, prompt: 'Install local AI engine' } });
      res.status(201).json(job);
    }),
  );
  app.post(
    '/api/engine/models/:id/download',
    asyncRoute(async (req, res) => {
      const m = ctx.engine.catalog.find((x) => x.id === req.params.id && !x.test);
      if (!m) bad('Unknown model', 404);
      if (ctx.engine.status.state !== 'ready') bad('Install the local AI engine first');
      const running = activeJob('model-download', (p) => p.modelId === m.id);
      if (running) return res.json(running);
      const [job] = await jobs.create({ task: 'model-download', providerId: 'local', modelId: m.id, params: { modelId: m.id, prompt: `Download ${m.name}` } });
      res.status(201).json(job);
    }),
  );
  app.delete(
    '/api/engine/models/:id',
    asyncRoute(async (req, res) => {
      const m = ctx.engine.catalog.find((x) => x.id === req.params.id && !x.test);
      if (!m) bad('Unknown model', 404);
      const r = await ctx.engine.run(['delete', '--model', m.id]);
      await ctx.engine.refresh();
      res.json({ removedBytes: r.removedBytes ?? 0, ...engineView() });
    }),
  );

  /* ----------------------------------------------------------- settings */

  app.get('/api/settings', (_req, res) => res.json(settings.get()));
  app.patch('/api/settings', asyncRoute(async (req, res) => res.json(await settings.patch(req.body))));
  app.post('/api/settings/reset', asyncRoute(async (_req, res) => res.json(await settings.reset())));

  /* ---------------------------------------------------------- providers */

  app.get('/api/providers', (_req, res) => res.json(registry.list().map((p) => registry.info(p.info.id))));

  app.put(
    '/api/providers/:id/credentials',
    asyncRoute(async (req, res) => {
      const provider = registry.get(req.params.id);
      const body = parse(z.record(z.string(), z.string().max(4000)), req.body);
      for (const [key, value] of Object.entries(body)) {
        const field = provider.info.credentialFields.find((f) => f.key === key);
        if (!field) bad(`Unknown credential field "${key}"`);
        if (value.trim() === '') await secrets.clear(provider.info.id, key);
        else {
          if (/\s/.test(value.trim())) bad(`${field.label} must not contain spaces`);
          await secrets.set(provider.info.id, key, value);
        }
      }
      res.json(registry.info(provider.info.id));
    }),
  );

  app.delete(
    '/api/providers/:id/credentials',
    asyncRoute(async (req, res) => {
      const provider = registry.get(req.params.id);
      await secrets.clear(provider.info.id);
      res.json(registry.info(provider.info.id));
    }),
  );

  app.post(
    '/api/providers/:id/test',
    asyncRoute(async (req, res) => {
      const provider = registry.get(req.params.id);
      if (!registry.isConfigured(provider.info.id)) return res.json({ ok: false, message: 'No credentials configured' });
      if (!provider.testConnection) return res.json({ ok: true, message: 'Credentials stored. This provider has no test endpoint; run a small job to verify.' });
      try {
        res.json(await provider.testConnection(registry.context(provider.info.id, AbortSignal.timeout(20_000))));
      } catch (err) {
        res.json({ ok: false, message: (err as Error).message });
      }
    }),
  );

  /* ----------------------------------------------------------- projects */

  const CreateProject = z.object({
    name: z.string().min(1).max(200),
    aspectRatio: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']).optional(),
    resolution: z.enum(['720p', '1080p', '4k']).optional(),
    fps: z.number().min(1).max(120).optional(),
    templateId: z.string().max(100).nullable().optional(),
  });

  app.get('/api/projects', asyncRoute(async (_req, res) => res.json(await projects.list())));
  app.post('/api/projects', asyncRoute(async (req, res) => res.status(201).json(await projects.create(parse(CreateProject, req.body)))));

  app.post(
    '/api/projects/import',
    upload.single('file'),
    asyncRoute(async (req, res) => {
      if (!req.file) bad('No file uploaded');
      try {
        res.status(201).json(await projects.importBundle(req.file.path, config.limits.maxProjectImportBytes));
      } finally {
        await fsp.rm(req.file.path, { force: true });
      }
    }),
  );

  app.post(
    '/api/projects/save-as',
    asyncRoute(async (req, res) => {
      const body = parse(z.object({ project: z.unknown(), name: z.string().min(1).max(200) }), req.body);
      const p = validateProject(body.project);
      const now = new Date().toISOString();
      res.status(201).json(await projects.save({ ...p, id: newId('prj'), name: body.name, createdAt: now, updatedAt: now }));
    }),
  );

  app.get(
    '/api/projects/:id',
    asyncRoute(async (req, res) => {
      const p = await projects.get(req.params.id);
      if (!p) bad('Project not found', 404);
      res.json(p);
    }),
  );

  app.put(
    '/api/projects/:id',
    asyncRoute(async (req, res) => {
      if (req.body?.id !== req.params.id) bad('Project id mismatch');
      if (!(await projects.exists(req.params.id))) bad('Project not found', 404);
      res.json(await projects.save(req.body));
    }),
  );

  app.post(
    '/api/projects/:id/autosave',
    asyncRoute(async (req, res) => {
      if (req.body?.id !== req.params.id) bad('Project id mismatch');
      res.json(await projects.autosave(req.body));
    }),
  );

  app.get(
    '/api/projects/:id/recovery',
    asyncRoute(async (req, res) => {
      // 200 with null when there is nothing to recover (not an error condition).
      res.json(await projects.getRecovery(req.params.id));
    }),
  );
  app.delete(
    '/api/projects/:id/recovery',
    asyncRoute(async (req, res) => {
      await projects.discardRecovery(req.params.id);
      res.json({ ok: true });
    }),
  );

  app.post('/api/projects/:id/duplicate', asyncRoute(async (req, res) => res.status(201).json(await projects.duplicate(req.params.id, typeof req.body?.name === 'string' ? req.body.name : undefined))));
  app.post('/api/projects/:id/rename', asyncRoute(async (req, res) => res.json(await projects.rename(req.params.id, parse(z.object({ name: z.string().min(1).max(200) }), req.body).name))));
  app.post(
    '/api/projects/:id/template',
    asyncRoute(async (req, res) => {
      const b = parse(z.object({ name: z.string().max(120), description: z.string().max(500).default('') }), req.body);
      res.status(201).json(await projects.saveAsTemplate(req.params.id, b.name, b.description));
    }),
  );

  app.delete(
    '/api/projects/:id',
    asyncRoute(async (req, res) => {
      if (req.body?.confirm !== true && req.query.confirm !== 'true') bad('Deletion must be confirmed (confirm: true)');
      const ok = await projects.remove(req.params.id);
      if (!ok) bad('Project not found', 404);
      res.json({ ok: true });
    }),
  );

  app.get(
    '/api/projects/:id/bundle',
    asyncRoute(async (req, res) => {
      const p = await projects.get(req.params.id);
      if (!p) bad('Project not found', 404);
      const tmp = assets.tempFile('.voidcraft');
      const includeMedia = req.query.media !== '0';
      const result = await projects.exportBundle(req.params.id, tmp, includeMedia);
      res.setHeader('X-Voidcraft-Missing-Assets', String(result.missing.length));
      res.download(tmp, `${p.name.replace(/[^\w.-]+/g, '_')}.voidcraft`, () => void fsp.rm(tmp, { force: true }));
    }),
  );

  /* ---------------------------------------------------- templates/prompts */

  app.get('/api/templates', (_req, res) => res.json(projects.listTemplates()));
  app.delete(
    '/api/templates/:id',
    asyncRoute(async (req, res) => {
      if (!(await projects.templates.remove(req.params.id))) bad('Template not found (built-in templates cannot be deleted)', 404);
      res.json({ ok: true });
    }),
  );

  app.get('/api/prompts', (_req, res) => res.json(projects.prompts.all().sort((a, b) => b.createdAt.localeCompare(a.createdAt))));
  app.post(
    '/api/prompts',
    asyncRoute(async (req, res) => {
      const b = parse(z.object({ title: z.string().min(1).max(120), prompt: z.string().min(1).max(8000), negative: z.string().max(4000).default(''), tags: z.array(z.string().max(40)).max(20).default([]) }), req.body);
      res.status(201).json(await projects.prompts.put({ id: newId('pr'), ...b, createdAt: new Date().toISOString() }));
    }),
  );
  app.delete(
    '/api/prompts/:id',
    asyncRoute(async (req, res) => {
      await projects.prompts.remove(req.params.id);
      res.json({ ok: true });
    }),
  );

  /* -------------------------------------------------------------- assets */

  app.get('/api/assets', (_req, res) => res.json(assets.list()));

  app.post(
    '/api/assets',
    upload.single('file'),
    asyncRoute(async (req, res) => {
      if (!req.file) bad('No file uploaded (field "file")');
      const allowRaw = typeof req.body.allow === 'string' ? req.body.allow.split(',') : undefined;
      const allow = allowRaw?.filter((a: string) => ['image', 'video', 'audio'].includes(a)) as Array<'image' | 'video' | 'audio'> | undefined;
      const origin = req.body.origin === 'recording' ? 'recording' : 'upload';
      const asset = await assets.importFile(req.file.path, req.file.originalname, {
        origin,
        projectId: typeof req.body.projectId === 'string' && req.body.projectId ? req.body.projectId : null,
        allow: allow?.length ? allow : undefined,
        tags: origin === 'recording' ? ['voice-over'] : [],
      });
      res.status(201).json(asset);
    }),
  );

  app.patch(
    '/api/assets/:id',
    asyncRoute(async (req, res) => {
      const b = parse(
        z.object({ name: z.string().max(200).optional(), tags: z.array(z.string().max(40)).max(30).optional(), favorite: z.boolean().optional(), projectIds: z.array(z.string().max(100)).max(200).optional() }).strict(),
        req.body,
      );
      const a = await assets.update(req.params.id, b);
      if (!a) bad('Asset not found', 404);
      res.json(a);
    }),
  );

  app.delete(
    '/api/assets/:id',
    asyncRoute(async (req, res) => {
      if (!(await assets.remove(req.params.id))) bad('Asset not found', 404);
      res.json({ ok: true });
    }),
  );

  app.get('/media/:id/:file', (req, res) => {
    const a = assets.get(req.params.id);
    if (!a) return res.status(404).end();
    const file = req.params.file;
    let full: string;
    let type: string;
    if (file === a.fileName) {
      full = assets.filePath(a);
      type = a.mime;
    } else if (file === 'thumb.jpg' && a.hasThumbnail) {
      full = assets.thumbPath(a);
      type = 'image/jpeg';
    } else if (file === 'waveform.png' && a.hasWaveform) {
      full = assets.waveformPath(a);
      type = 'image/png';
    } else return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${a.name.replace(/[^\w .-]+/g, '_')}.${a.fileName.split('.').pop()}"`);
    res.type(type);
    res.sendFile(full, { dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  /* ---------------------------------------------------------------- jobs */

  const CreateJob = z.object({
    task: z.enum(['text-to-video', 'image-to-video', 'video-to-video', 'text-to-image', 'text-to-speech', 'transcribe', 'tool']),
    providerId: z.string().min(1).max(100),
    modelId: z.string().min(1).max(200),
    params: z.record(z.string(), z.unknown()).default({}),
    projectId: z.string().max(100).nullable().optional(),
    shotId: z.string().max(100).nullable().optional(),
  });

  app.get('/api/jobs', (req, res) => res.json(jobs.list({ projectId: typeof req.query.projectId === 'string' ? req.query.projectId : undefined })));
  app.get(
    '/api/jobs/:id',
    asyncRoute(async (req, res) => {
      const j = jobs.get(req.params.id);
      if (!j) bad('Job not found', 404);
      res.json(j);
    }),
  );
  app.post('/api/jobs', asyncRoute(async (req, res) => res.status(201).json(await jobs.create(parse(CreateJob, req.body)))));
  app.post('/api/jobs/:id/cancel', asyncRoute(async (req, res) => res.json(await jobs.cancel(req.params.id))));
  app.post('/api/jobs/:id/retry', asyncRoute(async (req, res) => res.status(201).json(await jobs.retry(req.params.id))));
  app.delete(
    '/api/jobs/:id',
    asyncRoute(async (req, res) => {
      if (!(await jobs.remove(req.params.id))) bad('Job not found', 404);
      res.json({ ok: true });
    }),
  );

  /* ------------------------------------------------------------- exports */

  app.post(
    '/api/exports',
    asyncRoute(async (req, res) => {
      const b = parse(
        z.object({ project: z.unknown(), settings: z.unknown(), preview: z.boolean().optional(), range: z.object({ start: z.number().min(0), end: z.number().min(0) }).nullable().optional() }),
        req.body,
      );
      res.status(201).json(await exports.start(b.project, b.settings, { preview: b.preview, range: b.range ?? null }));
    }),
  );

  /** Render one exact frame through the real export pipeline (used for effect/frame previews). */
  app.post(
    '/api/render/frame',
    asyncRoute(async (req, res) => {
      const b = parse(z.object({ project: z.unknown(), t: z.number().min(0), width: z.number().int().min(64).max(3840).optional() }), req.body);
      const project = validateProject(b.project);
      const w = b.width ?? Math.min(960, project.settings.width);
      const h = Math.round((w * project.settings.height) / project.settings.width / 2) * 2;
      const workDir = path.join(assets.tmpDir, newId('frame'));
      const out = path.join(workDir, 'frame.jpg');
      try {
        const compiled = await compileRender(
          project,
          renderAssetsFor(project, assets),
          { width: w, height: h, fps: project.settings.fps, codec: 'h264', container: 'mp4', quality: 'draft', includeAudio: false, audioBitrateKbps: 128, frameAt: b.t },
          out,
          workDir,
        );
        await runFfmpeg(compiled.args, { timeoutMs: 120_000 });
        res.type('image/jpeg').send(await fsp.readFile(out));
      } finally {
        await fsp.rm(workDir, { recursive: true, force: true });
      }
    }),
  );

  /* ------------------------------------------------------------------ AI */

  app.post(
    '/api/ai/:task',
    asyncRoute(async (req, res) => {
      const task = req.params.task as AiTask;
      if (!AI_TASKS.includes(task)) bad('Unknown AI task', 404);
      const b = parse(z.object({ providerId: z.string().max(100).default('offline-templates'), input: z.unknown() }), req.body);
      const provider = registry.get(b.providerId);
      if (provider.info.id !== 'offline-templates') {
        if (!provider.llm) bad(`${provider.info.name} does not provide a language model`);
        if (!registry.isConfigured(provider.info.id)) bad(`${provider.info.name} is not configured`);
        if (!registry.isEnabled(provider.info.id)) bad(`${provider.info.name} is disabled`);
      }
      const signal = AbortSignal.timeout(240_000);
      res.json(await runAiTask(task, b.input, provider, provider.llm ? registry.context(provider.info.id, signal) : null));
    }),
  );

  /* ------------------------------------------------------- static web app */

  const webDir = path.resolve(process.env.VOIDCRAFT_WEB_DIR ?? path.join(process.cwd(), 'dist-web'));
  if (fs.existsSync(path.join(webDir, 'index.html'))) {
    app.use(express.static(webDir, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/|\/media\/).*/, (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
  }

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // ---- error handler: consistent JSON, no stack traces or secrets.
  app.use((err: Error & { status?: number; code?: string; details?: unknown }, _req: Request, res: Response, _next: NextFunction) => {
    let status = err.status ?? 500;
    let message = err.message || 'Internal error';
    if (err instanceof multer.MulterError) {
      status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      message = err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the maximum upload size' : `Upload error: ${err.message}`;
    } else if (err instanceof SyntaxError && 'body' in err) {
      status = 400;
      message = 'Malformed JSON body';
    } else if (!(err instanceof MediaError || err instanceof ProviderError || err instanceof ValidationError) && !err.status) {
      log.error('Unhandled error', err);
      message = 'Internal server error';
    }
    if (status >= 500) log.warn(`${status} ${message}`);
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: message, ...(err.details ? { details: err.details } : {}) });
  });

  return app;
}

export function hostname(): string {
  return os.hostname();
}
