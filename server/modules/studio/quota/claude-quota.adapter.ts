import {
  CLAUDE_RATE_SNAPSHOT_MAX_BYTES,
  readEpochMilliseconds,
  readObjectRecord,
  readSmallRegularFile,
} from '@/shared/utils.js';
import type { StudioQuotaSnapshot, StudioQuotaWindow } from '@/shared/types.js';

// The snapshot only refreshes while Claude is in use; after this it is shown but flagged.
const OBSERVATION_STALE_MS = 6 * 60 * 60_000;
// The two plan windows, as both the usage API and the snapshot name them.
const PLAN_WINDOWS = [
  { key: 'five_hour', label: '5 小时', minutes: 300 },
  { key: 'seven_day', label: '每周', minutes: 10080 },
] as const;

// The read-only query behind Claude Code's /usage. It accepts the claude.ai OAuth login only (not an API key).
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const USAGE_BETA = 'oauth-2025-04-20';
const USAGE_TIMEOUT_MS = 5_000;
// Widgets poll every minute; one answer serves every caller for this long.
const USAGE_CACHE_MS = 60_000;
// After a refusal or an outage the API is left alone this long (a 429 may ask for longer, up to the cap).
const USAGE_BACKOFF_MS = 5 * 60_000;
const USAGE_MAX_BACKOFF_MS = 60 * 60_000;
// The real answer is a few hundred bytes; anything far larger is not one.
const USAGE_RESPONSE_MAX_CHARS = 64 * 1024;
// The credentials file also holds MCP servers' OAuth sessions, so it may be a few KB; this is a generous bound.
const CREDENTIALS_MAX_BYTES = 1024 * 1024;
// A token this close to its expiry is treated as expired: the Claude CLI, which owns the refresh, renews it first.
const EXPIRY_MARGIN_MS = 60_000;
// An OAuth access token is one run of printable ASCII; anything else could not go into a header anyway.
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;

const SNAPSHOT_HINT = '可以在 ~/.claude/settings.json 的 statusLine 中运行 scripts/claude-statusline-snapshot.mjs，或在 Studio 里完成一次 Claude 对话后显示。';
const ENABLE_HINT = `Studio 会自动用本机的 Claude 登录读取用量（未登录、登录已过期或使用 API 密钥登录时读不到）；也${SNAPSHOT_HINT}`;

// Why the usage API gave no figures this time; each is shown to the owner ahead of the snapshot hint.
const USAGE_NOTES = {
  disabled: '已关闭从 Claude 登录读取用量（STUDIO_CLAUDE_USAGE_API=off）。',
  signedOut: '本机没有 Claude 登录，无法自动读取用量。',
  unreadable: 'Claude 登录凭据文件无法读取，无法自动读取用量。',
  notSubscription: '本机的 Claude 没有用订阅账号登录（API 密钥登录没有 5 小时 / 每周限额）。',
  expired: 'Claude 登录已过期，下次运行 Claude 时会自动续期；在此之前无法自动读取用量。',
  rejected: 'Claude 登录未被接受（可能已退出登录），5 分钟后再试。',
  rateLimited: 'Claude 用量查询过于频繁，稍后再试。',
  unavailable: 'Claude 用量接口暂时无法访问，稍后再试。',
  empty: 'Claude 账号没有返回 5 小时 / 每周用量（API 密钥登录没有这些限额）。',
} as const;

type UsageReading =
  | { kind: 'windows'; windows: StudioQuotaWindow[]; observedAt: number }
  | { kind: 'skipped'; note: string };
type Credential = { kind: 'token'; accessToken: string; expiresAt: number | null } | { kind: 'skipped'; note: string };
type SnapshotReading =
  | { kind: 'snapshot'; snapshot: StudioQuotaSnapshot }
  | { kind: 'missing' }
  | { kind: 'empty' }
  | { kind: 'problem'; note: string };

function unavailable(note: string): StudioQuotaSnapshot {
  return { provider: 'claude', available: false, windows: [], balances: [], source: 'unavailable', observedAt: null, stale: false, note };
}

// Fits both UsageReading and Credential.
function skipped(note: string): { kind: 'skipped'; note: string } {
  return { kind: 'skipped', note };
}

