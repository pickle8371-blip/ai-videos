/**
 * Local AI engine: open-weight video diffusion models running on this machine.
 *
 * The Python engine (engine/voidcraft_engine.py) does the inference with
 * PyTorch + diffusers. This module locates it, reports its status, manages
 * model downloads, queues generations (one at a time — they need the whole
 * GPU) and encodes the frames it produces into MP4 with FFmpeg.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { JobRecord, ModelInfo } from '../../shared/api.js';
import type { AspectRatio } from '../../shared/project.js';
import type { ServerConfig } from '../config.js';
import { log } from '../logger.js';
import { runFfmpeg } from '../media/ffmpeg.js';
import { params, promptOf } from './common.js';
import type { PollResult, Provider, ProviderContext } from './types.js';
import { ProviderError } from './types.js';

export interface EngineModel {
  id: string;
  name: string;
  pipeline: string;
  tasks: Array<'text-to-video' | 'image-to-video' | 'video-to-video'>;
  repos: Array<{ repo: string; allow?: string[] }>;
  diskGB: number;
  minVramGB: number;
  fullVramGB: number;
  fps: number;
  frameRule: { fixed?: number; multiple?: number; offset?: number; max?: number };
  durations: number[];
  sizes: Partial<Record<AspectRatio, [number, number]>>;
  steps: { fast: number; standard: number; high: number };
  guidance: number;
  negativePrompt: boolean;
  license: string;
  notes: string;
  test?: boolean;
}

export type EngineState = 'checking' | 'no-python' | 'not-installed' | 'ready' | 'error';

export interface EngineStatus {
  state: EngineState;
  message: string;
  python: string | null;
  systemPython: string | null;
  torch: string | null;
  diffusers: string | null;
  device: 'cuda' | 'mps' | 'cpu' | null;
  gpu: string | null;
  vramGB: number | null;
  cpuThreads: number | null;
  installed: Record<string, boolean>;
  engineDir: string;
  modelsDir: string;
  checkedAt: string | null;
}

/** Tiny random-weight models used only by automated tests (see engine/tiny_models.py). */
const TEST_MODELS: EngineModel[] = [
  { id: 'test-tiny-wan', name: 'Tiny Wan (test)', pipeline: 'wan', tasks: ['text-to-video'], fps: 16, frameRule: { multiple: 4, offset: 1, max: 9 }, durations: [1], sizes: { '16:9': [32, 16], '9:16': [16, 32], '1:1': [16, 16] } },
  { id: 'test-tiny-ltx', name: 'Tiny LTX (test)', pipeline: 'ltx', tasks: ['text-to-video', 'image-to-video'], fps: 24, frameRule: { multiple: 8, offset: 1, max: 9 }, durations: [1], sizes: { '16:9': [64, 32], '9:16': [32, 64], '1:1': [32, 32] } },
  { id: 'test-tiny-cogvideox', name: 'Tiny CogVideoX (test)', pipeline: 'cogvideox', tasks: ['text-to-video'], fps: 8, frameRule: { fixed: 9 }, durations: [1], sizes: { '16:9': [16, 16] } },
  { id: 'test-tiny-animatediff', name: 'Tiny AnimateDiff (test)', pipeline: 'animatediff', tasks: ['text-to-video', 'video-to-video'], fps: 8, frameRule: { fixed: 8 }, durations: [1], sizes: { '16:9': [64, 64] } },
].map((m) => ({ ...m, repos: [], diskGB: 0, minVramGB: 0, fullVramGB: 0, steps: { fast: 2, standard: 2, high: 3 }, guidance: 3, negativePrompt: true, license: 'test', notes: 'Random weights — automated tests only.', test: true }) as unknown as EngineModel);

type EngineEvent = { type: string; [k: string]: unknown };

const IS_WIN = process.platform === 'win32';

export class LocalEngine {
  readonly engineDir: string;
  readonly modelsDir: string;
  readonly catalog: EngineModel[];
  status: EngineStatus;
  private queue: Promise<unknown> = Promise.resolve();
  private refreshing: Promise<EngineStatus> | null = null;

  constructor(private config: ServerConfig) {
    this.engineDir = path.resolve(process.env.VOIDCRAFT_ENGINE_DIR ?? path.join(process.cwd(), 'engine'));
    this.modelsDir = path.join(config.dataDir, 'models');
    const file = path.join(this.engineDir, 'models.json');
    const models: EngineModel[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).models : [];
    this.catalog = process.env.VOIDCRAFT_ENGINE_TEST === '1' ? [...models, ...TEST_MODELS] : models;
    this.status = this.blankStatus('checking', 'Checking the local AI engine…');
  }

