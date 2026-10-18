/**
 * Local, non-AI providers.
 *
 * - `local-test`: renders clearly labelled FFmpeg test clips so the whole
 *   pipeline (jobs → assets → timeline → export) can be exercised without an
 *   AI service. Every frame carries a "NOT AI GENERATED" label and the asset
 *   provenance records aiGenerated=false.
 * - `local-tools`: real FFmpeg utilities (frame interpolation, upscaling,
 *   reframing, image enhancement, frame/audio extraction, scene detection).
 *   These are conventional signal processing, not machine learning.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { JobRecord, ModelInfo } from '../../shared/api.js';
import { dimensionsFor } from '../../shared/factory.js';
import { detectFfmpeg, filterPath, MediaError, probe, runFfmpeg } from '../media/ffmpeg.js';
import { params, pickAspect, pickDuration, promptOf } from './common.js';
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

function wrapLines(text: string, width: number, maxLines: number): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
      if (lines.length >= maxLines) break;
    } else line += ' ' + w;
  }
  if (lines.length < maxLines && line.trim()) lines.push(line.trim());
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,3}$/, '…');
  return lines.join('\n');
}

function fontOpt(): string {
  const ff = detectFfmpeg();
  return ff.fontFile ? `fontfile=${filterPath(ff.fontFile)}` : "font='Sans'";
}

async function labelFilter(workDir: string, name: string, text: string, size: number, y: string, opts = ''): Promise<string> {
  const file = path.join(workDir, `${name}.txt`);
  await fs.writeFile(file, text, 'utf8');
  return `drawtext=${fontOpt()}:textfile=${filterPath(file)}:expansion=none:fontsize=${size}:fontcolor=white:x=(w-text_w)/2:y=${y}:line_spacing=10${opts}`;
}

const LOCAL_TEST_MODELS: ModelInfo[] = [
  {
    id: 'local-test-render',
    providerId: 'local-test',
    name: 'Local test renderer (not AI)',
    tasks: ['text-to-video', 'image-to-video', 'video-to-video'],
    capabilities: {
      durations: { min: 1, max: 20, step: 1 },
      aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
      resolutions: ['720p', '1080p'],
      fps: [24, 30],
      negativePrompt: false,
      seed: false,
      maxVariations: 4,
      endFrame: false,
      maxReferenceImages: 0,
      camera: 'native',
      motionStrength: true,
      strength: true,
      imageInput: 'upload',
    },
    notes:
      'Generates labelled FFmpeg placeholder clips (text-to-video), Ken Burns motion on your image (image-to-video) or a filter restyle (video-to-video). No AI model is involved; output is marked "NOT AI GENERATED".',
  },
];

export const localTestProvider: Provider = {
  needsCredentials: false,
  info: {
    id: 'local-test',
    name: 'Local Test Renderer',
    description: 'FFmpeg-based placeholder clips for testing workflows offline. Not an AI model.',
    isAI: false,
    categories: ['video'],
    docsUrl: 'docs/PROVIDERS.md#local-test-renderer',
    credentialFields: [],
    supportsCancel: true,
    limitations: ['Does not generate AI imagery', 'Output is labelled "NOT AI GENERATED" on every frame'],
  },
  models: () => LOCAL_TEST_MODELS,
  async submit(job, model, ctx) {
    const p = params(job);
    const aspect = pickAspect(model, p.aspectRatio);
    const [w, h] = dimensionsFor(aspect, p.resolution === '1080p' ? '1080p' : '720p');
    const fps = p.fps === 24 ? 24 : 30;
    const duration = pickDuration(model, p.duration);
    const variation = Number((job.params as { variationIndex?: number }).variationIndex ?? 0);
    const prompt = promptOf(job);
    const cam = p.camera?.move ?? 'static';
    const out = (dir: string) => path.join(dir, 'out.mp4');
    const small = Math.round(Math.min(w, h) / 26);
    const portrait = h > w;
    const label = portrait ? '▲ LOCAL TEST RENDER\nNOT AI GENERATED' : '▲ LOCAL TEST RENDER · NOT AI GENERATED';
    const labelY = `h-text_h-${Math.round(small * 1.4)}`;

    if (job.task === 'text-to-video') {
      return startRun(job, ctx, async (run, dir) => {
        const hues = ['0x140c26', '0x0f1a2e', '0x1e0f1f', '0x10201a'];
        const c0 = hues[variation % hues.length];
        const c1 = ['0x5b34a8', '0x2f5aa8', '0xa8346f', '0x2fa87a'][variation % 4];
        const zoom = ['dollyIn', 'slowPushIn'].includes(cam) ? `,zoompan=z='min(zoom+0.0008,1.25)':d=1:s=${w}x${h}:fps=${fps}` : '';
        const filters = [
          `gradients=s=${w}x${h}:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=${w}:y1=${h}:speed=${0.004 + (p.motionIntensity ?? 0.5) * 0.03}:d=${duration}:r=${fps}`,
          `noise=alls=6:allf=t`,
          zoom.slice(1),
          await labelFilter(dir, 'prompt', wrapLines(prompt || '(empty prompt)', Math.max(16, Math.round(w / (small * 1.15 * 0.55))), 8), Math.round(small * 1.15), '(h-text_h)/2'),
          await labelFilter(dir, 'label', label, small, labelY, ':box=1:boxcolor=0x000000@0.55:boxborderw=8'),
          await labelFilter(dir, 'meta', `camera: ${cam} · ${duration}s · ${aspect}${variation ? ` · variation ${variation + 1}` : ''}`, Math.round(small * 0.8), `${small}`),
        ].filter(Boolean);
        await runFfmpeg(['-f', 'lavfi', '-i', filters[0], '-vf', filters.slice(1).join(','), '-t', String(duration), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', String(fps), out(dir)], {
          signal: run.ctrl.signal,
          durationHint: duration,
          onProgress: (f) => (run.progress = f),
        });
        return { status: 'succeeded', outputs: [{ kind: 'file', path: out(dir), name: 'test-render.mp4' }] };
      });
    }

    if (job.task === 'image-to-video') {
      if (!p.startImageAssetId) throw new ProviderError('Image-to-video needs a start image', 400);
      const src = ctx.assetPath(p.startImageAssetId);
      return startRun(job, ctx, async (run, dir) => {
        const frames = Math.round(duration * fps);
        const k = 0.15 + (p.motionIntensity ?? 0.5) * 0.25; // total zoom/pan amount
        let z = `1+${k}*on/${frames}`;
        let x = 'iw/2-(iw/zoom/2)';
        let y = 'ih/2-(ih/zoom/2)';
        if (['dollyOut', 'pullBackReveal'].includes(cam)) z = `${1 + k}-${k}*on/${frames}`;
        if (cam === 'panLeft' || cam === 'panRight') {
          z = `${1 + k}`;
          const from = cam === 'panRight' ? '0' : `(iw-iw/zoom)`;
          const to = cam === 'panRight' ? `(iw-iw/zoom)` : '0';
          x = `${from}+(${to}-${from})*on/${frames}`;
        }
        if (cam === 'tiltUp' || cam === 'tiltDown') {
          z = `${1 + k}`;
          const from = cam === 'tiltDown' ? '0' : `(ih-ih/zoom)`;
          const to = cam === 'tiltDown' ? `(ih-ih/zoom)` : '0';
          y = `${from}+(${to}-${from})*on/${frames}`;
        }
        if (cam === 'static') z = '1';
        const vf = [
          // Upscale first so zoompan has detail to work with, cropping to fill the target aspect.
          `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,crop=${w * 2}:${h * 2}`,
          `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${w}x${h}:fps=${fps}`,
          await labelFilter(dir, 'label', portrait ? '▲ LOCAL MOTION (KEN BURNS)\nNOT AI GENERATED' : '▲ LOCAL MOTION (KEN BURNS) · NOT AI GENERATED', small, labelY, ':box=1:boxcolor=0x000000@0.55:boxborderw=8'),
        ];
        await runFfmpeg(['-loop', '1', '-i', src, '-vf', vf.join(','), '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', out(dir)], {
          signal: run.ctrl.signal,
          durationHint: duration,
          onProgress: (f) => (run.progress = f),
        });
        return { status: 'succeeded', outputs: [{ kind: 'file', path: out(dir), name: 'local-motion.mp4' }] };
      });
    }

    if (job.task === 'video-to-video') {
      if (!p.sourceVideoAssetId) throw new ProviderError('Video-to-video needs a source video', 400);
      const src = ctx.assetPath(p.sourceVideoAssetId);
      const meta = await probe(src);
      const srcDur = Math.min(meta.duration ?? duration, 60);
      return startRun(job, ctx, async (run, dir) => {
        const s = Math.min(1, Math.max(0, p.strength ?? 0.5));
        const style = /noir|black.?and.?white|monochrome/i.test(prompt)
          ? `hue=s=0,eq=contrast=${1 + s * 0.6}`
          : /comic|cartoon|anime|toon/i.test(prompt)
            ? `edgedetect=mode=colormix:high=${0.3 - s * 0.2}:low=0.05`
            : /vintage|retro|film/i.test(prompt)
              ? `curves=preset=vintage,noise=alls=${Math.round(10 + s * 20)}:allf=t`
              : `hue=h=${Math.round(s * 120)},eq=saturation=${1 + s}`;
        const vf = [
          `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
          style,
          await labelFilter(dir, 'label', portrait ? '▲ LOCAL FILTER RESTYLE\nNOT AI GENERATED' : '▲ LOCAL FILTER RESTYLE · NOT AI GENERATED', small, labelY, ':box=1:boxcolor=0x000000@0.55:boxborderw=8'),
        ];
        const args = ['-i', src, '-t', String(srcDur), '-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
        args.push(...(meta.audio ? ['-c:a', 'aac'] : ['-an']), out(dir));
        await runFfmpeg(args, { signal: run.ctrl.signal, durationHint: srcDur, onProgress: (f) => (run.progress = f) });
        return { status: 'succeeded', outputs: [{ kind: 'file', path: out(dir), name: 'local-restyle.mp4' }] };
      });
    }
    throw new ProviderError(`Local test renderer does not support ${job.task}`, 400);
  },
  async poll(job) {
    return pollRun(job);
  },
  async cancel(job) {
    await cleanup(job);
  },
};

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
