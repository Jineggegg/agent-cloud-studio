import type { StudioLinkStatus, StudioProjectLink } from '@/shared/types.js';

// Results are reused briefly so reopening a project does not re-probe every site.
const CACHE_MS = 60_000;
const TIMEOUT_MS = 6_000;

/** Used by studio.module to tell the UI whether project links answer and whether they may be embedded in an iframe. */
export function createLinkChecker({ request = fetch, now = Date.now }: { request?: typeof fetch; now?: () => number } = {}) {
  const cache = new Map<string, { at: number; value: StudioLinkStatus }>();

  async function probe(url: string): Promise<StudioLinkStatus> {
    const started = now();
    const attempt = (method: 'HEAD' | 'GET') => request(url, { method, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    try {
      let response = await attempt('HEAD');
      // Some servers reject HEAD; a GET is still cheap because the body is never read.
      if (response.status === 405 || response.status === 501) response = await attempt('GET');
      const frameOptions = response.headers.get('x-frame-options');
      const policy = response.headers.get('content-security-policy') ?? '';
      const ancestors = /frame-ancestors\s+([^;]+)/i.exec(policy)?.[1]?.trim() ?? '';
      const frameable = !frameOptions && (!ancestors || ancestors.split(/\s+/).includes('*'));
      await response.body?.cancel().catch(() => {});
      return { url, ok: response.ok, status: response.status, latencyMs: now() - started, frameable };
    } catch {
      return { url, ok: false, status: null, latencyMs: null, frameable: false };
    }
  }

  return {
    async check(links: StudioProjectLink[]) {
      return Promise.all(links.map(async ({ url }) => {
        const hit = cache.get(url);
        if (hit && now() - hit.at < CACHE_MS) return hit.value;
        const value = await probe(url);
        cache.set(url, { at: now(), value });
        return value;
      }));
    },
  };
}