  private blankStatus(state: EngineState, message: string): EngineStatus {
    return { state, message, python: this.venvPython(), systemPython: null, torch: null, diffusers: null, device: null, gpu: null, vramGB: null, cpuThreads: null, installed: {}, engineDir: this.engineDir, modelsDir: this.modelsDir, checkedAt: null };
  }

  /** Python inside engine/.venv (or VOIDCRAFT_PYTHON). */
  venvPython(): string | null {
    if (process.env.VOIDCRAFT_PYTHON) return process.env.VOIDCRAFT_PYTHON;
    const p = IS_WIN ? path.join(this.engineDir, '.venv', 'Scripts', 'python.exe') : path.join(this.engineDir, '.venv', 'bin', 'python');
    return fs.existsSync(p) ? p : null;
  }

  /** A system Python able to create the engine's virtual environment. Async so the server never blocks on it. */
  async systemPython(): Promise<{ cmd: string; args: string[]; label: string } | null> {
    const candidates: Array<{ cmd: string; args: string[] }> = [];
    if (process.env.VOIDCRAFT_SYSTEM_PYTHON) candidates.push({ cmd: process.env.VOIDCRAFT_SYSTEM_PYTHON, args: [] });
    if (IS_WIN) candidates.push({ cmd: 'py', args: ['-3.12'] }, { cmd: 'py', args: ['-3.11'] }, { cmd: 'py', args: ['-3.10'] }, { cmd: 'py', args: ['-3'] }, { cmd: 'python', args: [] });
    else candidates.push({ cmd: 'python3.12', args: [] }, { cmd: 'python3.11', args: [] }, { cmd: 'python3', args: [] }, { cmd: 'python', args: [] });
    for (const c of candidates) {
      const v = await probePython(c.cmd, c.args);
      if (v && /^3\.(9|1[0-9])\./.test(v)) return { ...c, label: `${[c.cmd, ...c.args].join(' ')} (Python ${v})` };
    }
    return null;
  }

