import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Asset, AssetOrigin } from '../../shared/api.js';
import { newId } from '../../shared/factory.js';
import { JsonCollection } from './jsonfile.js';
import { sniffFile } from '../media/filetype.js';
import { MediaError, probe, runFfmpeg } from '../media/ffmpeg.js';
import { log } from '../logger.js';
import type { ServerConfig } from '../config.js';

export interface ImportOptions {
  origin: AssetOrigin;
  name?: string;
  projectId?: string | null;
  tags?: string[];
  provenance?: Partial<Asset['provenance']>;
  /** Restrict to these asset types (e.g. image-to-video requires an image). */
  allow?: Array<Asset['type']>;
}

const DEFAULT_PROVENANCE: Asset['provenance'] = {
  aiGenerated: false,
  generator: null,
  providerId: null,
  modelId: null,
  jobId: null,
  prompt: null,
  sourceAssetIds: [],
  note: null,
};

export class AssetStore {
  readonly dir: string;
  readonly tmpDir: string;
  private col: JsonCollection<Asset>;

  constructor(private config: ServerConfig) {
    this.dir = path.join(config.dataDir, 'assets');
    this.tmpDir = path.join(config.dataDir, 'tmp');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.tmpDir, { recursive: true });
    this.col = new JsonCollection<Asset>(path.join(config.dataDir, 'assets.json'));
  }

  async load(): Promise<void> {
    await this.col.load();
    // Clean up temp files left by an interrupted session.
    for (const f of await fsp.readdir(this.tmpDir)) await fsp.rm(path.join(this.tmpDir, f), { recursive: true, force: true });
  }

  list(): Asset[] {
    return this.col.all().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Asset | undefined {
    return this.col.get(id);
  }

  assetDir(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new MediaError('Invalid asset id', 400);
    return path.join(this.dir, id);
  }

  filePath(asset: Asset): string {
    return path.join(this.assetDir(asset.id), asset.fileName);
  }

  thumbPath(asset: Asset): string {
    return path.join(this.assetDir(asset.id), 'thumb.jpg');
  }

  waveformPath(asset: Asset): string {
    return path.join(this.assetDir(asset.id), 'waveform.png');
  }

  tempFile(ext = ''): string {
    return path.join(this.tmpDir, `${newId('tmp')}${ext}`);
  }

  private limitFor(type: Asset['type']): number {
    return type === 'video' ? this.config.limits.maxVideoBytes : type === 'image' ? this.config.limits.maxImageBytes : this.config.limits.maxAudioBytes;
  }

  /**
   * Validate and import a file into the library. The source file is moved
   * (or removed on failure). Throws MediaError(400) for unsupported files.
   */
  async importFile(srcPath: string, originalName: string, opts: ImportOptions): Promise<Asset> {
    try {
      const sniff = await sniffFile(srcPath);
      if (!sniff) throw new MediaError(`Unsupported file type: ${originalName}. Supported: PNG, JPG, WebP images; MP4, MOV, WebM, MKV video; MP3, WAV, M4A, AAC, OGG, FLAC audio.`, 415);
      const stat = await fsp.stat(srcPath);
      const meta = await probe(srcPath).catch((e: Error) => {
        throw new MediaError(`File could not be decoded (${e.message}). It may be corrupt.`, 400);
      });
      let type: Asset['type'];
      if (sniff.family === 'image') type = 'image';
      else if (meta.video && meta.video.width > 0 && (meta.duration ?? 0) > 0 && !['mjpeg', 'png'].includes(meta.video.codec)) type = 'video';
      else if (meta.audio) type = 'audio';
      else throw new MediaError(`${originalName} contains no playable video or audio stream.`, 400);
      if (opts.allow && !opts.allow.includes(type)) throw new MediaError(`Expected ${opts.allow.join(' or ')}, got ${type}.`, 415);
      const limit = this.limitFor(type);
      if (stat.size > limit) throw new MediaError(`${originalName} is ${(stat.size / 1048576).toFixed(1)} MB; the ${type} limit is ${(limit / 1048576).toFixed(0)} MB.`, 413);
      if (type === 'image' && (!meta.video || meta.video.width < 16 || meta.video.height < 16)) throw new MediaError('Image is too small or unreadable.', 400);
      if (type === 'image' && meta.video && (meta.video.width > 12000 || meta.video.height > 12000)) throw new MediaError('Image dimensions exceed 12000px.', 400);

      const id = newId('ast');
      const dir = this.assetDir(id);
      await fsp.mkdir(dir, { recursive: true });
      const ext = type === 'audio' && sniff.ext === 'webm' ? 'webm' : sniff.ext;
      const fileName = `source.${ext}`;
      const dest = path.join(dir, fileName);
      await moveFile(srcPath, dest);
      const mime = type === 'audio' && sniff.mime.startsWith('video/') ? sniff.mime.replace('video/', 'audio/') : sniff.mime;
      const asset: Asset = {
        id,
        type,
        origin: opts.origin,
        name: sanitizeName(opts.name ?? originalName),
        fileName,
        mime,
        sizeBytes: stat.size,
        createdAt: new Date().toISOString(),
        duration: type === 'image' ? null : meta.duration,
        width: meta.video?.width ?? null,
        height: meta.video?.height ?? null,
        fps: type === 'video' ? meta.video?.fps ?? null : null,
        hasAudio: type !== 'image' && Boolean(meta.audio),
        hasThumbnail: false,
        hasWaveform: false,
        tags: (opts.tags ?? []).slice(0, 30),
        favorite: false,
        projectIds: opts.projectId ? [opts.projectId] : [],
        provenance: { ...DEFAULT_PROVENANCE, ...(opts.provenance ?? {}) },
      };
      await this.makePreviews(asset).catch((e) => log.warn(`Preview generation failed for ${id}`, e));
      await this.col.put(asset);
      return asset;
    } catch (err) {
      await fsp.rm(srcPath, { force: true });
      throw err;
    }
  }

  async importBuffer(data: Uint8Array, name: string, opts: ImportOptions): Promise<Asset> {
    const tmp = this.tempFile();
    await fsp.writeFile(tmp, data);
    return this.importFile(tmp, name, opts);
  }

  /** Download a remote result (e.g. a provider output URL) with size and time limits. */
  async importUrl(url: string, name: string, opts: ImportOptions & { headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal }): Promise<Asset> {
    if (!/^https?:\/\//i.test(url)) throw new MediaError('Only http(s) result URLs can be downloaded', 400);
    const tmp = this.tempFile();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10 * 60_000);
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetch(url, { headers: opts.headers, signal: ctrl.signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new MediaError(`Download failed: HTTP ${res.status}`, 502);
      const max = this.config.limits.maxVideoBytes;
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > max) throw new MediaError('Result file exceeds the size limit', 413);
      let received = 0;
      const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
      body.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > max) body.destroy(new MediaError('Result file exceeds the size limit', 413));
      });
      await pipeline(body, fs.createWriteStream(tmp));
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err instanceof MediaError ? err : new MediaError(`Download failed: ${(err as Error).message}`, 502);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
    return this.importFile(tmp, name, opts);
  }

  private async makePreviews(asset: Asset): Promise<void> {
    const src = this.filePath(asset);
    if (asset.type === 'video' || asset.type === 'image') {
      const at = asset.type === 'video' ? Math.min(1, (asset.duration ?? 0) / 3) : 0;
      const args = asset.type === 'video' ? ['-ss', String(at), '-i', src] : ['-i', src];
      await runFfmpeg([...args, '-frames:v', '1', '-vf', 'scale=480:-2:flags=bicubic', '-q:v', '4', this.thumbPath(asset)], { timeoutMs: 60_000 });
      asset.hasThumbnail = true;
    }
    if (asset.hasAudio) {
      await runFfmpeg(['-i', src, '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=1200x120:colors=0xb69cff', '-frames:v', '1', this.waveformPath(asset)], { timeoutMs: 120_000 });
      asset.hasWaveform = true;
    }
  }

  async update(id: string, patch: Partial<Pick<Asset, 'name' | 'tags' | 'favorite' | 'projectIds'>>): Promise<Asset | undefined> {
    return this.col.update(id, (a) => ({
      ...a,
      ...(patch.name !== undefined ? { name: sanitizeName(patch.name) } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags.map((t) => t.trim().slice(0, 40)).filter(Boolean).slice(0, 30) } : {}),
      ...(patch.favorite !== undefined ? { favorite: Boolean(patch.favorite) } : {}),
      ...(patch.projectIds !== undefined ? { projectIds: [...new Set(patch.projectIds)] } : {}),
    }));
  }

  async linkProject(id: string, projectId: string): Promise<void> {
    await this.col.update(id, (a) => (a.projectIds.includes(projectId) ? a : { ...a, projectIds: [...a.projectIds, projectId] }));
  }

  async remove(id: string): Promise<boolean> {
    const asset = this.col.get(id);
    if (!asset) return false;
    await this.col.remove(id);
    await fsp.rm(this.assetDir(id), { recursive: true, force: true });
    return true;
  }

  async totalBytes(filter?: (a: Asset) => boolean): Promise<number> {
    return this.col
      .all()
      .filter((a) => (filter ? filter(a) : true))
      .reduce((sum, a) => sum + a.sizeBytes, 0);
  }
}

export function sanitizeName(name: string): string {
  return name.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').trim().slice(0, 200) || 'Untitled';
}

async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fsp.copyFile(src, dest);
    await fsp.rm(src, { force: true });
  }
}
