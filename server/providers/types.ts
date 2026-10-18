import type { AppSettings, JobRecord, ModelInfo, ProviderInfo } from '../../shared/api.js';
import type { AssetStore } from '../storage/assets.js';
import type { ServerConfig } from '../config.js';

export type ProviderOutput =
  | { kind: 'url'; url: string; name: string; headers?: Record<string, string> }
  | { kind: 'buffer'; data: Uint8Array; name: string }
  | { kind: 'file'; path: string; name: string };

export type PollResult =
  | { status: 'running'; progress?: number | null; message?: string | null; state?: Record<string, unknown> }
  | { status: 'succeeded'; outputs: ProviderOutput[]; result?: Record<string, unknown> }
  | { status: 'failed'; error: string; retryable?: boolean }
  | { status: 'canceled' };

export interface SubmitResult {
  providerJobId: string;
  state?: Record<string, unknown>;
  /** For synchronous APIs (e.g. TTS) the result is available immediately. */
  immediate?: PollResult;
}

export interface ProviderContext {
  creds: Record<string, string>;
  fetch: typeof fetch;
  assets: AssetStore;
  config: ServerConfig;
  settings: AppSettings;
  signal: AbortSignal;
  /** Encode an asset as a data URI (images are downscaled to fit `maxBytes`). */
  assetDataUri(assetId: string, opts?: { maxBytes?: number; maxDim?: number }): Promise<string>;
  /** Public URL for an asset if VOIDCRAFT_PUBLIC_URL is set, else null. */
  publicAssetUrl(assetId: string): string | null;
  /** Absolute file path of an asset. */
  assetPath(assetId: string): string;
}

export interface LlmRequest {
  system: string;
  user: string;
  /** When given, the provider must return JSON matching this schema. */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
}

export type StaticProviderInfo = Omit<ProviderInfo, 'configured' | 'credentialHints' | 'enabled' | 'models' | 'usage'>;

export interface Provider {
  info: StaticProviderInfo;
  models(settings: AppSettings, config: ServerConfig): ModelInfo[];
  /** Whether the provider needs API credentials. Local providers don't. */
  needsCredentials: boolean;
  /** For credential-less providers: whether it can run right now (e.g. local engine installed). */
  available?(): boolean;
  testConnection?(ctx: ProviderContext): Promise<{ ok: boolean; message: string }>;
  submit?(job: JobRecord, model: ModelInfo, ctx: ProviderContext): Promise<SubmitResult>;
  poll?(job: JobRecord, model: ModelInfo, ctx: ProviderContext): Promise<PollResult>;
  cancel?(job: JobRecord, model: ModelInfo, ctx: ProviderContext): Promise<void>;
  llm?(req: LlmRequest, ctx: ProviderContext): Promise<string>;
}

export class ProviderError extends Error {
  constructor(message: string, public status = 502, public retryable = false, public retryAfterMs: number | null = null) {
    super(message);
  }
}