  env(): NodeJS.ProcessEnv {
    return { ...process.env, HF_HOME: this.modelsDir, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false' };
  }

  /** Run an engine command, streaming JSON events. Resolves with the final result event. */
  run(args: string[], opts: { signal?: AbortSignal; onEvent?: (e: EngineEvent) => void; offline?: boolean; timeoutMs?: number } = {}): Promise<EngineEvent> {
    const py = this.venvPython();
    if (!py) return Promise.reject(new ProviderError('The local AI engine is not installed yet. Open Settings → Local AI and click “Install engine”.', 400));
    return new Promise((resolve, reject) => {
      const env = this.env();
      if (opts.offline) {
        // Generation never touches the network once weights are downloaded.
        env.HF_HUB_OFFLINE = '1';
        env.TRANSFORMERS_OFFLINE = '1';
      }
      const child: ChildProcess = spawn(py, [path.join(this.engineDir, 'voidcraft_engine.py'), ...args], { cwd: this.engineDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let last: EngineEvent | null = null;
      let error: string | null = null;
      let stderr = '';
      let buf = '';
      const onAbort = () => child.kill(IS_WIN ? undefined : 'SIGKILL');
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      let timedOut = false;
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            onAbort();
          }, opts.timeoutMs)
        : null;
      child.stdout!.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('{')) continue;
          try {
            const ev = JSON.parse(line) as EngineEvent;
            if (ev.type === 'error') error = String(ev.message ?? 'Engine error');
            else if (ev.type === 'result' || ev.type === 'doctor') last = ev;
            opts.onEvent?.(ev);
          } catch {
            /* non-JSON output from libraries */
          }
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-20_000);
      });
      child.on('error', (err) => reject(new ProviderError(`Could not start the engine (${py}): ${err.message}`, 500)));
      child.on('close', (code) => {
        opts.signal?.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
        if (timedOut) return reject(new ProviderError(`The engine did not answer within ${Math.round(opts.timeoutMs! / 1000)} s`, 504));
        if (opts.signal?.aborted) return reject(new ProviderError('Canceled', 499));
        if (code === 0 && last) return resolve(last);
        const tail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(' | ');
        reject(new ProviderError(error ?? (tail ? `Engine failed: ${tail}` : `Engine exited with code ${code}`), 500));
      });
    });
  }

  /** Queue GPU work so only one generation runs at a time. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async refresh(): Promise<EngineStatus> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const sys = await this.systemPython();
      const py = this.venvPython();
      if (!py) {
        this.status = {
          ...this.blankStatus(sys ? 'not-installed' : 'no-python', sys ? 'The local AI engine is not installed. Click “Install engine” (downloads PyTorch and diffusers, ~3-5 GB).' : 'Python 3.10-3.12 was not found. Install it (Windows: winget install Python.Python.3.12), then click “Install engine”.'),
          systemPython: sys?.label ?? null,
          checkedAt: new Date().toISOString(),
        };
        return this.status;
      }
      try {
        const d = await this.run(['doctor'], { timeoutMs: 180_000 });
        const ready = d.engine === true;
        this.status = {
          state: ready ? 'ready' : 'not-installed',
          message: ready ? `Ready on ${d.device === 'cuda' ? `${d.gpu} (${d.vramGB} GB)` : d.device === 'mps' ? 'Apple GPU (MPS)' : 'CPU — generation will be slow'}` : String(d.error ?? 'Engine incomplete — run “Install engine” again.'),
          python: py,
          systemPython: sys?.label ?? null,
          torch: (d.torch as string) ?? null,
          diffusers: (d.diffusers as string) ?? null,
          device: (d.device as EngineStatus['device']) ?? null,
          gpu: (d.gpu as string) ?? null,
          vramGB: (d.vramGB as number) ?? null,
          cpuThreads: (d.cpuThreads as number) ?? null,
          installed: (d.installed as Record<string, boolean>) ?? {},
          engineDir: this.engineDir,
          modelsDir: this.modelsDir,
          checkedAt: new Date().toISOString(),
        };
        for (const m of this.catalog) if (m.test) this.status.installed[m.id] = ready;
      } catch (err) {
        this.status = { ...this.blankStatus('error', `Engine check failed: ${(err as Error).message}. Try “Install engine” again.`), systemPython: sys?.label ?? null, checkedAt: new Date().toISOString() };
      }
      return this.status;
    })().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /** The model that best fits this machine. */
  recommended(): string | null {
    const s = this.status;
    const usable = this.catalog.filter((m) => !m.test);
    if (s.device === 'cuda' && s.vramGB) {
      if (s.vramGB >= 8) return 'wan2.1-t2v-1.3b';
      if (s.vramGB >= 4) return 'cogvideox-2b';
      return 'animatediff-lightning';
    }
    if (s.device === 'mps') return 'animatediff-lightning';
    return usable.find((m) => m.id === 'animatediff-lightning')?.id ?? usable[0]?.id ?? null;
  }

  estimate(m: EngineModel): string {
    const s = this.status;
    if (m.test) return 'seconds';
    if (s.device === 'cuda') {
      if ((s.vramGB ?? 0) < m.minVramGB) return `needs ~${m.minVramGB} GB VRAM; your GPU has ${s.vramGB} GB — may fail or be very slow`;
      return m.pipeline === 'animatediff' ? 'about 10-30 seconds' : 'several minutes per clip';
    }
    if (s.device === 'mps') return m.pipeline === 'animatediff' ? 'about 1 minute' : 'tens of minutes per clip';
    return m.pipeline === 'animatediff' ? 'a few minutes per clip on CPU' : 'hours per clip on CPU — use a GPU';
  }
}

/* ------------------------------------------------------------------ provider */

interface Run {
  ctrl: AbortController;
  progress: number | null;
  message: string | null;
  result: PollResult | null;
}

const runs = new Map<string, Run>();

function toModelInfo(engine: LocalEngine, m: EngineModel): ModelInfo {
  const installed = engine.status.state === 'ready' && engine.status.installed[m.id] === true;
  const reason =
    engine.status.state !== 'ready'
      ? 'Install the local AI engine first (Settings → Local AI).'
      : !installed
        ? `Download this model first (Settings → Local AI, ~${m.diskGB} GB).`
        : undefined;
  const heights = [...new Set(Object.values(m.sizes).map((s) => Math.min(s![0], s![1])))];
  return {
    id: m.id,
    providerId: 'local-ai',
    name: m.name,
    tasks: m.tasks,
    capabilities: {
      durations: m.durations,
      aspectRatios: Object.keys(m.sizes) as AspectRatio[],
      resolutions: heights.map((h) => `${h}p`),
      fps: [m.fps],
      negativePrompt: m.negativePrompt,
      seed: true,
      maxVariations: 4,
      camera: 'prompt',
      imageInput: 'upload',
      qualityPresets: true,
      strength: m.tasks.includes('video-to-video'),
    },
    notes: `${m.notes} ${installed ? `Estimated time here: ${engine.estimate(m)}.` : ''}`.trim(),
    available: !reason,
    unavailableReason: reason,
    local: { installed, diskGB: m.diskGB, minVramGB: m.minVramGB, license: m.license, recommended: engine.recommended() === m.id, test: Boolean(m.test) },
  };
}

