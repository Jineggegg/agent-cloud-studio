import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { resolveClaudeRateSnapshotPath, resolveHomeRelativePath } from '@/shared/utils.js';
import type { StudioQuotaSnapshot } from '@/shared/types.js';

import { createClaudeUsageReader, readClaudeQuota } from './claude-quota.adapter.js';
import { readCodexQuota } from './codex-quota.adapter.js';
import { readDeepSeekQuota } from './deepseek-quota.adapter.js';

// Widgets poll; one minute keeps app-server spawns and balance calls rare without feeling stale.
const CACHE_MS = 60_000;
// Upper bound on any one load. It sits above Codex's 12 s official read plus its log fallback, so
// it only fires for a load that is truly stuck; without it a hung load would be shared forever.
const DEFAULT_LOAD_TIMEOUT_MS = 20_000;

type Provider = StudioQuotaSnapshot['provider'];
type CacheEntry = { version: string; settledAt: number | null; value: Promise<StudioQuotaSnapshot> };
type QuotaDependencies = {
  // The user's decrypted DeepSeek key or null (studio service `deepseekApiKey`); it never leaves the server.
  deepseekKey: (userId: number) => string | null;
  // Official Codex `account/rateLimits/read`: pass the providers barrel's `readCodexAccountRateLimits`.
  // Required on purpose so wiring cannot silently drop it; pass null to use the rollout logs only.
  codexRateLimits: Parameters<typeof readCodexQuota>[0]['readRateLimits'];
  request?: typeof fetch;
  now?: () => number;
  // Per-load deadline, mainly for tests.
  loadTimeoutMs?: number;
  // Overrides for STUDIO_CLAUDE_RATE_FILE, STUDIO_CLAUDE_CREDENTIALS_FILE, STUDIO_CLAUDE_USAGE_LAST_FILE and
  // STUDIO_CODEX_SESSIONS_DIRS, mainly for tests.
  files?: { claudeSnapshot?: string; claudeCredentials?: string; claudeUsageLast?: string; codexSessionDirectories?: string[] };
  // Override for STUDIO_CLAUDE_USAGE_API (false is "off"), mainly for tests.
  claudeUsageApi?: boolean;
};

function failed(provider: Provider, note = '读取用量时出错，请稍后重试'): StudioQuotaSnapshot {
  return { provider, available: false, windows: [], balances: [], source: 'unavailable', observedAt: null, stale: false, note };
}

