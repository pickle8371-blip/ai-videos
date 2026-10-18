import path from 'node:path';
import { z } from 'zod';
import type { AppSettings } from '../../shared/api.js';
import { readJson, writeFileAtomic } from './jsonfile.js';

export const DEFAULT_SHORTCUTS: Record<string, string> = {
  playPause: 'Space',
  split: 'S',
  delete: 'Delete',
  duplicate: 'Ctrl+D',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Shift+Z',
  save: 'Ctrl+S',
  zoomIn: '=',
  zoomOut: '-',
  frameBack: 'ArrowLeft',
  frameForward: 'ArrowRight',
  toStart: 'Home',
  toEnd: 'End',
  addKeyframe: 'K',
  togglePanels: 'Ctrl+\\',
  fullscreen: 'F',
};

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: { density: 'comfortable', reducedMotion: false, accent: 'violet' },
  defaults: {
    videoProviderId: 'local-test',
    videoModelId: 'local-test-render',
    llmProviderId: 'offline-templates',
    imageProviderId: '',
    imageModelId: '',
    ttsProviderId: '',
    sttProviderId: '',
    aspectRatio: '16:9',
    resolution: '1080p',
  },
  export: { quality: 'high', codec: 'h264', includeAudio: true },
  autosaveSeconds: 20,
  storage: { exportDir: '' },
  timeline: { snapping: true, rippleDelete: false, defaultZoom: 60 },
  performance: { previewScale: 0.5, maxConcurrentJobs: 3 },
  privacy: { logPrompts: false },
  jobs: { timeoutMinutes: 30, maxRetries: 3 },
  providers: {},
  shortcuts: DEFAULT_SHORTCUTS,
};

const CustomModelSchema = z.object({
  id: z.string().min(1).max(200).regex(/^[A-Za-z0-9._\/:@-]+$/, 'Model id may contain letters, digits and . _ / : @ -'),
  name: z.string().min(1).max(120),
  tasks: z.array(z.enum(['text-to-video', 'image-to-video', 'video-to-video', 'text-to-image', 'text-to-speech', 'transcribe', 'tool'])).min(1),
  inputTemplate: z.record(z.string(), z.unknown()),
  notes: z.string().max(1000).optional(),
});

const SettingsPatchSchema = z
  .object({
    appearance: z.object({ density: z.enum(['comfortable', 'compact']), reducedMotion: z.boolean(), accent: z.enum(['violet', 'lavender', 'indigo']) }).partial(),
    defaults: z
      .object({
        videoProviderId: z.string().max(100),
        videoModelId: z.string().max(200),
        llmProviderId: z.string().max(100),
        imageProviderId: z.string().max(100),
        imageModelId: z.string().max(200),
        ttsProviderId: z.string().max(100),
        sttProviderId: z.string().max(100),
        aspectRatio: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']),
        resolution: z.enum(['720p', '1080p', '4k']),
      })
      .partial(),
    export: z.object({ quality: z.enum(['draft', 'standard', 'high', 'master']), codec: z.enum(['h264', 'h265', 'vp9', 'prores']), includeAudio: z.boolean() }).partial(),
    autosaveSeconds: z.number().int().min(5).max(600),
    storage: z.object({ exportDir: z.string().max(1000) }).partial(),
    timeline: z.object({ snapping: z.boolean(), rippleDelete: z.boolean(), defaultZoom: z.number().min(5).max(400) }).partial(),
    performance: z.object({ previewScale: z.number().min(0.25).max(1), maxConcurrentJobs: z.number().int().min(1).max(10) }).partial(),
    privacy: z.object({ logPrompts: z.boolean() }).partial(),
    jobs: z.object({ timeoutMinutes: z.number().int().min(1).max(240), maxRetries: z.number().int().min(0).max(10) }).partial(),
    providers: z.record(z.string(), z.object({ enabled: z.boolean(), customModels: z.array(CustomModelSchema).max(50).optional() })),
    shortcuts: z.record(z.string(), z.string().max(40)),
  })
  .partial()
  .strict();

export class SettingsStore {
  private file: string;
  private value: AppSettings = structuredClone(DEFAULT_SETTINGS);
  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'settings.json');
  }

  async load(): Promise<void> {
    const stored = await readJson<Partial<AppSettings>>(this.file, {});
    this.value = merge(structuredClone(DEFAULT_SETTINGS), stored);
  }

  get(): AppSettings {
    return this.value;
  }

  async patch(patch: unknown): Promise<AppSettings> {
    const parsed = SettingsPatchSchema.safeParse(patch);
    if (!parsed.success) {
      const err = new Error('Invalid settings: ' + parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')) as Error & { status: number };
      err.status = 400;
      throw err;
    }
    this.value = merge(this.value, parsed.data as Partial<AppSettings>);
    await writeFileAtomic(this.file, JSON.stringify(this.value, null, 1));
    return this.value;
  }

  async reset(): Promise<AppSettings> {
    this.value = structuredClone(DEFAULT_SETTINGS);
    await writeFileAtomic(this.file, JSON.stringify(this.value, null, 1));
    return this.value;
  }
}

function merge<T>(base: T, patch: Partial<T>): T {
  if (!patch || typeof patch !== 'object') return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) out[k] = merge(cur, v as never);
    else if (v !== undefined) out[k] = v;
  }
  return out as T;
}
