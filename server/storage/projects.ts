import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Zip, ZipPassThrough, Unzip, UnzipInflate, UnzipPassThrough, strToU8, strFromU8 } from 'fflate';
import { ProjectSchema, type Project, type ProjectSummary } from '../../shared/project.js';
import { newId, BUILT_IN_TEMPLATES, createProject, makeTextClip, type ProjectTemplate } from '../../shared/factory.js';
import { readJson, writeFileAtomic, KeyedMutex, JsonCollection } from './jsonfile.js';
import type { AssetStore } from './assets.js';
import type { Asset } from '../../shared/api.js';
import { MediaError } from '../media/ffmpeg.js';
import { defaultEffectParams } from '../../shared/effects.js';
import { log } from '../logger.js';

export class ValidationError extends Error {
  status = 400;
  constructor(message: string, public details?: unknown) {
    super(message);
  }
}

export function validateProject(data: unknown): Project {
  const result = ProjectSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ValidationError('Project data is invalid', issues);
  }
  const p = result.data;
  // Structural checks the schema cannot express.
  const trackIds = new Set<string>();
  const clipIds = new Set<string>();
  for (const t of p.timeline.tracks) {
    if (trackIds.has(t.id)) throw new ValidationError(`Duplicate track id ${t.id}`);
    trackIds.add(t.id);
    for (const c of t.clips) {
      if (clipIds.has(c.id)) throw new ValidationError(`Duplicate clip id ${c.id}`);
      clipIds.add(c.id);
      if (c.kind === 'media' && c.out <= c.in) throw new ValidationError(`Clip ${c.id} has out point before in point`);
      if (c.kind === 'media' && t.kind !== 'video' && t.kind !== 'audio') throw new ValidationError(`Media clip ${c.id} is on a ${t.kind} track`);
      if (c.kind === 'text' && t.kind !== 'text') throw new ValidationError(`Text clip ${c.id} is on a ${t.kind} track`);
    }
  }
  return p;
}

interface SavedPrompt {
  id: string;
  title: string;
  prompt: string;
  negative: string;
  tags: string[];
  createdAt: string;
}

export class ProjectStore {
  readonly dir: string;
  private mutex = new KeyedMutex();
  readonly templates: JsonCollection<ProjectTemplate>;
  readonly prompts: JsonCollection<SavedPrompt>;

  constructor(private dataDir: string, private assets: AssetStore) {
    this.dir = path.join(dataDir, 'projects');
    fs.mkdirSync(this.dir, { recursive: true });
    this.templates = new JsonCollection(path.join(dataDir, 'templates.json'));
    this.prompts = new JsonCollection(path.join(dataDir, 'saved-prompts.json'));
  }

  async load(): Promise<void> {
    await this.templates.load();
    await this.prompts.load();
  }

  private pdir(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new ValidationError('Invalid project id');
    return path.join(this.dir, id);
  }

  private file(id: string, name: 'project.json' | 'autosave.json' | 'session.json'): string {
    return path.join(this.pdir(id), name);
  }

  async exists(id: string): Promise<boolean> {
    try {
      await fsp.access(this.file(id, 'project.json'));
      return true;
    } catch {
      return false;
    }
  }

  async get(id: string): Promise<Project | null> {
    const raw = await readJson<unknown>(this.file(id, 'project.json'), null);
    if (!raw) return null;
    return validateProject(raw);
  }

