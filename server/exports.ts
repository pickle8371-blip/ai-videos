/**
 * Export and preview rendering, run as local jobs so they share progress
 * reporting, cancellation and history with generation jobs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExportSettings, Project } from '../shared/project.js';
import { ExportSettingsSchema } from '../shared/project.js';
import { newId } from '../shared/factory.js';
import { timelineDuration } from '../shared/timeline.js';
import type { AssetStore } from './storage/assets.js';
import { sanitizeName } from './storage/assets.js';
import type { JobManager } from './jobs/manager.js';
import type { SettingsStore } from './storage/settings.js';
import { validateProject } from './storage/projects.js';
import { render, validateCodecContainer, validateOutput, type RenderAsset } from './media/render.js';
import { MediaError } from './media/ffmpeg.js';
import { readJson, writeFileAtomic } from './storage/jsonfile.js';
import { log } from './logger.js';

export function renderAssetsFor(project: Project, assets: AssetStore): Map<string, RenderAsset> {
  const map = new Map<string, RenderAsset>();
  for (const t of project.timeline.tracks) {
    for (const c of t.clips) {
      if (c.kind !== 'media' || map.has(c.assetId)) continue;
      const a = assets.get(c.assetId);
      if (!a) continue;
      map.set(a.id, { id: a.id, path: assets.filePath(a), type: a.type, width: a.width, height: a.height, duration: a.duration, hasAudio: a.hasAudio });
    }
  }
  return map;
}

export interface ExportJobParams {
  snapshotId: string;
  projectId: string;
  projectName: string;
  settings: ExportSettings;
  preview: boolean;
  range: { start: number; end: number } | null;
}

export class ExportService {
  private snapDir: string;
  constructor(private dataDir: string, private assets: AssetStore, private jobs: JobManager, private settings: SettingsStore) {
    this.snapDir = path.join(dataDir, 'exports', 'snapshots');
    jobs.registerLocalHandler('export', (job, ctx) => this.run(job.id, job.params as unknown as ExportJobParams, ctx.signal, ctx.progress));
  }

  /** Validate and queue an export of the given project state. */
  async start(projectData: unknown, settingsData: unknown, opts: { preview?: boolean; range?: { start: number; end: number } | null } = {}) {
    const project = validateProject(projectData);
    const parsed = ExportSettingsSchema.safeParse(settingsData);
    if (!parsed.success) throw new MediaError(`Invalid export settings: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 400);
    let settings = parsed.data;
    const codecErr = validateCodecContainer(settings.codec, settings.container);
    if (codecErr) throw new MediaError(codecErr, 400);
    if (timelineDuration(project.timeline) <= 0) throw new MediaError('The timeline is empty — add clips before exporting.', 400);
    const missing = project.timeline.tracks.flatMap((t) => t.clips).filter((c) => c.kind === 'media' && !this.assets.get(c.assetId));
    if (missing.length) throw new MediaError(`${missing.length} clip(s) reference media that is missing from the library. Remove or relink them first.`, 400);
    if (opts.preview) {
      // Preview renders: ≤ 540p, draft quality, H.264.
      const scale = Math.min(1, 540 / Math.min(settings.width, settings.height));
      settings = { ...settings, width: Math.round((settings.width * scale) / 2) * 2, height: Math.round((settings.height * scale) / 2) * 2, codec: 'h264', container: 'mp4', quality: 'draft' };
    }
    const snapshotId = newId('snap');
    await writeFileAtomic(path.join(this.snapDir, `${snapshotId}.json`), JSON.stringify(project));
    const params: ExportJobParams = { snapshotId, projectId: project.id, projectName: project.name, settings, preview: Boolean(opts.preview), range: opts.range ?? null };
    const [job] = await this.jobs.create({ task: 'export', providerId: 'local', modelId: opts.preview ? 'preview' : `${settings.codec}/${settings.container}`, params: params as unknown as Record<string, unknown>, projectId: project.id });
    return job;
  }

  private async run(jobId: string, p: ExportJobParams, signal: AbortSignal, progress: (f: number, m?: string) => void) {
    const project = validateProject(await readJson<unknown>(path.join(this.snapDir, `${p.snapshotId}.json`), null));
    const s = p.settings;
    const workDir = path.join(this.assets.tmpDir, `export_${jobId}`);
    await fs.mkdir(workDir, { recursive: true });
    const ext = s.container;
    const base = sanitizeName(s.fileName || `${p.projectName}${p.preview ? ' (preview)' : ''}`).replace(/\.(mp4|mov|webm)$/i, '');
    const outFile = path.join(workDir, `out.${ext}`);
    const total = timelineDuration(project.timeline);
    const expectDuration = p.range ? Math.min(total, p.range.end) - Math.max(0, p.range.start) : total;
    try {
      progress(0, 'Rendering');
      await render(
        project,
        renderAssetsFor(project, this.assets),
        { width: s.width, height: s.height, fps: s.fps, codec: s.codec, container: s.container, quality: s.quality, includeAudio: s.includeAudio, audioBitrateKbps: s.audioBitrateKbps, range: p.range ?? undefined, fast: p.preview },
        outFile,
        workDir,
        { signal, onProgress: (f) => progress(Math.min(0.97, f * 0.97), 'Rendering') },
      );
      progress(0.98, 'Validating output');
      const v = await validateOutput(outFile, { width: s.width, height: s.height, duration: expectDuration, audio: s.includeAudio });
      if (!v.ok) throw new MediaError(v.error ?? 'Output validation failed', 500);
      const asset = await this.assets.importFile(outFile, `${base}.${ext}`, {
        origin: 'export',
        name: base,
        projectId: project.id,
        tags: p.preview ? ['preview'] : ['export'],
        provenance: { aiGenerated: false, generator: 'Voidcraft render pipeline (FFmpeg)', note: p.preview ? 'Preview render' : 'Timeline export' },
      });
      let copiedTo: string | null = null;
      const exportDir = this.settings.get().storage.exportDir.trim();
      if (!p.preview && exportDir) {
        try {
          await fs.mkdir(exportDir, { recursive: true });
          copiedTo = path.join(exportDir, `${base}.${ext}`);
          await fs.copyFile(this.assets.filePath(asset), copiedTo);
        } catch (err) {
          log.warn('Could not copy export to export folder', err);
          copiedTo = null;
        }
      }
      if (p.preview) await this.prunePreviews(project.id, asset.id);
      return {
        outputAssetIds: [asset.id],
        result: { file: this.assets.filePath(asset), copiedTo, validation: v },
      };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  /** Keep only the three most recent preview renders per project. */
  private async prunePreviews(projectId: string, keepId: string) {
    const previews = this.assets
      .list()
      .filter((a) => a.origin === 'export' && a.tags.includes('preview') && a.projectIds.includes(projectId) && a.id !== keepId);
    for (const old of previews.slice(2)) await this.assets.remove(old.id);
  }
}
