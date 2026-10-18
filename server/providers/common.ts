import type { CapabilityRange, GenerationParams, JobRecord, ModelInfo } from '../../shared/api.js';
import type { AspectRatio } from '../../shared/project.js';
import { ProviderError } from './types.js';

export function params(job: JobRecord): GenerationParams {
  return job.params as GenerationParams;
}

export function promptOf(job: JobRecord): string {
  const p = params(job);
  return (p.compiledPrompt || p.prompt || '').trim();
}

/** Choose the closest supported duration. */
export function pickDuration(model: ModelInfo, requested: number | undefined): number {
  const d = model.capabilities.durations;
  const want = requested ?? 5;
  if (!d) return want;
  if (Array.isArray(d)) return d.reduce((best, v) => (Math.abs(v - want) < Math.abs(best - want) ? v : best), d[0]);
  const r = d as CapabilityRange;
  const step = r.step ?? 1;
  return Math.min(r.max, Math.max(r.min, Math.round(want / step) * step));
}

export function pickAspect(model: ModelInfo, requested: AspectRatio | undefined): AspectRatio {
  const list = model.capabilities.aspectRatios;
  const want = requested ?? '16:9';
  if (!list || list.length === 0) return want;
  if (list.includes(want)) return want;
  const ratio = (a: string) => {
    const [w, h] = a.split(':').map(Number);
    return w / h;
  };
  return list.reduce((best, a) => (Math.abs(ratio(a) - ratio(want)) < Math.abs(ratio(best) - ratio(want)) ? a : best), list[0]);
}

export function pickResolution(model: ModelInfo, requested: string | undefined): string | undefined {
  const list = model.capabilities.resolutions;
  if (!list || list.length === 0) return undefined;
  if (requested && list.includes(requested)) return requested;
  return list[list.length - 1];
}

export function requireCred(creds: Record<string, string>, key: string, providerName: string): string {
  const v = creds[key];
  if (!v) throw new ProviderError(`${providerName} is not configured. Add the API key in Settings → Cloud providers.`, 400);
  return v;
}

/** Fill a custom-model input template: "{{prompt}}" placeholders are replaced with job values. */
export function fillTemplate(template: unknown, values: Record<string, unknown>): unknown {
  if (typeof template === 'string') {
    const whole = /^\{\{(\w+)\}\}$/.exec(template);
    if (whole) return values[whole[1]] ?? null;
    return template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => (values[k] === undefined || values[k] === null ? '' : String(values[k])));
  }
  if (Array.isArray(template)) return template.map((t) => fillTemplate(t, values));
  if (template && typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template)) {
      const filled = fillTemplate(v, values);
      if (filled !== null && filled !== '') out[k] = filled;
    }
    return out;
  }
  return template;
}

/** Collect result URLs from arbitrary provider output JSON (string, array, {url}, {video:{url}}, ...). */
export function collectUrls(output: unknown, depth = 0): string[] {
  if (depth > 5 || output === null || output === undefined) return [];
  if (typeof output === 'string') return /^https?:\/\//.test(output) ? [output] : [];
  if (Array.isArray(output)) return output.flatMap((o) => collectUrls(o, depth + 1));
  if (typeof output === 'object') {
    const o = output as Record<string, unknown>;
    if (typeof o.url === 'string') return collectUrls(o.url, depth + 1);
    return Object.values(o).flatMap((v) => collectUrls(v, depth + 1));
  }
  return [];
}

export function extFromUrl(url: string, fallback: string): string {
  const m = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(new URL(url).pathname);
  return m ? m[1].toLowerCase() : fallback;
}