  async list(): Promise<ProjectSummary[]> {
    const ids = (await fsp.readdir(this.dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    const out: ProjectSummary[] = [];
    for (const id of ids) {
      try {
        const p = await this.get(id);
        if (!p) continue;
        const stat = await fsp.stat(this.file(id, 'project.json'));
        const recovery = await this.getRecovery(id);
        out.push(this.summarize(p, stat.mtime.toISOString(), recovery?.updatedAt ?? null));
      } catch (err) {
        log.warn(`Skipping unreadable project ${id}`, err);
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private summarize(p: Project, savedAt: string, recoveryAt: string | null): ProjectSummary {
    let thumb: string | null = null;
    let clipCount = 0;
    for (const t of p.timeline.tracks) {
      for (const c of t.clips) {
        clipCount++;
        if (!thumb && c.kind === 'media') {
          const a = this.assets.get(c.assetId);
          if (a?.hasThumbnail) thumb = a.id;
        }
      }
    }
    if (!thumb) {
      for (const s of p.storyboard.shots) {
        const a = this.assets.get(s.videoAssetId ?? s.frameAssetId ?? '');
        if (a?.hasThumbnail) {
          thumb = a.id;
          break;
        }
      }
    }
    return {
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      savedAt,
      aspectRatio: p.settings.aspectRatio,
      thumbnailAssetId: thumb,
      hasRecovery: Boolean(recoveryAt),
      recoveryAt,
      clipCount,
      shotCount: p.storyboard.shots.length,
    };
  }

  /** Explicit save: validates, writes project.json atomically, rotates backups and clears the autosave slot. */
  async save(data: unknown, opts: { keepAutosave?: boolean } = {}): Promise<Project> {
    const p = validateProject(data);
    p.updatedAt = new Date().toISOString();
    return this.mutex.run(p.id, async () => {
      const dir = this.pdir(p.id);
      await fsp.mkdir(path.join(dir, 'versions'), { recursive: true });
      const target = this.file(p.id, 'project.json');
      if (fs.existsSync(target)) {
        await fsp.copyFile(target, path.join(dir, 'versions', `${Date.now()}.json`));
        const versions = (await fsp.readdir(path.join(dir, 'versions'))).sort();
        for (const old of versions.slice(0, Math.max(0, versions.length - 10))) await fsp.rm(path.join(dir, 'versions', old), { force: true });
      }
      await writeFileAtomic(target, JSON.stringify(p, null, 1));
      if (!opts.keepAutosave) await fsp.rm(this.file(p.id, 'autosave.json'), { force: true });
      for (const assetId of p.assetIds) await this.assets.linkProject(assetId, p.id).catch(() => undefined);
      return p;
    });
  }

  /** Autosave slot: written frequently by the client; used for recovery after an interrupted session. */
  async autosave(data: unknown): Promise<{ updatedAt: string }> {
    const p = validateProject(data);
    if (!(await this.exists(p.id))) throw new ValidationError('Project does not exist; save it first');
    const updatedAt = new Date().toISOString();
    await this.mutex.run(p.id, () => writeFileAtomic(this.file(p.id, 'autosave.json'), JSON.stringify({ updatedAt, project: p })));
    return { updatedAt };
  }

  async getRecovery(id: string): Promise<{ updatedAt: string; project: Project } | null> {
    const raw = await readJson<{ updatedAt: string; project: unknown } | null>(this.file(id, 'autosave.json'), null);
    if (!raw) return null;
    try {
      return { updatedAt: raw.updatedAt, project: validateProject(raw.project) };
    } catch {
      return null;
    }
  }

  async discardRecovery(id: string): Promise<void> {
    await fsp.rm(this.file(id, 'autosave.json'), { force: true });
  }

  async create(opts: { name: string; aspectRatio?: Project['settings']['aspectRatio']; resolution?: '720p' | '1080p' | '4k'; fps?: number; templateId?: string | null }): Promise<Project> {
    const tpl = opts.templateId ? this.findTemplate(opts.templateId) : null;
    if (opts.templateId && !tpl) throw new ValidationError(`Unknown template ${opts.templateId}`);
    if (tpl?.snapshot) {
      const snap = validateProject(tpl.snapshot);
      const now = new Date().toISOString();
      return this.save({ ...snap, id: newId('prj'), name: opts.name, createdAt: now, updatedAt: now, templateId: tpl.id, generationJobIds: [], promptHistory: [] });
    }
    const p = createProject({
      name: opts.name,
      aspectRatio: opts.aspectRatio ?? tpl?.aspectRatio,
      resolution: opts.resolution ?? tpl?.resolution,
      fps: opts.fps ?? tpl?.fps,
      templateId: tpl?.id ?? null,
    });
    if (tpl) {
      p.storyboard.shots = (tpl.shotTitles ?? []).map((title) => ({
        id: newId('sht'),
        title,
        description: '',
        prompt: '',
        characterIds: [],
        environmentId: null,
        cameraAngle: '',
        camera: { move: 'static', framing: 'auto', speed: 0.4, intensity: 0.5, subjectFocus: '', direction: 'auto' },
        lighting: '',
        dialogue: '',
        duration: 5,
        status: 'draft',
        frameAssetId: null,
        videoAssetId: null,
        lastJobId: null,
        review: 'unreviewed',
        error: null,
      }));
      if (tpl.titleText) {
        const titles = p.timeline.tracks.find((t) => t.kind === 'text');
        titles?.clips.push(makeTextClip(tpl.titleText, 0, 3));
      }
      if (tpl.masterLetterbox) p.timeline.masterEffects.push({ id: newId('fx'), type: 'letterbox', enabled: true, params: defaultEffectParams('letterbox') });
    }
    return this.save(p);
  }

  findTemplate(id: string): ProjectTemplate | null {
    return BUILT_IN_TEMPLATES.find((t) => t.id === id) ?? this.templates.get(id) ?? null;
  }

  listTemplates(): ProjectTemplate[] {
    return [...BUILT_IN_TEMPLATES, ...this.templates.all().map((t) => ({ ...t, snapshot: undefined }))];
  }

  async saveAsTemplate(projectId: string, name: string, description: string): Promise<ProjectTemplate> {
    const p = await this.get(projectId);
    if (!p) throw new ValidationError('Project not found');
    const tpl: ProjectTemplate = {
      id: newId('tpl'),
      name: name.slice(0, 120) || `${p.name} template`,
      description: description.slice(0, 500),
      aspectRatio: p.settings.aspectRatio,
      resolution: p.settings.height >= 2160 ? '4k' : p.settings.height >= 1080 || p.settings.width >= 1080 ? '1080p' : '720p',
      fps: p.settings.fps,
      builtIn: false,
      snapshot: p,
    };
    await this.templates.put(tpl);
    return { ...tpl, snapshot: undefined };
  }

  async duplicate(id: string, name?: string): Promise<Project> {
    const p = await this.get(id);
    if (!p) throw new ValidationError('Project not found');
    const now = new Date().toISOString();
    return this.save({ ...p, id: newId('prj'), name: name ?? `${p.name} copy`, createdAt: now, updatedAt: now });
  }

  async rename(id: string, name: string): Promise<Project> {
    const p = await this.get(id);
    if (!p) throw new ValidationError('Project not found');
    return this.save({ ...p, name }, { keepAutosave: true });
  }

  async remove(id: string): Promise<boolean> {
    if (!(await this.exists(id))) return false;
    await this.mutex.run(id, () => fsp.rm(this.pdir(id), { recursive: true, force: true }));
    return true;
  }

  /* -------------------------------------------------------- bundle export */

  /** Collect every asset id the project references. */
  referencedAssetIds(p: Project): string[] {
    const ids = new Set<string>(p.assetIds);
    for (const t of p.timeline.tracks) for (const c of t.clips) if (c.kind === 'media') ids.add(c.assetId);
    for (const ch of p.characters) [...ch.referenceAssetIds, ...ch.approvedAssetIds].forEach((i) => ids.add(i));
    for (const e of p.environments) e.referenceAssetIds.forEach((i) => ids.add(i));
    for (const s of p.storyboard.shots) {
      if (s.frameAssetId) ids.add(s.frameAssetId);
      if (s.videoAssetId) ids.add(s.videoAssetId);
    }
    return [...ids];
  }

  /**
   * Write a .voidcraft bundle (zip): manifest.json, project.json, assets.json and media/.
   * Media is stored uncompressed; JSON is deflated.
   */
  async exportBundle(id: string, outFile: string, includeMedia = true): Promise<{ file: string; assetCount: number; missing: string[] }> {
    const p = await this.get(id);
    if (!p) throw new ValidationError('Project not found');
    const fd = fs.openSync(outFile, 'w');
    let zipErr: Error | null = null;
    const zip = new Zip((err, chunk) => {
      if (err) zipErr = err;
      else fs.writeSync(fd, chunk);
    });
    const addText = (name: string, text: string) => {
      const f = new ZipPassThrough(name);
      zip.add(f);
      f.push(strToU8(text), true);
    };
    const missing: string[] = [];
    const included: Asset[] = [];
    try {
      addText('manifest.json', JSON.stringify({ format: 'voidcraft-bundle', version: 1, exportedAt: new Date().toISOString(), includesMedia: includeMedia }));
      addText('project.json', JSON.stringify(p, null, 1));
      for (const assetId of this.referencedAssetIds(p)) {
        const asset = this.assets.get(assetId);
        if (!asset) {
          missing.push(assetId);
          continue;
        }
        included.push(asset);
        if (!includeMedia) continue;
        const entry = new ZipPassThrough(`media/${asset.id}/${asset.fileName}`);
        zip.add(entry);
        const stream = fs.createReadStream(this.assets.filePath(asset), { highWaterMark: 1 << 20 });
        for await (const chunk of stream) entry.push(chunk as Uint8Array);
        entry.push(new Uint8Array(0), true);
      }
      addText('assets.json', JSON.stringify(included, null, 1));
      zip.end();
      if (zipErr) throw zipErr;
    } finally {
      fs.closeSync(fd);
    }
    return { file: outFile, assetCount: included.length, missing };
  }

  /**
   * Import a .voidcraft bundle or a bare project JSON file. All media is
   * re-validated through the asset importer and receives new ids.
   */
  async importBundle(file: string, maxBytes: number): Promise<{ project: Project; warnings: string[] }> {
    const head = Buffer.alloc(4);
    const fh = await fsp.open(file, 'r');
    await fh.read(head, 0, 4, 0);
    await fh.close();
    const stat = await fsp.stat(file);
    if (stat.size > maxBytes) throw new ValidationError('Import file exceeds the size limit');
    const warnings: string[] = [];

    if (head.toString('latin1', 0, 2) !== 'PK') {
      // Bare JSON project.
      const text = await fsp.readFile(file, 'utf8');
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new ValidationError('File is neither a .voidcraft bundle nor valid project JSON');
      }
      const p = validateProject(raw);
      const missing = this.referencedAssetIds(p).filter((a) => !this.assets.get(a));
      if (missing.length) warnings.push(`${missing.length} referenced media file(s) are not in this library; affected clips will show as offline.`);
      const now = new Date().toISOString();
      const saved = await this.save({ ...p, id: (await this.exists(p.id)) ? newId('prj') : p.id, updatedAt: now });
      return { project: saved, warnings };
    }

    const workDir = path.join(this.assets.tmpDir, newId('imp'));
    await fsp.mkdir(workDir, { recursive: true });
    const texts = new Map<string, string>();
    const mediaFiles = new Map<string, string>(); // assetId -> extracted temp path
    try {
      await new Promise<void>((resolve, reject) => {
        let entries = 0;
        let total = 0;
        const pending = new Set<Promise<void>>();
        const unzip = new Unzip((entry) => {
          entries++;
          if (entries > 5000) return reject(new ValidationError('Bundle contains too many entries'));
          const name = entry.name;
          const isJson = ['manifest.json', 'project.json', 'assets.json'].includes(name);
          const mediaMatch = /^media\/([A-Za-z0-9_-]{1,100})\/source\.[a-z0-9]{2,5}$/.exec(name);
          if (!isJson && !mediaMatch) return; // ignore anything unexpected (prevents path traversal)
          const chunks: Uint8Array[] = [];
          let fd: number | null = null;
          let outPath = '';
          if (mediaMatch) {
            outPath = path.join(workDir, `${mediaMatch[1]}${path.extname(name)}`);
            fd = fs.openSync(outPath, 'w');
          }
          const done = new Promise<void>((res, rej) => {
            entry.ondata = (err, data, final) => {
              if (err) return rej(err);
              total += data.length;
              if (total > maxBytes) return rej(new ValidationError('Bundle exceeds the size limit when extracted'));
              if (fd !== null) fs.writeSync(fd, data);
              else {
                chunks.push(data);
                if (chunks.reduce((s, c) => s + c.length, 0) > 50 * 1048576) return rej(new ValidationError(`${name} is too large`));
              }
              if (final) {
                if (fd !== null) {
                  fs.closeSync(fd);
                  mediaFiles.set(mediaMatch![1], outPath);
                } else texts.set(name, strFromU8(concat(chunks)));
                res();
              }
            };
          });
          pending.add(done);
          done.catch(reject);
          entry.start();
        });
        unzip.register(UnzipInflate);
        unzip.register(UnzipPassThrough);
        const rs = fs.createReadStream(file, { highWaterMark: 1 << 20 });
        rs.on('data', (chunk) => {
          try {
            unzip.push(chunk as Uint8Array);
          } catch (e) {
            reject(new ValidationError(`Corrupt bundle: ${(e as Error).message}`));
          }
        });
        rs.on('error', reject);
        rs.on('end', () => {
          try {
            unzip.push(new Uint8Array(0), true);
          } catch (e) {
            return reject(new ValidationError(`Corrupt bundle: ${(e as Error).message}`));
          }
          Promise.all(pending).then(() => resolve(), reject);
        });
      });

      const manifest = safeParse(texts.get('manifest.json'));
      if (!manifest || (manifest as { format?: string }).format !== 'voidcraft-bundle') throw new ValidationError('Not a Voidcraft bundle (manifest missing)');
      const p = validateProject(safeParse(texts.get('project.json')));
      const assetMeta = (safeParse(texts.get('assets.json')) as Asset[] | null) ?? [];
      const idMap = new Map<string, string>();
      const newProjectId = (await this.exists(p.id)) ? newId('prj') : p.id;
      for (const meta of assetMeta) {
        if (!meta || typeof meta.id !== 'string') continue;
        const existing = this.assets.get(meta.id);
        const extracted = mediaFiles.get(meta.id);
        if (extracted) {
          try {
            const imported = await this.assets.importFile(extracted, meta.name ?? meta.fileName ?? 'media', {
              origin: meta.origin ?? 'upload',
              name: meta.name,
              projectId: newProjectId,
              tags: Array.isArray(meta.tags) ? meta.tags.filter((t) => typeof t === 'string') : [],
              provenance: typeof meta.provenance === 'object' && meta.provenance ? sanitizeProvenance(meta.provenance) : undefined,
            });
            idMap.set(meta.id, imported.id);
          } catch (err) {
            warnings.push(`Skipped media "${meta.name}": ${(err as Error).message}`);
          }
        } else if (existing) {
          idMap.set(meta.id, existing.id);
        } else {
          warnings.push(`Media "${meta.name}" was not included in the bundle and is not in this library.`);
        }
      }
      const remap = (i: string) => idMap.get(i) ?? i;
      const remapped: Project = {
        ...p,
        id: newProjectId,
        assetIds: [...new Set(p.assetIds.map(remap).concat([...idMap.values()]))],
        timeline: {
          ...p.timeline,
          tracks: p.timeline.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.kind === 'media' ? { ...c, assetId: remap(c.assetId) } : c)) })),
        },
        characters: p.characters.map((c) => ({ ...c, referenceAssetIds: c.referenceAssetIds.map(remap), approvedAssetIds: c.approvedAssetIds.map(remap), rejectedAssetIds: c.rejectedAssetIds.map(remap) })),
        environments: p.environments.map((e) => ({ ...e, referenceAssetIds: e.referenceAssetIds.map(remap) })),
        storyboard: {
          ...p.storyboard,
          shots: p.storyboard.shots.map((s) => ({ ...s, frameAssetId: s.frameAssetId ? remap(s.frameAssetId) : null, videoAssetId: s.videoAssetId ? remap(s.videoAssetId) : null })),
        },
        generationJobIds: [],
      };
      const saved = await this.save(remapped);
      return { project: saved, warnings };
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true });
    }
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function safeParse(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sanitizeProvenance(p: Partial<Asset['provenance']>): Partial<Asset['provenance']> {
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 4000) : null);
  return {
    aiGenerated: p.aiGenerated === true,
    generator: str(p.generator),
    providerId: str(p.providerId),
    modelId: str(p.modelId),
    prompt: str(p.prompt),
    note: str(p.note),
  };
}

export { MediaError };