// Reads the OAuth access token the Claude CLI keeps in its credentials file. Error messages are never kept:
// a JSON syntax error quotes the text it choked on, which here is the token itself.
async function readCredential(credentialsFile: string, now: number): Promise<Credential> {
  let raw: string;
  try {
    raw = await readSmallRegularFile(credentialsFile, CREDENTIALS_MAX_BYTES);
  } catch (error) {
    return skipped((error as { code?: unknown } | null)?.code === 'ENOENT' ? USAGE_NOTES.signedOut : USAGE_NOTES.unreadable);
  }
  let oauth: Record<string, unknown> | null;
  try {
    oauth = readObjectRecord(readObjectRecord(JSON.parse(raw))?.claudeAiOauth);
  } catch {
    return skipped(USAGE_NOTES.unreadable);
  }
  const accessToken = typeof oauth?.accessToken === 'string' ? oauth.accessToken.trim() : '';
  if (!accessToken) return skipped(USAGE_NOTES.notSubscription);
  if (!TOKEN_PATTERN.test(accessToken)) return skipped(USAGE_NOTES.unreadable);
  // Milliseconds in the file; never refreshed here, so a passed expiry simply means "not now".
  const expiresAt = readEpochMilliseconds(oauth?.expiresAt);
  if (expiresAt !== null && expiresAt - EXPIRY_MARGIN_MS <= now) return skipped(USAGE_NOTES.expired);
  return { kind: 'token', accessToken, expiresAt };
}

// `{ five_hour: { utilization: 0..100, resets_at: ISO | null } | null, seven_day: …, …unknown }`.
function usageWindows(payload: Record<string, unknown>): StudioQuotaWindow[] {
  const windows: StudioQuotaWindow[] = [];
  for (const { key, label, minutes } of PLAN_WINDOWS) {
    const window = readObjectRecord(payload[key]);
    const used = window?.utilization;
    if (!window || typeof used !== 'number' || !Number.isFinite(used)) continue;
    const resetsAtMs = readEpochMilliseconds(window.resets_at);
    windows.push({
      id: key,
      label,
      usedPercent: Math.min(100, Math.max(0, Math.round(used * 10) / 10)),
      windowMinutes: minutes,
      resetsAt: resetsAtMs === null ? null : new Date(resetsAtMs).toISOString(),
    });
  }
  return windows;
}

