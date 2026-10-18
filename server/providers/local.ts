/**
 * `local-tools`: FFmpeg utilities (frame interpolation, upscaling, reframing,
 * image enhancement, frame/audio extraction, scene detection). These are
 * conventional signal processing, not machine learning.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { JobRecord, ModelInfo } from '../../shared/api.js';
import { detectFfmpeg, MediaError, runFfmpeg } from '../media/ffmpeg.js';
import type { PollResult, Provider, ProviderContext, SubmitResult } from './types.js';
import { ProviderError } from './types.js';
import { spawn } from 'node:child_process';

interface LocalRun {
  ctrl: AbortController;
  progress: number;
  result: PollResult | null;
}

/** In-process runs keyed by job id. Lost on restart; poll then reports an interruption. */
const runs = new Map<string, LocalRun>();

function startRun(job: JobRecord, ctx: ProviderContext, work: (run: LocalRun, workDir: string) => Promise<PollResult>): SubmitResult {
  const run: LocalRun = { ctrl: new AbortController(), progress: 0, result: null };
  runs.set(job.id, run);
  const workDir = path.join(ctx.assets.tmpDir, `local_${job.id}`);
  (async () => {
    await fs.mkdir(workDir, { recursive: true });
    try {
      run.result = await work(run, workDir);
    } catch (err) {
      run.result = run.ctrl.signal.aborted ? { status: 'canceled' } : { status: 'failed', error: (err as Error).message };
    }
  })();
  return { providerJobId: `local:${job.id}`, state: { workDir } };
}

function pollRun(job: JobRecord): PollResult {
  const run = runs.get(job.id);
  if (!run) return { status: 'failed', error: 'The local render was interrupted (server restarted). Retry the job.' };
  if (run.result) {
    runs.delete(job.id);
    return run.result;
  }
  return { status: 'running', progress: run.progress };
}

async function cleanup(job: JobRecord): Promise<void> {
  runs.get(job.id)?.ctrl.abort();
}

/* ------------------------------------------------------------- local tools */

export const LOCAL_TOOL_MODELS: ModelInfo[] = [
  { id: 'interpolate', name: 'Frame interpolation (motion-compensated)', tasks: ['tool'], capabilities: {}, notes: 'FFmpeg minterpolate. Raises frame rate by synthesising in-between frames with motion estimation. Not AI.' },
  { id: 'upscale', name: 'Upscale (Lanczos + sharpen)', tasks: ['tool'], capabilities: {}, notes: 'Conventional resampling. Does not invent detail like AI super-resolution.' },
  { id: 'reframe', name: 'Aspect-ratio reframe', tasks: ['tool'], capabilities: {}, notes: 'Crops to a new aspect ratio around a horizontal/vertical focus point.' },
  { id: 'enhance-image', name: 'Image enhance (denoise + sharpen + tone)', tasks: ['tool'], capabilities: {}, notes: 'hqdn3d denoise, unsharp mask and mild contrast. Not AI.' },
  { id: 'extract-frame', name: 'Extract frame as image', tasks: ['tool'], capabilities: {}, notes: 'Saves a still from a video at a given time.' },
  { id: 'extract-audio', name: 'Extract audio track', tasks: ['tool'], capabilities: {}, notes: 'Saves the audio of a video as an audio asset.' },
  { id: 'scene-detect', name: 'Scene cut detection', tasks: ['tool'], capabilities: {}, notes: 'Finds hard cuts using FFmpeg scene scores; used for automatic clip organisation.' },
].map((m) => ({ ...m, providerId: 'local-tools' }) as ModelInfo);

function sceneDetect(file: string, threshold: number, signal: AbortSignal): Promise<number[]> {
  const ff = detectFfmpeg();
  if (!ff.ffmpeg) return Promise.reject(new MediaError('FFmpeg unavailable', 503));
  return new Promise((resolve, reject) => {
    const child = spawn(ff.ffmpeg!, ['-hide_banner', '-nostdin', '-i', file, '-an', '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'], { windowsHide: true });
    let stderr = '';
    const onAbort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', onAbort, { once: true });
    child.stderr.on('data', (b) => (stderr += b));
    child.on('error', reject);
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) return reject(new Error('Canceled'));
      if (code !== 0) return reject(new MediaError('Scene detection failed'));
      const cuts = [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 0.2);
      resolve(cuts);
    });
  });
}