export function createLocalAiProvider(engine: LocalEngine): Provider {
  return {
    needsCredentials: false,
    available: () => engine.status.state === 'ready',
    info: {
      id: 'local-ai',
      name: 'Voidcraft Local AI',
      description: 'Open-source video diffusion models running on your own computer. No API keys, no cloud, works offline after the one-time model download.',
      isAI: true,
      categories: ['video'],
      docsUrl: 'docs/LOCAL_AI.md',
      credentialFields: [],
      supportsCancel: true,
      limitations: [
        'Needs an NVIDIA GPU with 8 GB+ VRAM for Wan 2.1 / LTX-Video; CogVideoX 2B works on 4-6 GB; AnimateDiff Lightning runs on CPU (slowly).',
        'Each model is a one-time download of 6-30 GB from Hugging Face.',
        'Clips are short (2-6 s) and 480-720p — the limits of current open models on consumer hardware.',
      ],
    },
    models: () => engine.catalog.map((m) => toModelInfo(engine, m)),
    async testConnection() {
      const s = await engine.refresh();
      return { ok: s.state === 'ready', message: s.message };
    },
    async submit(job, model, ctx) {
      const m = engine.catalog.find((x) => x.id === model.id);
      if (!m) throw new ProviderError(`Unknown local model ${model.id}`, 404);
      const info = toModelInfo(engine, m);
      if (!info.available) throw new ProviderError(info.unavailableReason!, 400);
      const p = params(job);
      if (job.task === 'image-to-video' && !p.startImageAssetId) throw new ProviderError('Choose a start image', 400);
      if (job.task === 'video-to-video' && !p.sourceVideoAssetId) throw new ProviderError('Choose source footage', 400);
      const workDir = path.join(ctx.assets.tmpDir, `localai_${job.id}`);
      const run: Run = { ctrl: new AbortController(), progress: 0, message: 'Waiting for the GPU (one generation at a time)', result: null };
      runs.set(job.id, run);
      void (async () => {
        try {
          await fsp.mkdir(workDir, { recursive: true });
          const aspect = (m.sizes[p.aspectRatio ?? '16:9'] ? p.aspectRatio ?? '16:9' : Object.keys(m.sizes)[0]) as AspectRatio;
          let videoFrames: string[] | null = null;
          if (job.task === 'video-to-video') {
            // Sample the source at the model's frame rate and size; the engine restyles these frames.
            const [w, h] = m.sizes[aspect]!;
            const srcDir = path.join(workDir, 'source');
            await fsp.mkdir(srcDir, { recursive: true });
            const count = m.frameRule.fixed ?? 16;
            await runFfmpeg(['-i', ctx.assetPath(p.sourceVideoAssetId!), '-vf', `fps=${m.fps},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`, '-frames:v', String(count), path.join(srcDir, 'src_%05d.png')], { signal: run.ctrl.signal });
            videoFrames = (await fsp.readdir(srcDir)).filter((f) => f.endsWith('.png')).sort().map((f) => path.join(srcDir, f));
            if (!videoFrames.length) throw new ProviderError('Could not read frames from the source video', 400);
          }
          const request = {
            model: m.id,
            task: job.task,
            prompt: promptOf(job),
            negativePrompt: p.negativePrompt ?? '',
            duration: p.duration ?? m.durations[m.durations.length - 1],
            aspectRatio: aspect,
            strength: p.strength ?? 0.6,
            videoFrames,
            quality: (job.params as { quality?: string }).quality ?? 'standard',
            seed: typeof p.seed === 'number' ? p.seed : null,
            image: job.task === 'image-to-video' ? ctx.assetPath(p.startImageAssetId!) : null,
            outDir: path.join(workDir, 'frames'),
          };
          const reqFile = path.join(workDir, 'request.json');
          await fsp.writeFile(reqFile, JSON.stringify(request), 'utf8');
          const result = await engine.exclusive(() => {
            if (run.ctrl.signal.aborted) throw new ProviderError('Canceled', 499);
            run.message = 'Starting the engine';
            return engine.run(['generate', '--request', reqFile], {
              signal: run.ctrl.signal,
              offline: !m.test,
              onEvent: (ev) => {
                if (ev.type === 'status') run.message = String(ev.message);
                if (ev.type === 'progress') {
                  run.progress = typeof ev.fraction === 'number' ? ev.fraction : run.progress;
                  const eta = typeof ev.etaSeconds === 'number' ? ` · about ${formatEta(ev.etaSeconds)} left` : '';
                  run.message = `Step ${ev.step}/${ev.total}${eta}`;
                }
              },
            });
          });
          run.message = 'Encoding video';
          run.progress = 0.98;
          const out = path.join(workDir, 'out.mp4');
          const fps = Number(result.fps ?? m.fps);
          await runFfmpeg(['-framerate', String(fps), '-i', path.join(request.outDir, 'frame_%05d.png'), '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { signal: run.ctrl.signal });
          run.result = {
            status: 'succeeded',
            outputs: [{ kind: 'file', path: out, name: `${m.id}.mp4` }],
            result: { seed: result.seed, seconds: result.seconds, mode: result.mode, width: result.width, height: result.height, frames: result.frames },
          };
        } catch (err) {
          run.result = run.ctrl.signal.aborted ? { status: 'canceled' } : { status: 'failed', error: (err as Error).message };
        } finally {
          for (const d of ['frames', 'source']) await fsp.rm(path.join(workDir, d), { recursive: true, force: true }).catch(() => undefined);
        }
      })();
      return { providerJobId: `local-ai:${job.id}`, state: { workDir } };
    },
    async poll(job: JobRecord): Promise<PollResult> {
      const run = runs.get(job.id);
      if (!run) return { status: 'failed', error: 'The generation was interrupted (the server restarted). Retry the job.' };
      if (run.result) {
        runs.delete(job.id);
        return run.result;
      }
      return { status: 'running', progress: run.progress, message: run.message };
    },
    async cancel(job) {
      runs.get(job.id)?.ctrl.abort();
    },
  };
}

/** Python version printed by `cmd`, or null if it is missing, broken or hangs (e.g. the Windows Store alias). */
function probePython(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let child: ChildProcess;
    try {
      child = spawn(cmd, [...args, '-c', 'import sys, venv; print(sys.version.split()[0])'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout!.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim() || null : null);
    });
  });
}

