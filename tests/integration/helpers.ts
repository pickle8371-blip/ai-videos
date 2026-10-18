import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import supertest from 'supertest';
import { createApp, createContext, type AppContext } from '../../server/app';
import type { Provider } from '../../server/providers/types';
import { ALL_PROVIDERS } from '../../server/providers/registry';
import { setQuiet } from '../../server/logger';

setQuiet(true);

export interface TestEnv {
  ctx: AppContext;
  agent: ReturnType<typeof supertest>;
  dataDir: string;
  close: () => Promise<void>;
}

export async function makeEnv(opts: { dataDir?: string; providers?: Provider[]; config?: Record<string, unknown> } = {}): Promise<TestEnv> {
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'vc-int-'));
  const ctx = await createContext({ dataDir, pollIntervalMs: 50, port: 0, ...(opts.config ?? {}) }, opts.providers ?? ALL_PROVIDERS);
  const app = createApp(ctx);
  return {
    ctx,
    agent: supertest(app),
    dataDir,
    close: async () => {
      ctx.jobs.shutdown();
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}

const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-media-'));

/** Generate a sample media file with FFmpeg (cached per name). */
export function sample(name: string, args: string[]): string {
  const out = path.join(mediaDir, name);
  if (fs.existsSync(out)) return out;
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, out]);
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${name}: ${r.stderr}`);
  return out;
}

export const samples = {
  video: () => sample('clip.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']),
  silentVideo: () => sample('silent.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=320x180:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']),
  image: () => sample('still.png', ['-f', 'lavfi', '-i', 'testsrc2=s=400x300', '-frames:v', '1']),
  audio: () => sample('tone.wav', ['-f', 'lavfi', '-i', 'sine=frequency=330:d=4']),
};

export function fakeFile(name: string, content: string | Buffer): string {
  const p = path.join(mediaDir, name);
  fs.writeFileSync(p, content);
  return p;
}

/** Serve local files over HTTP so provider result downloads can be tested without the internet. */
export async function fileServer(files: Record<string, string>): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const f = files[req.url ?? ''];
    if (!f) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('Content-Type', 'video/mp4');
    fs.createReadStream(f).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined> | T | null | undefined, timeoutMs = 60_000, intervalMs = 100): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function waitForJob(env: TestEnv, id: string, timeoutMs = 90_000) {
  return waitFor(() => {
    const j = env.ctx.jobs.get(id);
    return j && ['succeeded', 'failed', 'canceled'].includes(j.status) ? j : null;
  }, timeoutMs);
}

export async function upload(env: TestEnv, file: string, fields: Record<string, string> = {}) {
  let req = env.agent.post('/api/assets');
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  return req.attach('file', file);
}
