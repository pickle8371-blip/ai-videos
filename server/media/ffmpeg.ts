import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger.js';

export interface FfmpegInfo {
  available: boolean;
  ffmpeg: string | null;
  ffprobe: string | null;
  version: string | null;
  drawtext: boolean;
  fontFile: string | null;
  error: string | null;
}

let cached: FfmpegInfo | null = null;

function tryBinary(bin: string): string | null {
  try {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    if (r.status === 0 && r.stdout) return r.stdout.split('\n')[0].trim();
  } catch {
    /* not found */
  }
  return null;
}

function candidateBinaries(name: 'ffmpeg' | 'ffprobe', explicit: string | null): string[] {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const list: string[] = [];
  if (explicit) list.push(explicit);
  list.push(exe);
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    list.push(
      path.join('C:\\', 'ffmpeg', 'bin', exe),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin', exe),
      ...(local ? [path.join(local, 'Microsoft', 'WinGet', 'Links', exe)] : []),
    );
  } else {
    list.push(`/usr/bin/${name}`, `/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`);
  }
  return list;
}

const FONT_CANDIDATES = [
  // Linux
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  // macOS
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial.ttf',
  // Windows
  'C:\\Windows\\Fonts\\segoeui.ttf',
  'C:\\Windows\\Fonts\\arial.ttf',
];

export function detectFfmpeg(explicitFfmpeg: string | null = null, explicitFfprobe: string | null = null, force = false): FfmpegInfo {
  if (cached && !force) return cached;
  let ffmpeg: string | null = null;
  let version: string | null = null;
  for (const c of candidateBinaries('ffmpeg', explicitFfmpeg)) {
    const v = tryBinary(c);
    if (v) {
      ffmpeg = c;
      version = v;
      break;
    }
  }
  let ffprobe: string | null = null;
  for (const c of candidateBinaries('ffprobe', explicitFfprobe ?? (ffmpeg ? ffmpeg.replace(/ffmpeg(\.exe)?$/i, (_m, e) => `ffprobe${e ?? ''}`) : null))) {
    if (tryBinary(c)) {
      ffprobe = c;
      break;
    }
  }
  let drawtext = false;
  if (ffmpeg) {
    const r = spawnSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    drawtext = /\sdrawtext\s/.test(r.stdout ?? '');
  }
  const fontFile = process.env.VOIDCRAFT_FONT_FILE || FONT_CANDIDATES.find((f) => fs.existsSync(f)) || null;
  const available = Boolean(ffmpeg && ffprobe);
  cached = {
    available,
    ffmpeg,
    ffprobe,
    version,
    drawtext,
    fontFile,
    error: available ? null : 'FFmpeg/FFprobe not found. Install FFmpeg and make sure it is on PATH, or set FFMPEG_PATH and FFPROBE_PATH.',
  };
  if (!available) log.warn(cached.error!);
  return cached;
}

export function requireFfmpeg(): FfmpegInfo & { ffmpeg: string; ffprobe: string } {
  const info = detectFfmpeg();
  if (!info.available || !info.ffmpeg || !info.ffprobe) throw new MediaError(info.error ?? 'FFmpeg unavailable', 503);
  return info as FfmpegInfo & { ffmpeg: string; ffprobe: string };
}

export class MediaError extends Error {
  constructor(message: string, public status = 500, public stderr?: string) {
    super(message);
  }
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Total expected output duration in seconds, used to compute progress. */
  durationHint?: number;
  onProgress?: (fraction: number) => void;
  timeoutMs?: number;
}

/**
 * Run ffmpeg with the given args (no shell). Resolves on exit code 0, rejects
 * with the tail of stderr otherwise. Supports cancellation via AbortSignal.
 */
