/** Types shared by the HTTP API and the web client. */
import type { AspectRatio, Camera } from './project.js';

export type AssetType = 'video' | 'image' | 'audio';
export type AssetOrigin = 'upload' | 'generated' | 'export' | 'recording' | 'tool' | 'sample';

export interface Asset {
  id: string;
  type: AssetType;
  origin: AssetOrigin;
  name: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  createdAt: string;
  /** Media metadata from ffprobe. */
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  hasThumbnail: boolean;
  hasWaveform: boolean;
  tags: string[];
  favorite: boolean;
  projectIds: string[];
  /**
   * Provenance. `aiGenerated` is true only when a connected AI model produced the
   * file. Local test renders and FFmpeg tools set it to false.
   */
  provenance: {
    aiGenerated: boolean;
    generator: string | null;
    providerId: string | null;
    modelId: string | null;
    jobId: string | null;
    prompt: string | null;
    sourceAssetIds: string[];
    note: string | null;
  };
}

export type JobTask =
  | 'text-to-video'
  | 'image-to-video'
  | 'video-to-video'
  | 'text-to-image'
  | 'text-to-speech'
  | 'transcribe'
  | 'export'
  | 'tool';

export type JobStatus = 'queued' | 'submitting' | 'running' | 'downloading' | 'succeeded' | 'failed' | 'canceled';

export interface JobRecord {
  id: string;
  task: JobTask;
  providerId: string;
  modelId: string;
  projectId: string | null;
  shotId: string | null;
  status: JobStatus;
  /** 0..1 when the provider reports progress, otherwise null. */
  progress: number | null;
  message: string | null;
  params: GenerationParams | Record<string, unknown>;
  /** Provider-side job handle (never contains credentials). */
  providerJobId: string | null;
  providerState: Record<string, unknown>;
  outputAssetIds: string[];
  /** Non-file outputs, e.g. transcription text/segments. */
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  retryOf: string | null;
}

export interface GenerationParams {
  prompt: string;
  negativePrompt?: string;
  duration?: number;
  aspectRatio?: AspectRatio;
  resolution?: string;
  fps?: number;
  seed?: number | null;
  variations?: number;
  style?: string;
  lighting?: string;
  complexity?: 'simple' | 'moderate' | 'complex';
  motionIntensity?: number;
  camera?: Camera;
  /** Image-to-video. */
  startImageAssetId?: string | null;
  endImageAssetId?: string | null;
  subjectMotion?: string;
  environmentMotion?: string;
  preserveReference?: boolean;
  /** Video-to-video. */
  sourceVideoAssetId?: string | null;
  strength?: number;
  referenceAssetIds?: string[];
  characterIds?: string[];
  environmentId?: string | null;
  /** TTS. */
  voice?: string;
  text?: string;
  /** Transcription. */
  audioAssetId?: string | null;
  language?: string;
  /** Final prompt sent to the provider after camera/style composition (filled by server). */
  compiledPrompt?: string;
}

export type CapabilityRange = { min: number; max: number; step?: number };

export interface ModelCapabilities {
  durations?: number[] | CapabilityRange;
  aspectRatios?: AspectRatio[];
  resolutions?: string[];
  fps?: number[];
  negativePrompt?: boolean;
  seed?: boolean;
  maxVariations?: number;
  endFrame?: boolean;
  maxReferenceImages?: number;
  /** How camera direction reaches the model. 'prompt' = appended to the prompt text. */
  camera?: 'prompt' | 'native' | 'none';
  motionStrength?: boolean;
  strength?: boolean;
  audio?: boolean;
  voices?: string[];
  imageInput?: 'data-uri' | 'public-url' | 'upload' | 'none';
}

export interface ModelInfo {
  id: string;
  providerId: string;
  name: string;
  tasks: JobTask[];
  capabilities: ModelCapabilities;
  notes?: string;
  docsUrl?: string;
  custom?: boolean;
}

export interface ProviderInfo {
  id: string;
  name: string;
  description: string;
  /** True when this provider runs real AI models. The local test renderer is false. */
  isAI: boolean;
  categories: Array<'video' | 'image' | 'llm' | 'tts' | 'stt' | 'tools'>;
  docsUrl: string;
  credentialFields: Array<{ key: string; label: string; envVar: string; secret: boolean; placeholder?: string }>;
  configured: boolean;
  /** Masked hint such as "••••a1b2" plus where it came from. Never the key itself. */
  credentialHints: Record<string, { source: 'env' | 'store' | 'none'; hint: string | null }>;
  enabled: boolean;
  models: ModelInfo[];
  supportsCancel: boolean;
  usage: { jobs: number; succeeded: number; failed: number; secondsGenerated: number; lastUsedAt: string | null };
  limitations: string[];
}

export interface SystemStatus {
  version: string;
  ffmpeg: { available: boolean; version: string | null; path: string | null; drawtext: boolean; error: string | null };
  dataDir: string;
  storage: { assetsBytes: number; exportsBytes: number; freeBytes: number | null };
  demoMode: boolean;
  aiProvidersConfigured: string[];
  limits: { maxVideoBytes: number; maxImageBytes: number; maxAudioBytes: number };
}

export interface AppSettings {
  appearance: { density: 'comfortable' | 'compact'; reducedMotion: boolean; accent: 'violet' | 'lavender' | 'indigo' };
  defaults: {
    videoProviderId: string;
    videoModelId: string;
    llmProviderId: string;
    imageProviderId: string;
    imageModelId: string;
    ttsProviderId: string;
    sttProviderId: string;
    aspectRatio: AspectRatio;
    resolution: '720p' | '1080p' | '4k';
  };
  export: { quality: 'draft' | 'standard' | 'high' | 'master'; codec: 'h264' | 'h265' | 'vp9' | 'prores'; includeAudio: boolean };
  autosaveSeconds: number;
  /** Optional folder that finished exports are also copied to (absolute path on the server machine). */
  storage: { exportDir: string };
  timeline: { snapping: boolean; rippleDelete: boolean; defaultZoom: number };
  performance: { previewScale: number; maxConcurrentJobs: number };
  privacy: { logPrompts: boolean };
  jobs: { timeoutMinutes: number; maxRetries: number };
  providers: Record<string, { enabled: boolean; customModels?: CustomModelDef[] }>;
  shortcuts: Record<string, string>;
}

/** A user-registered model on a generic provider (Replicate / fal). */
export interface CustomModelDef {
  id: string;
  name: string;
  tasks: JobTask[];
  /** JSON input template. Strings may contain {{prompt}}, {{negative_prompt}}, {{image}}, {{end_image}}, {{video}}, {{audio}}, {{duration}}, {{aspect_ratio}}, {{seed}}. */
  inputTemplate: Record<string, unknown>;
  notes?: string;
}

export interface ApiError {
  error: string;
  details?: unknown;
}
