import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModelInfo, ProviderInfo } from '../../shared/api.js';
import type { ServerConfig } from '../config.js';
import type { AssetStore } from '../storage/assets.js';
import type { SecretStore } from '../storage/secrets.js';
import { maskSecret } from '../storage/secrets.js';
import type { SettingsStore } from '../storage/settings.js';
import { JsonCollection } from '../storage/jsonfile.js';
import { runFfmpeg } from '../media/ffmpeg.js';
import { registerSecret } from '../logger.js';
import { localTestProvider, localToolsProvider } from './local.js';
import { replicateProvider } from './replicate.js';
import { falProvider } from './fal.js';
import { lumaProvider } from './luma.js';
import { runwayProvider } from './runway.js';
import { openaiProvider } from './openai.js';
import { googleProvider } from './google.js';
import { anthropicProvider } from './anthropic.js';
import { elevenlabsProvider } from './elevenlabs.js';
import { offlineTemplatesProvider } from '../ai.js';
import type { Provider, ProviderContext } from './types.js';
import { ProviderError } from './types.js';

export const ALL_PROVIDERS: Provider[] = [
  localTestProvider,
  localToolsProvider,
  offlineTemplatesProvider,
  replicateProvider,
  falProvider,
  lumaProvider,
  runwayProvider,
  openaiProvider,
  googleProvider,
  anthropicProvider,
  elevenlabsProvider,
];

interface UsageRecord {
  id: string;
  jobs: number;
  succeeded: number;
  failed: number;
  secondsGenerated: number;
  lastUsedAt: string | null;
}

export class ProviderRegistry {
  private providers = new Map<string, Provider>();
  private usage: JsonCollection<UsageRecord>;
  /** Injected for tests so no real network calls are made. */
  fetchImpl: typeof fetch = (...args) => fetch(...args);

  constructor(
    private config: ServerConfig,
    private secrets: SecretStore,
    private settings: SettingsStore,
    private assets: AssetStore,
    providers: Provider[] = ALL_PROVIDERS,
  ) {
    for (const p of providers) this.providers.set(p.info.id, p);
    this.usage = new JsonCollection(path.join(config.dataDir, 'usage.json'));
  }

  async load(): Promise<void> {
    await this.usage.load();
    for (const p of this.providers.values()) for (const f of p.info.credentialFields) if (f.secret) registerSecret(process.env[f.envVar]);
  }

  register(p: Provider): void {
    this.providers.set(p.info.id, p);
  }

  get(id: string): Provider {
    const p = this.providers.get(id);
    if (!p) throw new ProviderError(`Unknown provider "${id}"`, 404);
    return p;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  list(): Provider[] {
    return [...this.providers.values()];
  }

  /** Resolve credentials: environment variables take precedence over the encrypted store. */
  credentials(id: string): Record<string, string> {
    const p = this.get(id);
    const out: Record<string, string> = {};
    for (const f of p.info.credentialFields) {
      const v = process.env[f.envVar] || this.secrets.getStored(id, f.key);
      if (v) out[f.key] = v;
    }
    return out;
  }

  isConfigured(id: string): boolean {
    const p = this.get(id);
    if (!p.needsCredentials) return true;
    const creds = this.credentials(id);
    return p.info.credentialFields.filter((f) => f.secret).every((f) => Boolean(creds[f.key]));
  }

  isEnabled(id: string): boolean {
    return this.settings.get().providers[id]?.enabled !== false;
  }

  models(id: string): ModelInfo[] {
    return this.get(id).models(this.settings.get(), this.config);
  }

  findModel(providerId: string, modelId: string): ModelInfo {
    const m = this.models(providerId).find((x) => x.id === modelId);
    if (!m) throw new ProviderError(`Model "${modelId}" is not available on ${this.get(providerId).info.name}`, 404);
    return m;
  }

  info(id: string): ProviderInfo {
    const p = this.get(id);
    const hints: ProviderInfo['credentialHints'] = {};
    for (const f of p.info.credentialFields) {
      const env = process.env[f.envVar];
      const stored = this.secrets.getStored(id, f.key);
      const value = env || stored;
      hints[f.key] = {
        source: env ? 'env' : stored ? 'store' : 'none',
        hint: f.secret ? maskSecret(value ?? null) : value ?? null,
      };
    }
    const u = this.usage.get(id);
    return {
      ...p.info,
      configured: this.isConfigured(id),
      enabled: this.isEnabled(id),
      credentialHints: hints,
      models: this.models(id),
      usage: { jobs: u?.jobs ?? 0, succeeded: u?.succeeded ?? 0, failed: u?.failed ?? 0, secondsGenerated: u?.secondsGenerated ?? 0, lastUsedAt: u?.lastUsedAt ?? null },
    };
  }

  /** IDs of AI providers that are configured and enabled. Empty → demo mode. */
  configuredAiProviders(): string[] {
    return this.list()
      .filter((p) => p.info.isAI && this.isConfigured(p.info.id) && this.isEnabled(p.info.id))
      .map((p) => p.info.id);
  }

  async recordUsage(id: string, outcome: 'submitted' | 'succeeded' | 'failed', seconds = 0): Promise<void> {
    const cur = this.usage.get(id) ?? { id, jobs: 0, succeeded: 0, failed: 0, secondsGenerated: 0, lastUsedAt: null };
    await this.usage.put({
      ...cur,
      jobs: cur.jobs + (outcome === 'submitted' ? 1 : 0),
      succeeded: cur.succeeded + (outcome === 'succeeded' ? 1 : 0),
      failed: cur.failed + (outcome === 'failed' ? 1 : 0),
      secondsGenerated: cur.secondsGenerated + seconds,
      lastUsedAt: new Date().toISOString(),
    });
  }

  context(id: string, signal: AbortSignal): ProviderContext {
    const assets = this.assets;
    const config = this.config;
    return {
      creds: this.credentials(id),
      fetch: this.fetchImpl,
      assets,
      config,
      settings: this.settings.get(),
      signal,
      assetPath(assetId) {
        const a = assets.get(assetId);
        if (!a) throw new ProviderError(`Asset ${assetId} not found`, 400);
        return assets.filePath(a);
      },
      publicAssetUrl(assetId) {
        const a = assets.get(assetId);
        if (!a || !config.publicBaseUrl) return null;
        return `${config.publicBaseUrl.replace(/\/$/, '')}/media/${a.id}/${a.fileName}`;
      },
      async assetDataUri(assetId, opts = {}) {
        const a = assets.get(assetId);
        if (!a) throw new ProviderError(`Asset ${assetId} not found`, 400);
        if (a.type !== 'image') throw new ProviderError(`${a.name} is not an image`, 400);
        const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
        const maxDim = opts.maxDim ?? 2048;
        let file = assets.filePath(a);
        let mime = a.mime;
        let tmp: string | null = null;
        if (a.sizeBytes > maxBytes || (a.width ?? 0) > maxDim || (a.height ?? 0) > maxDim || a.mime === 'image/webp') {
          tmp = assets.tempFile('.jpg');
          await runFfmpeg(['-i', file, '-vf', `scale='min(${maxDim},iw)':'min(${maxDim},ih)':force_original_aspect_ratio=decrease`, '-q:v', '3', '-frames:v', '1', tmp]);
          file = tmp;
          mime = 'image/jpeg';
        }
        try {
          const data = await fs.readFile(file);
          if (data.length > maxBytes) throw new ProviderError('Reference image is too large for this provider even after downscaling', 400);
          return `data:${mime};base64,${data.toString('base64')}`;
        } finally {
          if (tmp) await fs.rm(tmp, { force: true });
        }
      },
    };
  }
}
