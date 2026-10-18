/**
 * Voidcraft project format (formatVersion 1).
 *
 * This file is the single source of truth for the project document. The server
 * validates every saved/imported project with `ProjectSchema`, and the web app
 * uses the inferred types. See docs/PROJECT_FORMAT.md for a prose description.
 */
import { z } from 'zod';

export const PROJECT_FORMAT_VERSION = 1;

const id = z.string().min(1).max(100);
const seconds = z.number().finite().min(0).max(24 * 3600);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const AspectRatioSchema = z.enum(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

/* ------------------------------------------------------------------ effects */

export const EFFECT_TYPES = [
  'colorGrade',
  'bloom',
  'motionBlur',
  'depthOfField',
  'filmGrain',
  'vignette',
  'glitch',
  'fog',
  'lightLeak',
  'cameraShake',
  'blur',
  'sharpen',
  'chromaticAberration',
  'letterbox',
] as const;
export const EffectTypeSchema = z.enum(EFFECT_TYPES);
export type EffectType = z.infer<typeof EffectTypeSchema>;

export const EffectSchema = z.object({
  id,
  type: EffectTypeSchema,
  enabled: z.boolean().default(true),
  /** Effect parameters; each is a number in a documented range (see shared/effects.ts). */
  params: z.record(z.string(), z.number().finite()).default({}),
});
export type Effect = z.infer<typeof EffectSchema>;

/* ---------------------------------------------------------------- keyframes */

export const KeyframePropertySchema = z.enum(['opacity', 'scale', 'x', 'y']);
export type KeyframeProperty = z.infer<typeof KeyframePropertySchema>;
export const KeyframeSchema = z.object({
  /** Time relative to clip start on the timeline, in seconds. */
  t: seconds,
  v: z.number().finite(),
});
export type Keyframe = z.infer<typeof KeyframeSchema>;

/* ---------------------------------------------------------------- timeline */

export const TRANSITION_TYPES = ['none', 'dissolve', 'dipToBlack', 'slideLeft', 'slideRight', 'slideUp', 'slideDown'] as const;
export const TransitionSchema = z.object({
  type: z.enum(TRANSITION_TYPES),
  duration: z.number().min(0).max(10),
});
export type Transition = z.infer<typeof TransitionSchema>;

export const ColorAdjustSchema = z.object({
  brightness: z.number().min(-1).max(1).default(0),
  contrast: z.number().min(0).max(3).default(1),
  saturation: z.number().min(0).max(3).default(1),
  gamma: z.number().min(0.1).max(3).default(1),
  hue: z.number().min(-180).max(180).default(0),
  /** Exposure in stops (-3..3). */
  exposure: z.number().min(-3).max(3).default(0),
  /** Warm/cool shift (-1 cool .. 1 warm). */
  temperature: z.number().min(-1).max(1).default(0),
});
export type ColorAdjust = z.infer<typeof ColorAdjustSchema>;

export const TransformSchema = z.object({
  /** Offset of the clip centre from the frame centre, as a fraction of frame width/height. */
  x: z.number().min(-2).max(2).default(0),
  y: z.number().min(-2).max(2).default(0),
  /** 1 = fit inside the frame (letterboxed); the fit mode decides how. */
  scale: z.number().min(0.05).max(10).default(1),
  fit: z.enum(['contain', 'cover', 'stretch']).default('contain'),
  /** Source crop, as fractions of the source dimensions removed from each edge. */
  crop: z
    .object({ left: z.number().min(0).max(0.9), top: z.number().min(0).max(0.9), right: z.number().min(0).max(0.9), bottom: z.number().min(0).max(0.9) })
    .default({ left: 0, top: 0, right: 0, bottom: 0 }),
  opacity: z.number().min(0).max(1).default(1),
});
export type Transform = z.infer<typeof TransformSchema>;

export const MediaClipSchema = z.object({
  id,
  kind: z.literal('media'),
  assetId: id,
  /** Position on the timeline (seconds). */
  start: seconds,
  /** Source in/out points (seconds, in source time). For still images `in` is 0 and `out` is the display duration. */
  in: seconds,
  out: seconds,
  speed: z.number().min(0.25).max(4).default(1),
  volume: z.number().min(0).max(2).default(1),
  muted: z.boolean().default(false),
  fadeIn: z.number().min(0).max(30).default(0),
  fadeOut: z.number().min(0).max(30).default(0),
  transform: TransformSchema.default({}),
  color: ColorAdjustSchema.default({}),
  effects: z.array(EffectSchema).max(32).default([]),
  transitionIn: TransitionSchema.default({ type: 'none', duration: 0 }),
  keyframes: z.record(KeyframePropertySchema, z.array(KeyframeSchema).max(200)).default({}),
  label: z.string().max(200).optional(),
});
export type MediaClip = z.infer<typeof MediaClipSchema>;

export const TextStyleSchema = z.object({
  fontSize: z.number().min(6).max(400).default(64),
  color: color.default('#ffffff'),
  /** Anchor point of the text block centre, as fractions of frame size (0..1). */
  x: z.number().min(0).max(1).default(0.5),
  y: z.number().min(0).max(1).default(0.5),
  bold: z.boolean().default(false),
  box: z.boolean().default(false),
  boxColor: color.default('#000000'),
  boxOpacity: z.number().min(0).max(1).default(0.5),
  shadow: z.boolean().default(true),
});
export type TextStyle = z.infer<typeof TextStyleSchema>;

export const TextClipSchema = z.object({
  id,
  kind: z.literal('text'),
  text: z.string().max(2000),
  start: seconds,
  duration: z.number().min(0.05).max(24 * 3600),
  style: TextStyleSchema.default({}),
  fadeIn: z.number().min(0).max(10).default(0),
  fadeOut: z.number().min(0).max(10).default(0),
});
export type TextClip = z.infer<typeof TextClipSchema>;

export const ClipSchema = z.discriminatedUnion('kind', [MediaClipSchema, TextClipSchema]);
export type Clip = z.infer<typeof ClipSchema>;

export const SubtitleCueSchema = z.object({ id, start: seconds, end: seconds, text: z.string().max(1000) });
export type SubtitleCue = z.infer<typeof SubtitleCueSchema>;

export const TRACK_KINDS = ['video', 'audio', 'text', 'subtitle'] as const;
export const TrackKindSchema = z.enum(TRACK_KINDS);
export type TrackKind = z.infer<typeof TrackKindSchema>;

export const AUDIO_ROLES = ['dialogue', 'music', 'sfx', 'voiceover', 'general'] as const;

export const TrackSchema = z.object({
  id,
  kind: TrackKindSchema,
  name: z.string().max(100),
  role: z.enum(AUDIO_ROLES).optional(),
  muted: z.boolean().default(false),
  solo: z.boolean().default(false),
  hidden: z.boolean().default(false),
  locked: z.boolean().default(false),
  height: z.number().min(28).max(240).default(56),
  volume: z.number().min(0).max(2).default(1),
  clips: z.array(ClipSchema).max(2000).default([]),
  cues: z.array(SubtitleCueSchema).max(10000).default([]),
  /** Subtitle tracks: burn into the exported video. */
  burnIn: z.boolean().default(true),
});
export type Track = z.infer<typeof TrackSchema>;

export const TimelineSchema = z.object({
  /** Order matters: for video tracks, later tracks render on top. */
  tracks: z.array(TrackSchema).max(64),
  /** Effects applied to the final composite. */
  masterEffects: z.array(EffectSchema).max(32).default([]),
});
export type Timeline = z.infer<typeof TimelineSchema>;

/* ------------------------------------------------------------- references */

export const CharacterSchema = z.object({
  id,
  name: z.string().min(1).max(120),
  description: z.string().max(4000).default(''),
  appearance: z.string().max(4000).default(''),
  face: z.string().max(2000).default(''),
  body: z.string().max(2000).default(''),
  clothing: z.string().max(2000).default(''),
  accessories: z.string().max(2000).default(''),
  palette: z.array(color).max(12).default([]),
  referenceAssetIds: z.array(id).max(50).default([]),
  approvedAssetIds: z.array(id).max(200).default([]),
  rejectedAssetIds: z.array(id).max(200).default([]),
  notes: z.string().max(4000).default(''),
  createdAt: z.string(),
});
export type Character = z.infer<typeof CharacterSchema>;

export const ENVIRONMENT_CATEGORIES = [
  'city',
  'forest',
  'mountain',
  'interior',
  'fantasy',
  'sci-fi',
  'horror',
  'historical',
  'custom',
] as const;

export const EnvironmentSchema = z.object({
  id,
  name: z.string().min(1).max(120),
  category: z.enum(ENVIRONMENT_CATEGORIES).default('custom'),
  description: z.string().max(4000).default(''),
  lighting: z.string().max(2000).default(''),
  atmosphere: z.string().max(2000).default(''),
  palette: z.array(color).max(12).default([]),
  referenceAssetIds: z.array(id).max(50).default([]),
  notes: z.string().max(4000).default(''),
  createdAt: z.string(),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

/* ------------------------------------------------------------------ camera */

export const CAMERA_MOVES = [
  'static',
  'panLeft',
  'panRight',
  'tiltUp',
  'tiltDown',
  'dollyIn',
  'dollyOut',
  'tracking',
  'orbit',
  'crane',
  'handheld',
  'slowPushIn',
  'pullBackReveal',
  'aerial',
  'firstPerson',
] as const;
export const SHOT_FRAMINGS = ['auto', 'overTheShoulder', 'wideEstablishing', 'wide', 'medium', 'closeUp', 'extremeCloseUp'] as const;

export const CameraSchema = z.object({
  move: z.enum(CAMERA_MOVES).default('static'),
  framing: z.enum(SHOT_FRAMINGS).default('auto'),
  /** 0..1 */
  speed: z.number().min(0).max(1).default(0.4),
  intensity: z.number().min(0).max(1).default(0.5),
  subjectFocus: z.string().max(300).default(''),
  direction: z.enum(['auto', 'left', 'right', 'up', 'down', 'forward', 'backward', 'clockwise', 'counterclockwise']).default('auto'),
});
export type Camera = z.infer<typeof CameraSchema>;

/* -------------------------------------------------------------- storyboard */

export const SHOT_STATUSES = ['draft', 'queued', 'generating', 'done', 'failed'] as const;

export const ShotSchema = z.object({
  id,
  title: z.string().max(200),
  description: z.string().max(4000).default(''),
  prompt: z.string().max(4000).default(''),
  characterIds: z.array(id).max(20).default([]),
  environmentId: id.nullable().default(null),
  cameraAngle: z.string().max(200).default(''),
  camera: CameraSchema.default({}),
  lighting: z.string().max(500).default(''),
  dialogue: z.string().max(2000).default(''),
  duration: z.number().min(1).max(60).default(5),
  status: z.enum(SHOT_STATUSES).default('draft'),
  frameAssetId: id.nullable().default(null),
  videoAssetId: id.nullable().default(null),
  lastJobId: id.nullable().default(null),
  review: z.enum(['unreviewed', 'approved', 'rejected']).default('unreviewed'),
  error: z.string().max(2000).nullable().default(null),
});
export type Shot = z.infer<typeof ShotSchema>;

export const StoryboardSchema = z.object({
  idea: z.string().max(10000).default(''),
  shots: z.array(ShotSchema).max(500).default([]),
  /** Who produced the shot list: an LLM provider id, or 'offline-template' (not AI), or 'manual'. */
  source: z.string().max(100).default('manual'),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

/* ------------------------------------------------------------- misc data */

export const PromptHistoryEntrySchema = z.object({
  id,
  text: z.string().max(8000),
  negative: z.string().max(4000).default(''),
  kind: z.string().max(40),
  createdAt: z.string(),
});
export type PromptHistoryEntry = z.infer<typeof PromptHistoryEntrySchema>;

export const ExportSettingsSchema = z.object({
  width: z.number().int().min(64).max(7680),
  height: z.number().int().min(64).max(4320),
  fps: z.number().min(1).max(120),
  codec: z.enum(['h264', 'h265', 'vp9', 'prores']).default('h264'),
  container: z.enum(['mp4', 'mov', 'webm']).default('mp4'),
  /** Constant-rate-factor style quality: 'draft' | 'standard' | 'high' | 'master'. */
  quality: z.enum(['draft', 'standard', 'high', 'master']).default('high'),
  includeAudio: z.boolean().default(true),
  audioBitrateKbps: z.number().int().min(64).max(512).default(192),
  fileName: z.string().max(200).default(''),
});
export type ExportSettings = z.infer<typeof ExportSettingsSchema>;

export const ProjectSettingsSchema = z.object({
  width: z.number().int().min(64).max(7680),
  height: z.number().int().min(64).max(4320),
  fps: z.number().min(1).max(120),
  aspectRatio: AspectRatioSchema,
  background: color.default('#000000'),
  /** Default duration (s) for stills dropped on the timeline. */
  stillDuration: z.number().min(0.5).max(120).default(4),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const ProjectSchema = z.object({
  formatVersion: z.literal(PROJECT_FORMAT_VERSION),
  id,
  name: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
  settings: ProjectSettingsSchema,
  timeline: TimelineSchema,
  storyboard: StoryboardSchema.default({}),
  characters: z.array(CharacterSchema).max(200).default([]),
  environments: z.array(EnvironmentSchema).max(200).default([]),
  promptHistory: z.array(PromptHistoryEntrySchema).max(2000).default([]),
  /** Generation job ids started from this project. Job records live in the job store. */
  generationJobIds: z.array(id).max(10000).default([]),
  /** Asset ids imported into or produced for this project. */
  assetIds: z.array(id).max(20000).default([]),
  exportSettings: ExportSettingsSchema,
  templateId: z.string().max(100).nullable().default(null),
});
export type Project = z.infer<typeof ProjectSchema>;

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  savedAt: string;
  aspectRatio: AspectRatio;
  thumbnailAssetId: string | null;
  hasRecovery: boolean;
  recoveryAt: string | null;
  clipCount: number;
  shotCount: number;
}