// Seconds from a 429's Retry-After, or null; an HTTP date is not worth parsing for a widget.
function retryAfterMs(response: Response) {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/**
 * Used by the Studio quota service to read Claude plan usage live, the way Claude Code's /usage does:
 * `GET https://api.anthropic.com/api/oauth/usage` with the claude.ai OAuth access token from the
 * credentials file the machine's Claude login (and so Studio's own Claude sessions) uses.
 *
 * - The token is read from the file on each request and only ever placed in that request's
 *   Authorization header: it is never logged, returned, cached or written anywhere, and failures
 *   are reported as fixed notes, never as error messages (which could quote it).
 * - An expired token is not used and never refreshed (the Claude CLI owns the refresh); the
 *   reading is then skipped so the caller falls back to the snapshot.
 * - At most one request is in flight; an answer is reused for a minute. A refusal (401/403), a 429,
 *   a 5xx, a timeout (5 s), a network error or a malformed answer backs off for five minutes. A
 *   401/403 backoff ends early once the CLI has stored a different login (another expiry time).
 * - `enabled` false (STUDIO_CLAUDE_USAGE_API=off) skips every request. `read` never rejects.
 */
export function createClaudeUsageReader(options: {
  credentialsFile: string;
  enabled: boolean;
  request: typeof fetch;
  now: () => number;
  timeoutMs?: number;
}) {
  const timeoutMs = options.timeoutMs ?? USAGE_TIMEOUT_MS;
  let answer: { reading: UsageReading; until: number } | null = null;
  // `expiresAt` set: the backoff belongs to that login (a refused token) and ends when the login changes.
  let backoff: { until: number; note: string; login: { expiresAt: number | null } | null } | null = null;
  let inFlight: Promise<UsageReading> | null = null;

  function fail(note: string, reason: string, login: { expiresAt: number | null } | null, delayMs = USAGE_BACKOFF_MS): UsageReading {
    backoff = { until: options.now() + delayMs, note, login };
    // The reason is a fixed phrase or a status code: nothing from the response or the credentials.
    console.warn(`[quota] Claude usage API ${reason}; next attempt in ${Math.round(delayMs / 60_000)} min`);
    return skipped(note);
  }

  async function request(accessToken: string, expiresAt: number | null): Promise<UsageReading> {
    const controller = new AbortController();
    // The race still returns on time if a request ignores its signal.
    const abandoned = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    });
    abandoned.catch(() => {});
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await Promise.race([
        options.request(USAGE_URL, {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': USAGE_BETA, Accept: 'application/json' },
          signal: controller.signal,
          redirect: 'error',
        }),
        abandoned,
      ]);
    } catch {
      clearTimeout(timer);
      return fail(USAGE_NOTES.unavailable, controller.signal.aborted ? 'timed out' : 'request failed', null);
    }
    try {
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const status = response.status;
        if (status === 401 || status === 403) return fail(USAGE_NOTES.rejected, `returned ${status}`, { expiresAt });
        if (status === 429) {
          const delay = Math.min(USAGE_MAX_BACKOFF_MS, Math.max(USAGE_BACKOFF_MS, retryAfterMs(response) ?? 0));
          return fail(USAGE_NOTES.rateLimited, 'returned 429', null, delay);
        }
        return fail(USAGE_NOTES.unavailable, `returned ${status}`, null);
      }
      const text = await Promise.race([response.text(), abandoned]);
      let payload: Record<string, unknown> | null = null;
      try {
        payload = text.length <= USAGE_RESPONSE_MAX_CHARS ? readObjectRecord(JSON.parse(text)) : null;
      } catch {
        payload = null;
      }
      if (!payload) return fail(USAGE_NOTES.unavailable, 'returned a malformed answer', null);
      const observedAt = options.now();
      backoff = null;
      const windows = usageWindows(payload);
      const reading: UsageReading = windows.length ? { kind: 'windows', windows, observedAt } : skipped(USAGE_NOTES.empty);
      answer = { reading, until: observedAt + USAGE_CACHE_MS };
      return reading;
    } catch {
      return fail(USAGE_NOTES.unavailable, controller.signal.aborted ? 'timed out' : 'answer could not be read', null);
    } finally {
      clearTimeout(timer);
    }
  }

  async function load(): Promise<UsageReading> {
    const credential = await readCredential(options.credentialsFile, options.now());
    if (credential.kind === 'skipped') return credential;
    const current = backoff;
    if (current && options.now() < current.until && (!current.login || current.login.expiresAt === credential.expiresAt)) {
      return skipped(current.note);
    }
    return request(credential.accessToken, credential.expiresAt);
  }

  return {
    /** Live windows, or why there are none this time (the caller then falls back to the snapshot). */
    read(): Promise<UsageReading> {
      if (!options.enabled) return Promise.resolve(skipped(USAGE_NOTES.disabled));
      if (answer && options.now() < answer.until) return Promise.resolve(answer.reading);
      inFlight ??= load().catch(() => skipped(USAGE_NOTES.unavailable)).finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}

// The statusLine / SDK snapshot (`{ observedAt, source, five_hour?, seven_day? }`, `resets_at` in Unix
// seconds, optional per-window `observed_at`).
async function readSnapshot(snapshotFile: string, now: number): Promise<SnapshotReading> {
  let record: Record<string, unknown> | null;
  try {
    record = readObjectRecord(JSON.parse(await readSmallRegularFile(snapshotFile, CLAUDE_RATE_SNAPSHOT_MAX_BYTES)));
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') return { kind: 'missing' };
    if (code === 'FILE_TOO_LARGE') return { kind: 'problem', note: 'Claude 用量快照文件过大，已忽略' };
    if (code === 'NOT_A_REGULAR_FILE') return { kind: 'problem', note: 'Claude 用量快照路径不是普通文件，已忽略' };
    return { kind: 'problem', note: '无法读取 Claude 用量快照文件' };
  }
  if (!record) return { kind: 'problem', note: 'Claude 用量快照文件格式无效' };

  const observedMs = readEpochMilliseconds(record.observedAt);
  const windows: StudioQuotaWindow[] = [];
  // The oldest per-window observation decides freshness, so an old weekly figure is not hidden by a fresh 5-hour one.
  let oldestObservedMs = observedMs;
  for (const { key, label, minutes } of PLAN_WINDOWS) {
    const window = readObjectRecord(record[key]);
    const used = window?.used_percentage;
    if (!window || typeof used !== 'number' || !Number.isFinite(used)) continue;
    const resetsAtMs = readEpochMilliseconds(window.resets_at);
    const windowObservedMs = readEpochMilliseconds(window.observed_at) ?? observedMs;
    if (windowObservedMs !== null && (oldestObservedMs === null || windowObservedMs < oldestObservedMs)) oldestObservedMs = windowObservedMs;
    windows.push({
      id: key,
      label,
      usedPercent: Math.min(100, Math.max(0, Math.round(used * 10) / 10)),
      windowMinutes: minutes,
      resetsAt: resetsAtMs === null ? null : new Date(resetsAtMs).toISOString(),
    });
  }
  if (!windows.length) return { kind: 'empty' };

  const resetPassed = windows.some(window => window.resetsAt !== null && Date.parse(window.resetsAt) <= now);
  return {
    kind: 'snapshot',
    snapshot: {
      provider: 'claude',
      available: true,
      windows,
      balances: [],
      source: record.source === 'sdk-event' ? 'sdk-event' : 'statusline',
      observedAt: observedMs === null ? null : new Date(observedMs).toISOString(),
      stale: resetPassed || oldestObservedMs === null || now - oldestObservedMs > OBSERVATION_STALE_MS,
    },
  };
}

/**
 * Used by the Studio quota service to describe Claude plan usage for the home-screen widget.
 *
 * With a `usage` reader (createClaudeUsageReader), the live figures from the machine's Claude login
 * come first (`source: 'usage-api'`). When they cannot be read (signed out, expired login, API-key
 * login, the API refusing or down, or STUDIO_CLAUDE_USAGE_API=off), the snapshot written by the
 * Claude Code statusLine script or by Studio's own Agent SDK sessions is used, and if that is missing
 * too, the note says why and how to enable one. A snapshot used as the fallback carries the reason
 * as its note. An oversized snapshot or anything but a regular file (a FIFO would block a plain read
 * forever) is refused without being read. The snapshot is stale once a window's reset time has
 * passed or any window was observed more than six hours ago. Never throws.
 */
export async function readClaudeQuota(input: {
  snapshotFile: string;
  now: number;
  usage?: ReturnType<typeof createClaudeUsageReader> | null;
}): Promise<StudioQuotaSnapshot> {
  let usageNote: string | null = null;
  if (input.usage) {
    const reading = await input.usage.read().catch(() => skipped(USAGE_NOTES.unavailable));
    if (reading.kind === 'windows') {
      return {
        provider: 'claude',
        available: true,
        windows: reading.windows,
        balances: [],
        source: 'usage-api',
        observedAt: new Date(reading.observedAt).toISOString(),
        stale: reading.windows.some(window => window.resetsAt !== null && Date.parse(window.resetsAt) <= input.now),
      };
    }
    usageNote = reading.note;
  }

  const snapshot = await readSnapshot(input.snapshotFile, input.now);
  // With a known reason the general "Studio reads your login" sentence would only repeat it.
  const hint = usageNote ? `${usageNote}${SNAPSHOT_HINT}` : ENABLE_HINT;
  switch (snapshot.kind) {
    case 'snapshot':
      return usageNote ? { ...snapshot.snapshot, note: usageNote } : snapshot.snapshot;
    case 'missing':
      return unavailable(usageNote ? hint : `尚未记录 Claude 用量。${hint}`);
    case 'empty':
      return unavailable(usageNote ? hint : `快照中还没有 Claude 套餐用量（API 密钥登录没有 5 小时 / 每周限额）。${hint}`);
    case 'problem':
      return unavailable(usageNote ? `${usageNote}${snapshot.note}` : snapshot.note);
  }
}
