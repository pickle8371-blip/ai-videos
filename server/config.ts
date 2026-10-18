import path from 'node:path';
import fs from 'node:fs';

export interface ServerConfig {
  dataDir: string;
  port: number;
  host: string;
  /** Public base URL the server is reachable at; needed only for providers that fetch inputs by URL. */
  publicBaseUrl: string | null;
  limits: { maxVideoBytes: number; maxImageBytes: number; maxAudioBytes: number; maxProjectImportBytes: number };
  pollIntervalMs: number;
  /** Overrides the job timeout from settings (used by tests; VOIDCRAFT_JOB_TIMEOUT_MS). */
  jobTimeoutMs: number | null;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  version: string;
}

const MB = 1024 * 1024;

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const dataDir = path.resolve(overrides.dataDir ?? process.env.VOIDCRAFT_DATA_DIR ?? path.join(process.cwd(), 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    dataDir,
    port: num(process.env.VOIDCRAFT_PORT, 5174),
    host: process.env.VOIDCRAFT_HOST || '127.0.0.1',
    publicBaseUrl: process.env.VOIDCRAFT_PUBLIC_URL || null,
    limits: {
      maxVideoBytes: num(process.env.VOIDCRAFT_MAX_VIDEO_MB, 2048) * MB,
      maxImageBytes: num(process.env.VOIDCRAFT_MAX_IMAGE_MB, 40) * MB,
      maxAudioBytes: num(process.env.VOIDCRAFT_MAX_AUDIO_MB, 500) * MB,
      maxProjectImportBytes: num(process.env.VOIDCRAFT_MAX_IMPORT_MB, 4096) * MB,
    },
    pollIntervalMs: num(process.env.VOIDCRAFT_POLL_MS, 4000),
    jobTimeoutMs: process.env.VOIDCRAFT_JOB_TIMEOUT_MS ? num(process.env.VOIDCRAFT_JOB_TIMEOUT_MS, 0) || null : null,
    ffmpegPath: process.env.FFMPEG_PATH || null,
    ffprobePath: process.env.FFPROBE_PATH || null,
    version: '0.1.0',
    ...overrides,
  };
}