function formatEta(s: number): string {
  if (s < 90) return `${Math.max(1, Math.round(s))} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

/** Long-running engine maintenance commands (setup, download) as plain processes with line output. */
export async function runSetup(engine: LocalEngine, opts: { cpu?: boolean; signal: AbortSignal; onLine: (line: string) => void }): Promise<void> {
  const sys = await engine.systemPython();
  if (!sys) throw new ProviderError('Python 3.10-3.12 was not found. Install it first (Windows: “winget install Python.Python.3.12”, or python.org — tick “Add python.exe to PATH”), then try again.', 400);
  return new Promise<void>((resolve, reject) => {
    const args = [...sys.args, path.join(engine.engineDir, 'setup_engine.py'), ...(opts.cpu ? ['--cpu'] : [])];
    log.info(`Engine setup: ${sys.cmd} ${args.join(' ')}`);
    const child = spawn(sys.cmd, args, { cwd: engine.engineDir, env: { ...engine.env(), PIP_DISABLE_PIP_VERSION_CHECK: '1' }, windowsHide: true });
    let tail: string[] = [];
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail = [...tail.slice(-30), line];
        opts.onLine(line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const onAbort = () => child.kill();
    opts.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => reject(new ProviderError(`Could not run Python: ${err.message}`, 500)));
    child.on('close', (code) => {
      opts.signal.removeEventListener('abort', onAbort);
      if (opts.signal.aborted) return reject(new ProviderError('Canceled', 499));
      if (code === 0) resolve();
      else reject(new ProviderError(`Engine installation failed: ${tail.filter((l) => /error|fail|not found|could not/i.test(l)).slice(-3).join(' | ') || tail.slice(-3).join(' | ')}`, 500));
    });
  });
}
