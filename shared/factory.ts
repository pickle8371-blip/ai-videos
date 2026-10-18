import type { AspectRatio, ExportSettings, MediaClip, Project, TextClip, Track } from './project.js';
import { PROJECT_FORMAT_VERSION } from './project.js';

/** Random id that also works in non-secure browser contexts (no crypto.randomUUID). */
export function newId(prefix = ''): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  const s = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
  return prefix ? `${prefix}_${s}` : s;
}

export const ASPECT_DIMENSIONS: Record<AspectRatio, Record<'720p' | '1080p' | '4k', [number, number]>> = {
  '16:9': { '720p': [1280, 720], '1080p': [1920, 1080], '4k': [3840, 2160] },
  '9:16': { '720p': [720, 1280], '1080p': [1080, 1920], '4k': [2160, 3840] },
  '1:1': { '720p': [720, 720], '1080p': [1080, 1080], '4k': [2160, 2160] },
  '4:3': { '720p': [960, 720], '1080p': [1440, 1080], '4k': [2880, 2160] },
  '3:4': { '720p': [720, 960], '1080p': [1080, 1440], '4k': [2160, 2880] },
  '21:9': { '720p': [1680, 720], '1080p': [2520, 1080], '4k': [5040, 2160] },
};

export function dimensionsFor(aspect: AspectRatio, res: '720p' | '1080p' | '4k'): [number, number] {
  return ASPECT_DIMENSIONS[aspect][res];
}

export function makeTrack(kind: Track['kind'], name: string, extra: Partial<Track> = {}): Track {
  return {
    id: newId('trk'),
    kind,
    name,
    muted: false,
    solo: false,
    hidden: false,
    locked: false,
    height: kind === 'video' ? 64 : kind === 'audio' ? 52 : 40,
    volume: 1,
    clips: [],
    cues: [],
    burnIn: true,
    ...extra,
  };
}

export function defaultTracks(): Track[] {
  return [
    makeTrack('video', 'V1'),
    makeTrack('video', 'V2'),
    makeTrack('text', 'Titles'),
    makeTrack('subtitle', 'Subtitles'),
    makeTrack('audio', 'Dialogue', { role: 'dialogue' }),
    makeTrack('audio', 'Music', { role: 'music' }),
    makeTrack('audio', 'SFX', { role: 'sfx' }),
  ];
}

export function defaultExportSettings(width: number, height: number, fps: number): ExportSettings {
  return {
    width,
    height,
    fps,
    codec: 'h264',
    container: 'mp4',
    quality: 'high',
    includeAudio: true,
    audioBitrateKbps: 192,
    fileName: '',
  };
}

export interface NewProjectOptions {
  name: string;
  aspectRatio?: AspectRatio;
  resolution?: '720p' | '1080p' | '4k';
  fps?: number;
  templateId?: string | null;
}

export function createProject(opts: NewProjectOptions): Project {
  const aspect = opts.aspectRatio ?? '16:9';
  const [w, h] = dimensionsFor(aspect, opts.resolution ?? '1080p');
  const fps = opts.fps ?? 30;
  const now = new Date().toISOString();
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    id: newId('prj'),
    name: opts.name,
    description: '',
    createdAt: now,
    updatedAt: now,
    settings: { width: w, height: h, fps, aspectRatio: aspect, background: '#000000', stillDuration: 4 },
    timeline: { tracks: defaultTracks(), masterEffects: [] },
    storyboard: { idea: '', shots: [], source: 'manual' },
    characters: [],
    environments: [],
    promptHistory: [],
    generationJobIds: [],
    assetIds: [],
    exportSettings: defaultExportSettings(w, h, fps),
    templateId: opts.templateId ?? null,
  };
}

export function makeMediaClip(assetId: string, start: number, duration: number, extra: Partial<MediaClip> = {}): MediaClip {
  return {
    id: newId('clp'),
    kind: 'media',
    assetId,
    start,
    in: 0,
    out: duration,
    speed: 1,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    transform: { x: 0, y: 0, scale: 1, fit: 'contain', crop: { left: 0, top: 0, right: 0, bottom: 0 }, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1, gamma: 1, hue: 0, exposure: 0, temperature: 0 },
    effects: [],
    transitionIn: { type: 'none', duration: 0 },
    keyframes: {},
    ...extra,
  };
}

export function makeTextClip(text: string, start: number, duration: number, extra: Partial<TextClip> = {}): TextClip {
  return {
    id: newId('txt'),
    kind: 'text',
    text,
    start,
    duration,
    style: { fontSize: 72, color: '#ffffff', x: 0.5, y: 0.5, bold: true, box: false, boxColor: '#000000', boxOpacity: 0.5, shadow: true },
    fadeIn: 0.4,
    fadeOut: 0.4,
    ...extra,
  };
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  aspectRatio: AspectRatio;
  resolution: '720p' | '1080p' | '4k';
  fps: number;
  builtIn: boolean;
  /** Storyboard shot titles to pre-populate. */
  shotTitles?: string[];
  titleText?: string;
  masterLetterbox?: boolean;
  /** For user templates: a full project snapshot (assets referenced by id). */
  snapshot?: Project;
}

export const BUILT_IN_TEMPLATES: ProjectTemplate[] = (
  [
  {
    id: 'tpl_cinematic',
    name: 'Cinematic short',
    description: '16:9 1080p at 24 fps with letterbox and a three-act shot skeleton.',
    aspectRatio: '16:9',
    resolution: '1080p',
    fps: 24,
    shotTitles: ['Establishing shot', 'Introduce the hero', 'Inciting moment', 'Confrontation', 'Resolution'],
    titleText: 'TITLE',
    masterLetterbox: true,
  },
  {
    id: 'tpl_vertical',
    name: 'Vertical social',
    description: '9:16 1080p at 30 fps for Shorts / Reels / TikTok.',
    aspectRatio: '9:16',
    resolution: '1080p',
    fps: 30,
    shotTitles: ['Hook (0–2s)', 'Payoff', 'Call to action'],
    titleText: 'Watch this',
  },
  {
    id: 'tpl_square',
    name: 'Square loop',
    description: '1:1 1080p at 30 fps for feeds and loops.',
    aspectRatio: '1:1',
    resolution: '1080p',
    fps: 30,
    shotTitles: ['Loop'],
  },
  {
    id: 'tpl_music',
    name: 'Music video',
    description: '16:9 1080p at 30 fps with music track and performance/b-roll shots.',
    aspectRatio: '16:9',
    resolution: '1080p',
    fps: 30,
    shotTitles: ['Intro atmosphere', 'Performance wide', 'Performance close-up', 'B-roll', 'Chorus montage', 'Outro'],
  },
  {
    id: 'tpl_pitch',
    name: 'Storyboard pitch',
    description: '16:9 720p animatic for pitching ideas quickly.',
    aspectRatio: '16:9',
    resolution: '720p',
    fps: 24,
    shotTitles: ['Opening image', 'World', 'Character', 'Conflict', 'Climax', 'Closing image'],
    titleText: 'PITCH',
  },
  ] as Omit<ProjectTemplate, 'builtIn'>[]
).map((t) => ({ ...t, builtIn: true }));