export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<void> {
  const { ffmpeg } = requireFfmpeg();
  return new Promise((resolve, reject) => {
    const fullArgs = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args];
    log.debug('ffmpeg ' + fullArgs.join(' '));
    const child = spawn(ffmpeg, fullArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => {
      child.kill('SIGKILL');
      finish(new MediaError('Canceled', 499));
    };
    if (opts.signal) {
      if (opts.signal.aborted) return onAbort();
      opts.signal.addEventListener('abort', onAbort);
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new MediaError('FFmpeg timed out', 504, stderr.slice(-4000)));
    }, opts.timeoutMs ?? 6 * 3600 * 1000);
    child.stdout.on('data', (buf: Buffer) => {
      if (!opts.onProgress || !opts.durationHint) return;
      const m = /out_time_(?:us|ms)=(\d+)/.exec(buf.toString());
      if (m) {
        const secs = Number(m[1]) / 1e6;
        opts.onProgress(Math.max(0, Math.min(1, secs / opts.durationHint)));
      }
    });
    child.stderr.on('data', (buf: Buffer) => {
      stderr += buf.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on('error', (err) => finish(new MediaError(`Failed to start ffmpeg: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new MediaError(`FFmpeg failed (exit ${code}): ${lastLines(stderr, 6)}`, 500, stderr.slice(-8000)));
    });
  });
}

function lastLines(s: string, n: number): string {
  return s
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith('  '))
    .slice(-n)
    .join(' | ');
}

export interface ProbeResult {
  formatName: string;
  duration: number | null;
  sizeBytes: number;
  video: { codec: string; width: number; height: number; fps: number | null; pixFmt: string | null } | null;
  audio: { codec: string; sampleRate: number | null; channels: number | null } | null;
}

export async function probe(file: string): Promise<ProbeResult> {
  const { ffprobe } = requireFfmpeg();
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new MediaError(`Could not read media file: ${stderr.trim().slice(0, 300) || 'unknown format'}`, 400))));
  });
  const json = JSON.parse(out) as {
    format?: { format_name?: string; duration?: string; size?: string };
    streams?: Array<Record<string, string | number | undefined>>;
  };
  const streams = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && s.disposition && !(s as { disposition?: { attached_pic?: number } }).disposition?.attached_pic) ?? streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const parseRate = (r: unknown): number | null => {
    if (typeof r !== 'string') return null;
    const [n, d] = r.split('/').map(Number);
    if (!n || !d) return null;
    const f = n / d;
    return f > 0 && f < 1000 ? Math.round(f * 1000) / 1000 : null;
  };
  const dur = Number(json.format?.duration ?? v?.duration ?? a?.duration);
  return {
    formatName: json.format?.format_name ?? 'unknown',
    duration: Number.isFinite(dur) && dur > 0 ? dur : null,
    sizeBytes: Number(json.format?.size ?? 0),
    video: v
      ? {
          codec: String(v.codec_name ?? ''),
          width: Number(v.width ?? 0),
          height: Number(v.height ?? 0),
          fps: parseRate(v.avg_frame_rate) ?? parseRate(v.r_frame_rate),
          pixFmt: (v.pix_fmt as string) ?? null,
        }
      : null,
    audio: a ? { codec: String(a.codec_name ?? ''), sampleRate: Number(a.sample_rate ?? 0) || null, channels: Number(a.channels ?? 0) || null } : null,
  };
}

/** Escape a value for use inside an ffmpeg filter option (filtergraph syntax). */
export function escapeFilterValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

/**
 * Quote a file path for use as a filter option value inside a filtergraph:
 * forward slashes, escaped drive colon, wrapped in single quotes (one level is
 * consumed by the graph parser, the escape by the option parser).
 */
export function filterPath(p: string): string {
  if (p.includes("'")) throw new MediaError('File paths containing single quotes are not supported by the render pipeline', 400);
  return `'${p.replace(/\\/g, '/').replace(/:/g, '\\:')}'`;
}

/** FFmpeg major version, e.g. 6 for "ffmpeg version 6.1.1". */
export function ffmpegMajor(): number {
  const m = /version\s+n?(\d+)/.exec(detectFfmpeg().version ?? '');
  return m ? Number(m[1]) : 6;
}

/** Args that load a filtergraph from a file (avoids Windows command-line length limits). */
export function filterScriptArgs(file: string): string[] {
  return ffmpegMajor() >= 7 ? ['-/filter_complex', file] : ['-filter_complex_script', file];
}