// STUDIO_CODEX_SESSIONS_DIRS is a path-delimiter list (`~` and relative entries are home-based);
// Codex itself writes under $CODEX_HOME/sessions.
function codexSessionDirectoriesFromEnv() {
  const configured = (process.env.STUDIO_CODEX_SESSIONS_DIRS ?? '').split(path.delimiter).map(entry => entry.trim()).filter(Boolean);
  if (configured.length) return configured.map(resolveHomeRelativePath);
  return [path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'), 'sessions')];
}

// The credentials file of the machine's Claude login, which Studio's own Claude sessions use too:
// STUDIO_CLAUDE_CREDENTIALS_FILE (`~` and relative paths are home-based), else Claude's config directory
// (CLAUDE_CONFIG_DIR, default ~/.claude). Only its OAuth access token is read, per request.
function claudeCredentialsFileFromEnv() {
  const configured = process.env.STUDIO_CLAUDE_CREDENTIALS_FILE?.trim();
  if (configured) return resolveHomeRelativePath(configured);
  const configDirectory = process.env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(configDirectory ? resolveHomeRelativePath(configDirectory) : path.join(os.homedir(), '.claude'), '.credentials.json');
}

// Where the last good Claude usage reading survives a restart: STUDIO_CLAUDE_USAGE_LAST_FILE (`~` and relative paths
// are home-based), else claude-usage-last.json next to the snapshot file (normally ~/.claude). It holds the figures the
// widgets show (percentages, reset times, credit amounts), never the token.
function claudeUsageLastFileFromEnv(snapshotFile: string) {
  const configured = process.env.STUDIO_CLAUDE_USAGE_LAST_FILE?.trim();
  return configured ? resolveHomeRelativePath(configured) : path.join(path.dirname(snapshotFile), 'claude-usage-last.json');
}

// STUDIO_CLAUDE_USAGE_API=off (or 0 / false / no) stops Studio from calling Claude's usage API at all.
function claudeUsageApiEnabledFromEnv() {
  return !/^(off|0|false|no)$/i.test(process.env.STUDIO_CLAUDE_USAGE_API?.trim() ?? '');
}

/**
 * Used by studio.module (and the quota route tests) to build the snapshots behind GET /api/studio/quota.
 *
 * Returns Claude, Codex and DeepSeek snapshots in that order. Claude and Codex describe this
 * machine's CLI accounts and are shared by every user; DeepSeek uses the requesting user's key.
 * Each settles independently, is cached for a minute and is loaded at most once at a time
 * (concurrent callers share the pending load). A load that has not settled after 20 s resolves to
 * an unavailable snapshot, which is cached like any other result, so a stuck source cannot hold
 * the endpoint. A changed DeepSeek key invalidates its entry. Claude is read live from Claude's
 * usage API with the machine's Claude login first (each answer kept for five minutes, its plan
 * windows also copied into the snapshot file); while that API is rate limited or down, the last
 * good reading (kept in claude-usage-last.json next to the snapshot, so it survives a restart)
 * stands in, and otherwise the snapshot (claude-quota.adapter). File locations and
 * STUDIO_CLAUDE_USAGE_API come from the environment once, when the service is created.
 */
export function createQuotaService(deps: QuotaDependencies) {
  const now = deps.now ?? Date.now;
  const request = deps.request ?? fetch;
  const loadTimeoutMs = deps.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
  const claudeSnapshot = deps.files?.claudeSnapshot ?? resolveClaudeRateSnapshotPath();
  const codexSessionDirectories = deps.files?.codexSessionDirectories ?? codexSessionDirectoriesFromEnv();
  // One reader for the service's lifetime, so its own answer cache, in-flight guard, backoff and last good reading
  // hold across loads; it reads the saved reading back as it is created, and copies each successful answer's
  // 5-hour and weekly windows into the snapshot file for local tools.
  const claudeUsage = createClaudeUsageReader({
    credentialsFile: deps.files?.claudeCredentials ?? claudeCredentialsFileFromEnv(),
    enabled: deps.claudeUsageApi ?? claudeUsageApiEnabledFromEnv(),
    lastReadingFile: deps.files?.claudeUsageLast ?? claudeUsageLastFileFromEnv(claudeSnapshot),
    snapshotFile: claudeSnapshot,
    request,
    now,
  });
  const cache = new Map<string, CacheEntry>();

  // The abandoned load keeps running in the background; the Codex reader stops its own child
  // process at its deadline, and file reads cannot block because special files are refused.
  function loadWithDeadline(provider: Provider, load: () => Promise<StudioQuotaSnapshot>) {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<StudioQuotaSnapshot>(resolve => {
      timer = setTimeout(() => resolve(failed(provider, '读取用量超时，请稍后重试')), loadTimeoutMs);
    });
    const settled = Promise.resolve().then(load).catch(() => failed(provider));
    return Promise.race([settled, deadline]).finally(() => clearTimeout(timer));
  }

  function cached(key: string, version: string, provider: Provider, load: () => Promise<StudioQuotaSnapshot>) {
    const hit = cache.get(key);
    if (hit && hit.version === version && (hit.settledAt === null || now() - hit.settledAt < CACHE_MS)) return hit.value;
    const entry: CacheEntry = { version, settledAt: null, value: Promise.resolve(failed(provider)) };
    entry.value = loadWithDeadline(provider, load).then(snapshot => {
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
      return Promise.resolve(failed('deepseek', '无法读取已保存的 DeepSeek 密钥，请重新设置'));
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
        cached('claude', '', 'claude', () => readClaudeQuota({ snapshotFile: claudeSnapshot, now: now(), usage: claudeUsage })),
        cached('codex', '', 'codex', () => readCodexQuota({ readRateLimits: deps.codexRateLimits, sessionDirectories: codexSessionDirectories, now: now() })),
        deepseek(userId),
      ]);
    },
  };
}
