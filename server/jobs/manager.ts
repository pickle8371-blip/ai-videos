/**
 * Generation job lifecycle.
 *
 * queued → submitting → running → downloading → succeeded
 *                    ↘ failed / canceled
 *
 * Jobs are persisted to data/jobs.json on every transition. On startup, jobs
 * that already have a provider-side id resume polling; jobs that were
 * interrupted before submission are marked failed with their parameters kept
 * so they can be retried with one click.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GenerationParams, JobRecord, JobTask, ModelInfo } from '../../shared/api.js';
import { newId } from '../../shared/factory.js';
import { composePrompt } from '../../shared/prompt.js';
import type { Project } from '../../shared/project.js';
import type { ServerConfig } from '../config.js';
import { log } from '../logger.js';
import type { AssetStore } from '../storage/assets.js';
import { JsonCollection } from '../storage/jsonfile.js';
import type { ProjectStore } from '../storage/projects.js';
import type { SettingsStore } from '../storage/settings.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { PollResult, ProviderOutput } from '../providers/types.js';
import { ProviderError } from '../providers/types.js';
import { pickDuration } from '../providers/common.js';

export interface CreateJobInput {
  task: JobTask;
  providerId: string;
  modelId: string;
  params: Record<string, unknown>;
  projectId?: string | null;
  shotId?: string | null;
}

export type LocalHandler = (job: JobRecord, ctx: { signal: AbortSignal; progress: (f: number, message?: string) => void }) => Promise<{ outputAssetIds: string[]; result?: Record<string, unknown> }>;

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const MAX_CONSECUTIVE_POLL_ERRORS = 6;

export class JobManager extends EventEmitter {
  private jobs: JsonCollection<JobRecord>;
  private active = new Map<string, AbortController>();
  private localHandlers = new Map<JobTask, LocalHandler>();
  private pumping = false;
  private shuttingDown = false;

  constructor(
    private config: ServerConfig,
    private registry: ProviderRegistry,
    private assets: AssetStore,
    private settings: SettingsStore,
    private projects: ProjectStore,
  ) {
    super();
    this.setMaxListeners(100);
    this.jobs = new JsonCollection(path.join(config.dataDir, 'jobs.json'));
  }

  registerLocalHandler(task: JobTask, handler: LocalHandler): void {
    this.localHandlers.set(task, handler);
  }

  async load(): Promise<void> {
    await this.jobs.load();
    for (const job of this.jobs.all()) {
      if (TERMINAL.has(job.status)) continue;
      if ((job.status === 'running' || job.status === 'downloading') && job.providerJobId && this.registry.has(job.providerId) && !this.localHandlers.has(job.task)) {
        log.info(`Resuming job ${job.id} (${job.providerId})`);
        await this.patch(job.id, { status: 'running', message: 'Resumed after restart' });
        this.track(job.id);
      } else {
        await this.patch(job.id, {
          status: 'failed',
          error: 'Interrupted before completion (the server stopped). Your settings were kept — use Retry to run it again.',
          finishedAt: new Date().toISOString(),
        });
      }
    }
  }

  list(filter: { projectId?: string; status?: string } = {}): JobRecord[] {
    return this.jobs
      .all()
      .filter((j) => (filter.projectId ? j.projectId === filter.projectId : true))
      .filter((j) => (filter.status ? j.status === filter.status : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  private async patch(id: string, patch: Partial<JobRecord>): Promise<JobRecord | undefined> {
    const next = await this.jobs.update(id, (j) => ({ ...j, ...patch, updatedAt: new Date().toISOString() }));
    if (next) this.emit('job', next);
    return next;
  }

  /** Validate a request against provider capabilities and create job record(s). */
  async create(input: CreateJobInput): Promise<JobRecord[]> {
    const local = this.localHandlers.get(input.task);
    let model: ModelInfo | null = null;
    if (!local) {
      const provider = this.registry.get(input.providerId);
      if (!this.registry.isEnabled(input.providerId)) throw new ProviderError(`${provider.info.name} is disabled in Settings`, 400);
      if (!this.registry.isConfigured(input.providerId)) throw new ProviderError(`${provider.info.name} is not configured. Add credentials in Settings → Providers.`, 400);
      if (!provider.submit) throw new ProviderError(`${provider.info.name} cannot run jobs`, 400);
      model = this.registry.findModel(input.providerId, input.modelId);
      if (!model.tasks.includes(input.task)) throw new ProviderError(`${model.name} does not support ${input.task}`, 400);
    }
    const params = { ...(input.params as GenerationParams & Record<string, unknown>) };
    if (model) await this.validateParams(input.task, model, params, input.projectId ?? null);

    const variations = model ? Math.max(1, Math.min(4, Number(params.variations ?? 1))) : 1;
    // Image models return N outputs from one request; video models get one job per variation.
    const native = input.task === 'text-to-image' && (model?.capabilities.maxVariations ?? 1) > 1;
    const count = native ? 1 : variations;
    const created: JobRecord[] = [];
    for (let i = 0; i < count; i++) {
      const now = new Date().toISOString();
      const job: JobRecord = {
        id: newId('job'),
        task: input.task,
        providerId: local ? 'local' : input.providerId,
        modelId: input.modelId,
        projectId: input.projectId ?? null,
        shotId: input.shotId ?? null,
        status: 'queued',
        progress: null,
        message: 'Waiting in queue',
        params: count > 1 ? { ...params, variationIndex: i, ...(typeof params.seed === 'number' ? { seed: params.seed + i } : {}) } : params,
        providerJobId: null,
        providerState: {},
        outputAssetIds: [],
        result: null,
        error: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
        retryOf: (input.params as { retryOf?: string }).retryOf ?? null,
      };
      await this.jobs.put(job);
      this.emit('job', job);
      created.push(job);
    }
    if (model && this.registry.get(input.providerId).info.isAI) for (let i = 0; i < count; i++) await this.registry.recordUsage(input.providerId, 'submitted');
    this.pump();
    return created;
  }

  private async validateParams(task: JobTask, model: ModelInfo, p: GenerationParams & Record<string, unknown>, projectId: string | null): Promise<void> {
    const caps = model.capabilities;
    const needsPrompt = ['text-to-video', 'text-to-image', 'video-to-video'].includes(task);
    if (needsPrompt && !(p.prompt ?? '').trim()) throw new ProviderError('Prompt is empty', 400);
    if ((p.prompt ?? '').length > 4000) throw new ProviderError('Prompt is too long (max 4000 characters)', 400);
    if (p.negativePrompt && !caps.negativePrompt) delete p.negativePrompt;
    if (p.seed !== undefined && p.seed !== null && !caps.seed) p.seed = null;
    if (typeof p.variations === 'number' && p.variations > 1 && task === 'text-to-image' && caps.maxVariations && p.variations > caps.maxVariations) p.variations = caps.maxVariations;
    if (p.endImageAssetId && !caps.endFrame) throw new ProviderError(`${model.name} does not support an end frame`, 400);
    const checkAsset = (id: string | null | undefined, type: 'image' | 'video' | 'audio' | 'av', label: string) => {
      if (!id) return;
      const a = this.assets.get(id);
      if (!a) throw new ProviderError(`${label} not found in the asset library`, 400);
      if (type === 'av' ? a.type === 'image' : a.type !== type) throw new ProviderError(`${label} must be ${type === 'av' ? 'an audio or video file' : `a ${type}`}`, 400);
    };
    if (task === 'image-to-video' && !p.startImageAssetId) throw new ProviderError('Choose a start image for image-to-video', 400);
    if (task === 'video-to-video' && !p.sourceVideoAssetId) throw new ProviderError('Choose source footage for video-to-video', 400);
    if (task === 'transcribe' && !p.audioAssetId) throw new ProviderError('Choose audio to transcribe', 400);
    if (task === 'text-to-speech' && !(p.text ?? '').trim()) throw new ProviderError('Enter the text to speak', 400);
    checkAsset(p.startImageAssetId, 'image', 'Start image');
    checkAsset(p.endImageAssetId, 'image', 'End image');
    checkAsset(p.sourceVideoAssetId, 'video', 'Source video');
    checkAsset(p.audioAssetId, 'av', 'Audio');
    for (const r of p.referenceAssetIds ?? []) checkAsset(r, 'image', 'Reference image');
    if (caps.durations && p.duration !== undefined) p.duration = pickDuration(model, Number(p.duration));

    // Compose the final prompt with camera/style/reference descriptions.
    let project: Project | null = null;
    if (projectId) project = await this.projects.get(projectId).catch(() => null);
    const characters = (p.characterIds ?? []).map((cid) => project?.characters.find((c) => c.id === cid)).filter((c): c is NonNullable<typeof c> => Boolean(c));
    const environment = p.environmentId ? project?.environments.find((e) => e.id === p.environmentId) ?? null : null;
    if (['text-to-video', 'image-to-video', 'video-to-video', 'text-to-image'].includes(task)) {
      p.compiledPrompt = composePrompt({
        prompt: p.prompt ?? '',
        style: p.style,
        lighting: p.lighting,
        camera: caps.camera === 'none' || task === 'text-to-image' ? (p.camera ? { ...p.camera, move: 'static' } : undefined) : p.camera,
        motionIntensity: task === 'text-to-image' ? undefined : p.motionIntensity,
        complexity: p.complexity,
        subjectMotion: p.subjectMotion,
        environmentMotion: p.environmentMotion,
        characters,
        environment,
        preserveReference: p.preserveReference,
      }).slice(0, 4000);
    }
  }

  /** Start queued jobs up to the concurrency limit. */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const max = this.settings.get().performance.maxConcurrentJobs;
      const runningCount = this.jobs.all().filter((j) => ['submitting', 'running', 'downloading'].includes(j.status)).length;
      let slots = max - runningCount;
      const queued = this.jobs
        .all()
        .filter((j) => j.status === 'queued')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const job of queued) {
        // Exports and tools are local and bounded separately (one at a time each is enough).
        if (slots <= 0) break;
        slots--;
        this.start(job.id);
      }
    } finally {
      this.pumping = false;
    }
  }

  private start(id: string): void {
    const ctrl = new AbortController();
    this.active.set(id, ctrl);
    void this.execute(id, ctrl).finally(() => {
      this.active.delete(id);
      this.pump();
    });
  }

  private track(id: string): void {
    const ctrl = new AbortController();
    this.active.set(id, ctrl);
    void this.pollLoop(id, ctrl).finally(() => {
      this.active.delete(id);
      this.pump();
    });
  }

  private async execute(id: string, ctrl: AbortController): Promise<void> {
    const job = this.get(id);
    if (!job) return;
    await this.patch(id, { status: 'submitting', startedAt: new Date().toISOString(), attempts: job.attempts + 1, message: 'Submitting' });
    const local = this.localHandlers.get(job.task);
    if (local) {
      try {
        let lastEmit = 0;
        const out = await local(job, {
          signal: ctrl.signal,
          progress: (f, message) => {
            const now = Date.now();
            if (now - lastEmit < 400 && f < 1) return;
            lastEmit = now;
            void this.patch(id, { status: 'running', progress: f, message: message ?? null });
          },
        });
        await this.patch(id, { status: 'succeeded', progress: 1, outputAssetIds: out.outputAssetIds, result: out.result ?? null, message: 'Done', finishedAt: new Date().toISOString() });
      } catch (err) {
        await this.finishWithError(id, err, ctrl);
      }
      return;
    }
    try {
      const provider = this.registry.get(job.providerId);
      const model = this.registry.findModel(job.providerId, job.modelId);
      const ctx = this.registry.context(job.providerId, ctrl.signal);
      const submitted = await provider.submit!(job, model, ctx);
      await this.patch(id, { providerJobId: submitted.providerJobId, providerState: submitted.state ?? {}, status: 'running', message: 'Submitted to provider' });
      if (submitted.immediate) {
        await this.handleResult(id, submitted.immediate, ctrl);
        return;
      }
    } catch (err) {
      await this.finishWithError(id, err, ctrl);
      return;
    }
    await this.pollLoop(id, ctrl);
  }

  private async pollLoop(id: string, ctrl: AbortController): Promise<void> {
    let errors = 0;
    const timeoutMs = this.settings.get().jobs.timeoutMinutes * 60_000;
    for (;;) {
      const job = this.get(id);
      if (!job || TERMINAL.has(job.status)) return;
      const startedAt = Date.parse(job.startedAt ?? job.createdAt);
      if (Date.now() - startedAt > timeoutMs) {
        await this.cancelRemote(job);
        await this.patch(id, { status: 'failed', error: `Timed out after ${this.settings.get().jobs.timeoutMinutes} minutes. The provider may still finish; increase the timeout in Settings and retry.`, finishedAt: new Date().toISOString() });
        return;
      }
      const isLocal = job.providerId.startsWith('local');
      await sleep(isLocal ? 500 : this.config.pollIntervalMs, ctrl.signal).catch(() => undefined);
      if (ctrl.signal.aborted) return;
      try {
        const provider = this.registry.get(job.providerId);
        const model = this.registry.findModel(job.providerId, job.modelId);
        const result = await provider.poll!(job, model, this.registry.context(job.providerId, ctrl.signal));
        errors = 0;
        if (result.status === 'running') {
          const cur = this.get(id);
          if (cur && (cur.progress !== (result.progress ?? null) || cur.message !== (result.message ?? cur.message))) {
            await this.patch(id, { progress: result.progress ?? null, message: result.message ?? cur.message, ...(result.state ? { providerState: { ...cur.providerState, ...result.state } } : {}) });
          }
          continue;
        }
        await this.handleResult(id, result, ctrl);
        return;
      } catch (err) {
        if (ctrl.signal.aborted) return;
        errors++;
        const pe = err instanceof ProviderError ? err : null;
        if (pe && !pe.retryable && pe.status !== 404) {
          await this.finishWithError(id, err, ctrl);
          return;
        }
        if (errors >= MAX_CONSECUTIVE_POLL_ERRORS) {
          await this.finishWithError(id, new ProviderError(`Lost contact with provider after ${errors} attempts: ${(err as Error).message}`, 504), ctrl);
          return;
        }
        await this.patch(id, { message: `Status check failed (${errors}/${MAX_CONSECUTIVE_POLL_ERRORS}), retrying: ${(err as Error).message}` });
        if (pe?.retryAfterMs) await sleep(pe.retryAfterMs, ctrl.signal).catch(() => undefined);
      }
    }
  }

  private async handleResult(id: string, result: PollResult, ctrl: AbortController): Promise<void> {
    const job = this.get(id);
    if (!job) return;
    if (result.status === 'failed') return void (await this.finishWithError(id, new ProviderError(result.error, 502, result.retryable ?? false), ctrl));
    if (result.status === 'canceled') {
      await this.patch(id, { status: 'canceled', message: 'Canceled by provider', finishedAt: new Date().toISOString() });
      return;
    }
    if (result.status !== 'succeeded') return;
    await this.patch(id, { status: 'downloading', message: 'Saving results', progress: null });
    const provider = this.registry.get(job.providerId);
    const assetIds: string[] = [];
    const errors: string[] = [];
    for (const out of result.outputs) {
      try {
        const asset = await this.importOutput(out, job, provider.info.isAI, ctrl.signal);
        assetIds.push(asset.id);
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    if (result.outputs.length > 0 && assetIds.length === 0) {
      await this.finishWithError(id, new ProviderError(`Result could not be saved: ${errors.join('; ')}`, 502), ctrl);
      return;
    }
    const secs = assetIds.reduce((s, a) => s + (this.assets.get(a)?.duration ?? 0), 0);
    if (provider.info.isAI) await this.registry.recordUsage(job.providerId, 'succeeded', secs);
    await this.patch(id, {
      status: 'succeeded',
      progress: 1,
      outputAssetIds: assetIds,
      result: result.result ?? null,
      message: errors.length ? `Saved ${assetIds.length} result(s); ${errors.length} failed` : `Saved ${assetIds.length} result(s)`,
      finishedAt: new Date().toISOString(),
      error: errors.length ? errors.join('; ') : null,
    });
    // Clean up the local provider work directory, if any.
    const workDir = (job.providerState as { workDir?: string }).workDir;
    if (workDir && workDir.startsWith(this.assets.tmpDir)) await fs.rm(workDir, { recursive: true, force: true });
  }

  private async importOutput(out: ProviderOutput, job: JobRecord, isAI: boolean, signal: AbortSignal) {
    const p = job.params as GenerationParams;
    const baseName = (p.prompt || p.text || out.name).replace(/\s+/g, ' ').trim().slice(0, 48) || out.name;
    const opts = {
      origin: (job.task === 'tool' ? 'tool' : 'generated') as 'tool' | 'generated',
      name: `${baseName}${(p as { variationIndex?: number }).variationIndex ? ` (v${((p as { variationIndex?: number }).variationIndex ?? 0) + 1})` : ''}`,
      projectId: job.projectId,
      tags: [job.task, job.providerId],
      provenance: {
        aiGenerated: isAI,
        generator: isAI ? `${job.providerId}/${job.modelId}` : job.providerId === 'local-test' ? 'Local test renderer (not AI)' : `FFmpeg tool: ${job.modelId}`,
        providerId: job.providerId,
        modelId: job.modelId,
        jobId: job.id,
        prompt: p.compiledPrompt ?? p.prompt ?? p.text ?? null,
        sourceAssetIds: [p.startImageAssetId, p.endImageAssetId, p.sourceVideoAssetId, p.audioAssetId, (job.params as { sourceAssetId?: string }).sourceAssetId].filter((x): x is string => Boolean(x)),
        note: isAI ? null : 'Not AI generated',
      },
    };
    if (out.kind === 'url') return this.assets.importUrl(out.url, out.name, { ...opts, headers: out.headers, signal });
    if (out.kind === 'buffer') return this.assets.importBuffer(out.data, out.name, opts);
    return this.assets.importFile(out.path, out.name, opts);
  }

  private async finishWithError(id: string, err: unknown, ctrl: AbortController): Promise<void> {
    const job = this.get(id);
    if (!job || TERMINAL.has(job.status) || this.shuttingDown) return;
    if (ctrl.signal.aborted) {
      await this.patch(id, { status: 'canceled', message: 'Canceled', finishedAt: new Date().toISOString() });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Job ${id} failed: ${msg}`);
    if (this.registry.has(job.providerId) && this.registry.get(job.providerId).info.isAI) await this.registry.recordUsage(job.providerId, 'failed');
    await this.patch(id, { status: 'failed', error: msg, message: null, finishedAt: new Date().toISOString() });
  }

  private async cancelRemote(job: JobRecord): Promise<boolean> {
    if (!this.registry.has(job.providerId)) return false;
    const provider = this.registry.get(job.providerId);
    if (!provider.cancel || !job.providerJobId) return false;
    try {
      const model = this.registry.findModel(job.providerId, job.modelId);
      await provider.cancel(job, model, this.registry.context(job.providerId, new AbortController().signal));
      return true;
    } catch (err) {
      log.warn(`Provider cancel failed for ${job.id}`, err);
      return false;
    }
  }

  async cancel(id: string): Promise<JobRecord> {
    const job = this.get(id);
    if (!job) throw new ProviderError('Job not found', 404);
    if (TERMINAL.has(job.status)) return job;
    const remote = await this.cancelRemote(job);
    this.active.get(id)?.abort();
    const supports = this.registry.has(job.providerId) ? this.registry.get(job.providerId).info.supportsCancel : true;
    return (await this.patch(id, {
      status: 'canceled',
      message: supports || remote || job.providerId === 'local' ? 'Canceled' : 'Stopped tracking (this provider cannot cancel remotely; it may still bill for the job)',
      finishedAt: new Date().toISOString(),
    }))!;
  }

  async retry(id: string): Promise<JobRecord[]> {
    const job = this.get(id);
    if (!job) throw new ProviderError('Job not found', 404);
    const { variationIndex: _v, compiledPrompt: _c, ...params } = job.params as Record<string, unknown>;
    return this.create({
      task: job.task,
      providerId: job.providerId === 'local' ? 'local' : job.providerId,
      modelId: job.modelId,
      params: { ...params, variations: 1, retryOf: job.id },
      projectId: job.projectId,
      shotId: job.shotId,
    });
  }

  async remove(id: string): Promise<boolean> {
    const job = this.get(id);
    if (!job) return false;
    if (!TERMINAL.has(job.status)) await this.cancel(id);
    return this.jobs.remove(id);
  }

  /** Abort in-flight work (used on shutdown and in tests). Remote jobs keep running and resume on next start. */
  shutdown(): void {
    this.shuttingDown = true;
    for (const c of this.active.values()) c.abort();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });
}
