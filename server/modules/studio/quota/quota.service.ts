import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { resolveClaudeRateSnapshotPath } from '@/shared/utils.js';
import type { StudioQuotaSnapshot } from '@/shared/types.js';

import { readClaudeQuota } from './claude-quota.adapter.js';
import { readCodexQuota } from './codex-quota.adapter.js';
import { readDeepSeekQuota } from './deepseek-quota.adapter.js';

// Widgets poll; one minute keeps app-server spawns and balance calls rare without feeling stale.
const CACHE_MS = 60_000;

type Provider = StudioQuotaSnapshot['provider'];
type CacheEntry = { version: string; settledAt: number | null; value: Promise<StudioQuotaSnapshot> };
type QuotaDependencies = {
  // The user's decrypted DeepSeek key or null (studio service `deepseekApiKey`); it never leaves the server.
  deepseekKey: (userId: number) => string | null;
  request?: typeof fetch;
  now?: () => number;
  // Official Codex `account/rateLimits/read` (providers barrel `readCodexAccountRateLimits`); null or omitted uses logs only.
  codexRateLimits?: (() => Promise<unknown>) | null;
  // Overrides for STUDIO_CLAUDE_RATE_FILE and STUDIO_CODEX_SESSIONS_DIRS, mainly for tests.
  files?: { claudeSnapshot?: string; codexSessionDirectories?: string[] };
};

function failed(provider: Provider): StudioQuotaSnapshot {
  return { provider, available: false, windows: [], balances: [], source: 'unavailable', observedAt: null, stale: false, note: '读取用量时出错，请稍后重试' };
}

function expandHome(entry: string) {
  return entry === '~' || entry.startsWith('~/') ? path.join(os.homedir(), entry.slice(1)) : entry;
}

// STUDIO_CODEX_SESSIONS_DIRS is a path-delimiter list; Codex itself writes under $CODEX_HOME/sessions.
function codexSessionDirectoriesFromEnv() {
  const configured = (process.env.STUDIO_CODEX_SESSIONS_DIRS ?? '').split(path.delimiter).map(entry => entry.trim()).filter(Boolean);
  if (configured.length) return configured.map(expandHome);
  return [path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'), 'sessions')];
}

/**
 * Used by studio.module (and the quota route tests) to build the snapshots behind GET /api/studio/quota.
 *
 * Returns Claude, Codex and DeepSeek snapshots in that order. Claude and Codex describe this
 * machine's CLI accounts and are shared by every user; DeepSeek uses the requesting user's key.
 * Each settles independently, is cached for a minute and is loaded at most once at a time
 * (concurrent callers share the pending load). A changed DeepSeek key invalidates its entry.
 */
export function createQuotaService(deps: QuotaDependencies) {
  const now = deps.now ?? Date.now;
  const request = deps.request ?? fetch;
  const claudeSnapshot = deps.files?.claudeSnapshot ?? resolveClaudeRateSnapshotPath();
  const codexSessionDirectories = deps.files?.codexSessionDirectories ?? codexSessionDirectoriesFromEnv();
  const cache = new Map<string, CacheEntry>();

  function cached(key: string, version: string, provider: Provider, load: () => Promise<StudioQuotaSnapshot>) {
    const hit = cache.get(key);
    if (hit && hit.version === version && (hit.settledAt === null || now() - hit.settledAt < CACHE_MS)) return hit.value;
    const entry: CacheEntry = { version, settledAt: null, value: Promise.resolve(failed(provider)) };
    entry.value = Promise.resolve().then(load).catch(() => failed(provider)).then(snapshot => {
      entry.settledAt = now();
      return snapshot;
    });
    cache.set(key, entry);
    return entry.value;
  }

  function deepseek(userId: number) {
    let apiKey: string | null;
    try {
      apiKey = deps.deepseekKey(userId);
    } catch {
      return Promise.resolve({ ...failed('deepseek'), note: '无法读取已保存的 DeepSeek 密钥，请重新设置' });
    }
    const key = `deepseek:${userId}`;
    if (!apiKey) {
      cache.delete(key);
      return readDeepSeekQuota({ apiKey: null, request, now: now() });
    }
    // Only a digest is kept to notice a replaced key; the key itself is not cached.
    const version = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
    return cached(key, version, 'deepseek', () => readDeepSeekQuota({ apiKey, request, now: now() }));
  }

  return {
    async snapshots(userId: number): Promise<StudioQuotaSnapshot[]> {
      return Promise.all([
        cached('claude', '', 'claude', () => readClaudeQuota({ snapshotFile: claudeSnapshot, now: now() })),
        cached('codex', '', 'codex', () => readCodexQuota({ readRateLimits: deps.codexRateLimits ?? null, sessionDirectories: codexSessionDirectories, now: now() })),
        deepseek(userId),
      ]);
    },
  };
}
