/**
 * Outbound HTTP helper for provider adapters: timeout, retries with
 * exponential backoff on 429/5xx, and a per-provider minimum interval between
 * requests (simple client-side rate limiting). Never logs query strings,
 * because many providers put API keys there.
 */
import { logger } from '../../../utils/logger.js';

export class ProviderError extends Error {
  constructor(message, { status = null, retryable = false, code = 'PROVIDER_ERROR' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

const lastCall = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson(url, { provider, timeoutMs = 10000, retries = 2, minIntervalMs = 0, fetchImpl = globalThis.fetch } = {}) {
  const safeUrl = (() => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return '[invalid-url]'; } })();
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = (lastCall.get(provider) || 0) + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall.set(provider, Date.now());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) {
        throw new ProviderError(`${provider} responded ${res.status}`, { status: res.status, retryable: true, code: res.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM' });
      }
      if (!res.ok) throw new ProviderError(`${provider} responded ${res.status}`, { status: res.status });
      return await res.json();
    } catch (err) {
      const e = err.name === 'AbortError'
        ? new ProviderError(`${provider} request timed out`, { retryable: true, code: 'TIMEOUT' })
        : err instanceof ProviderError ? err : new ProviderError(`${provider} request failed: ${err.message}`, { retryable: true, code: 'NETWORK' });
      logger.warn({ provider, url: safeUrl, attempt, code: e.code }, 'Provider request failed');
      if (!e.retryable || attempt === retries) throw e;
      await sleep(Math.min(30000, 1000 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ProviderError(`${provider} request failed`);
}
