import { describe, expect, it, vi } from 'vitest';
import { request, requestJson } from '../../server/providers/http';
import { ProviderError } from '../../server/providers/types';

function res(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

describe('provider HTTP client (mocked)', () => {
  it('retries 429 responses honouring Retry-After, then succeeds', async () => {
    const f = vi.fn().mockResolvedValueOnce(res(429, { error: 'slow down' }, { 'retry-after': '0' })).mockResolvedValueOnce(res(200, { ok: true }));
    const out = await requestJson<{ ok: boolean }>(f as unknown as typeof fetch, 'https://x.test', { method: 'GET' }, { retries: 2 });
    expect(out.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('does not retry authentication failures and explains them', async () => {
    const f = vi.fn().mockResolvedValue(res(401, { detail: 'Invalid token' }));
    await expect(request(f as unknown as typeof fetch, 'https://x.test', { method: 'GET' }, { retries: 3 })).rejects.toThrow(/Authentication failed \(401\): Invalid token/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('gives up after retries on persistent 5xx', async () => {
    const f = vi.fn().mockResolvedValue(res(503, 'unavailable', { 'retry-after': '0' }));
    const err = await request(f as unknown as typeof fetch, 'https://x.test', {}, { retries: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('times out slow requests', async () => {
    const f = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    await expect(request(f, 'https://x.test', {}, { retries: 0, timeoutMs: 50 })).rejects.toThrow(/timed out/);
  });

  it('supports cancellation', async () => {
    const ctrl = new AbortController();
    const f = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const p = request(f, 'https://x.test', {}, { signal: ctrl.signal, retries: 3 });
    ctrl.abort();
    await expect(p).rejects.toThrow(/Canceled/);
  });
});
