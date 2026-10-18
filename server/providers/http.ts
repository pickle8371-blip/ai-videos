import { ProviderError } from './types.js';
import { redact } from '../logger.js';

export interface HttpOptions {
  retries?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Treat these statuses as success (e.g. 404 on cancel of an already-finished job). */
  okStatuses?: number[];
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new ProviderError('Canceled', 499));
    }, { once: true });
  });

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(120_000, secs * 1000);
  const date = Date.parse(h);
  return Number.isFinite(date) ? Math.min(120_000, Math.max(0, date - Date.now())) : null;
}

/** Pull a human-readable message out of a provider error body without echoing anything sensitive. */
export function extractErrorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const pick = (v: unknown): string | null => {
      if (!v) return null;
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return v.map((x) => pick(x)).filter(Boolean).join('; ') || null;
      if (typeof v === 'object') {
        const o = v as Record<string, unknown>;
        return pick(o.message) ?? pick(o.msg) ?? pick(o.detail) ?? pick(o.error) ?? pick(o.title) ?? null;
      }
      return String(v);
    };
    return redact(pick(j.error) ?? pick(j.detail) ?? pick(j.message) ?? pick(j.failure) ?? body.slice(0, 300));
  } catch {
    return redact(body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300));
  }
}

/**
 * fetch with timeout, cancellation, and retries on 429/5xx/network errors
 * (exponential backoff honouring Retry-After). Returns the Response on success.
 */
export async function request(f: typeof fetch, url: string, init: RequestInit, opts: HttpOptions = {}): Promise<Response> {
  const retries = opts.retries ?? 3;
  let attempt = 0;
  for (;;) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), opts.timeoutMs ?? 60_000);
    const onAbort = () => ctrl.abort(new Error('canceled'));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    let res: Response;
    try {
      res = await f(url, { ...init, signal: ctrl.signal });
    } catch (err) {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) throw new ProviderError('Canceled', 499);
      const timedOut = ctrl.signal.aborted;
      if (attempt < retries) {
        attempt++;
        await sleep(Math.min(30_000, 1000 * 2 ** attempt), opts.signal);
        continue;
      }
      throw new ProviderError(timedOut ? 'Provider request timed out' : `Network error contacting provider: ${redact((err as Error).message)}`, 504, true);
    }
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    if (res.ok || opts.okStatuses?.includes(res.status)) return res;
    const body = await res.text().catch(() => '');
    const msg = extractErrorMessage(body) || res.statusText;
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      attempt++;
      const wait = retryAfterMs(res) ?? Math.min(30_000, 1000 * 2 ** attempt);
      await sleep(wait, opts.signal);
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new ProviderError(`Authentication failed (${res.status}): ${msg}. Check the API key in Settings → Providers.`, res.status, false);
    if (res.status === 429) throw new ProviderError(`Rate limited by provider: ${msg}`, 429, true, retryAfterMs(res));
    if (res.status === 402) throw new ProviderError(`Provider billing/credits problem (402): ${msg}`, 402, false);
    throw new ProviderError(`Provider error ${res.status}: ${msg}`, res.status, retryable);
  }
}

export async function requestJson<T>(f: typeof fetch, url: string, init: RequestInit, opts: HttpOptions = {}): Promise<T> {
  const res = await request(f, url, init, opts);
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(`Provider returned invalid JSON: ${text.slice(0, 200)}`, 502);
  }
}

export function jsonInit(method: string, headers: Record<string, string>, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}