export const localToolsProvider: Provider = {
  needsCredentials: false,
  info: {
    id: 'local-tools',
    name: 'Local FFmpeg Tools',
    description: 'Conventional (non-AI) video/image utilities executed locally with FFmpeg.',
    isAI: false,
    categories: ['tools'],
    docsUrl: 'docs/PROVIDERS.md#local-ffmpeg-tools',
    credentialFields: [],
    supportsCancel: true,
    limitations: ['Signal processing only — no learned models', 'AI upscaling, background/object removal need a connected model (see docs)'],
  },
  models: () => LOCAL_TOOL_MODELS,
  async submit(job, model, ctx) {
    const p = job.params as Record<string, unknown>;
    const srcId = String(p.sourceAssetId ?? '');
    const asset = ctx.assets.get(srcId);
    if (!asset) throw new ProviderError('Source asset not found', 400);
    const src = ctx.assetPath(srcId);
    const dur = asset.duration ?? 1;
    const needVideo = ['interpolate', 'upscale', 'reframe', 'extract-frame', 'extract-audio', 'scene-detect'];
    if (needVideo.includes(model.id) && asset.type !== 'video' && !(model.id === 'upscale' || model.id === 'reframe') ) throw new ProviderError(`${model.name} needs a video`, 400);
    if (model.id === 'enhance-image' && asset.type !== 'image') throw new ProviderError('Image enhance needs an image', 400);
    if (model.id === 'extract-audio' && !asset.hasAudio) throw new ProviderError('This video has no audio track', 400);
    if ((model.id === 'upscale' || model.id === 'reframe') && asset.type === 'audio') throw new ProviderError(`${model.name} needs a video or image`, 400);

    return startRun(job, ctx, async (run, dir) => {
      const prog = { signal: run.ctrl.signal, durationHint: dur, onProgress: (f: number) => (run.progress = f) };
      const isImage = asset.type === 'image';
      const outExt = isImage ? 'png' : 'mp4';
      const out = path.join(dir, `out.${outExt}`);
      const audioArgs = asset.hasAudio ? ['-c:a', 'aac'] : ['-an'];
      const vEnc = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'];
      switch (model.id) {
        case 'interpolate': {
          const fps = Math.min(120, Math.max(24, Number(p.targetFps ?? 60)));
          await runFfmpeg(['-i', src, '-vf', `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`, ...vEnc, ...audioArgs, out], prog);
          return { status: 'succeeded', outputs: [{ kind: 'file', path: out, name: `${asset.name} (${fps}fps).mp4` }] };
        }
        case 'upscale': {
          const factor = Math.min(4, Math.max(1.25, Number(p.factor ?? 2)));
          const w = Math.min(7680, Math.round(((asset.width ?? 640) * factor) / 2) * 2);
          const h = Math.min(4320, Math.round(((asset.height ?? 360) * factor) / 2) * 2);
          const vf = `scale=${w}:${h}:flags=lanczos,unsharp=5:5:0.6:5:5:0`;
          await runFfmpeg(isImage ? ['-i', src, '-vf', vf, out] : ['-i', src, '-vf', vf, ...vEnc, ...audioArgs, out], prog);
          return { status: 'succeeded', outputs: [{ kind: 'file', path: out, name: `${asset.name} (${w}x${h}).${outExt}` }] };
        }
        case 'reframe': {
          const ratio = String(p.aspectRatio ?? '9:16');
          const [rw, rh] = ratio.split(':').map(Number);
          if (!rw || !rh) throw new ProviderError('Invalid aspect ratio', 400);
          const fx = Math.min(1, Math.max(0, Number(p.focusX ?? 0.5)));
          const fy = Math.min(1, Math.max(0, Number(p.focusY ?? 0.5)));
          const crop = `crop='trunc(min(iw,ih*${rw}/${rh})/2)*2':'trunc(min(ih,iw*${rh}/${rw})/2)*2':'(iw-ow)*${fx}':'(ih-oh)*${fy}'`;
          await runFfmpeg(isImage ? ['-i', src, '-vf', crop, out] : ['-i', src, '-vf', crop, ...vEnc, ...audioArgs, out], prog);
          return { status: 'succeeded', outputs: [{ kind: 'file', path: out, name: `${asset.name} (${ratio.replace(':', 'x')}).${outExt}` }] };
        }
        case 'enhance-image': {
          await runFfmpeg(['-i', src, '-vf', 'hqdn3d=2:1:3:3,unsharp=5:5:0.8:5:5:0,eq=contrast=1.06:saturation=1.08', out], prog);
          return { status: 'succeeded', outputs: [{ kind: 'file', path: out, name: `${asset.name} (enhanced).png` }] };
        }
        case 'extract-frame': {
          const t = Math.min(Math.max(0, Number(p.time ?? 0)), Math.max(0, dur - 0.05));
          const img = path.join(dir, 'frame.png');
          await runFfmpeg(['-ss', String(t), '-i', src, '-frames:v', '1', img], prog);
          return { status: 'succeeded', outputs: [{ kind: 'file', path: img, name: `${asset.name} @ ${t.toFixed(2)}s.png` }] };
        }
        case 'extract-audio': {
          const a = path.join(dir, 'audio.m4a');
          await runFfmpeg(['-i', src, '-vn', '-c:a', 'aac', '-b:a', '192k', a], prog);
          return { status: 'succeeded', outputs: [{ kind: 'file', path: a, name: `${asset.name} (audio).m4a` }] };
        }
        case 'scene-detect': {
          const threshold = Math.min(0.9, Math.max(0.1, Number(p.threshold ?? 0.35)));
          const cuts = await sceneDetect(src, threshold, run.ctrl.signal);
          return { status: 'succeeded', outputs: [], result: { cuts, duration: dur, sourceAssetId: srcId } };
        }
      }
      throw new ProviderError(`Unknown tool ${model.id}`, 400);
    });
  },
  async poll(job) {
    return pollRun(job);
  },
  async cancel(job) {
    await cleanup(job);
  },
};
