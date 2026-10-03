import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CLAUDE_RATE_SNAPSHOT_MAX_BYTES,
  readEpochMilliseconds,
  readObjectRecord,
  readSmallRegularFile,
} from '@/shared/utils.js';
import type { StudioQuotaCredit, StudioQuotaSnapshot, StudioQuotaWindow } from '@/shared/types.js';

// The snapshot only refreshes while Claude is in use; after this it is shown but flagged.
const OBSERVATION_STALE_MS = 6 * 60 * 60_000;
// The two plan windows, as both the usage API and the snapshot name them.
const PLAN_WINDOWS = [
  { key: 'five_hour', label: '5 小时', minutes: 300 },
  { key: 'seven_day', label: '每周', minutes: 10080 },
] as const;
// The usage API also sends per-model windows as `<plan window>_<model>` (seven_day_opus, seven_day_sonnet, …).
const MODEL_WINDOW_KEY = /^(five_hour|seven_day)_([a-z0-9]+(?:_[a-z0-9]+)*)$/;
// Readable names for the model part of such a key; any other part is title-cased ("omelette" → "Omelette").
const MODEL_KEY_NAMES: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', oauth_apps: 'OAuth 应用' };
// Newer answers list per-model weekly limits in `limits` as `{ kind: 'weekly_scoped', scope: { model: { display_name } }, percent, resets_at }`.
const SCOPED_WEEKLY_KIND = 'weekly_scoped';
// Credit allowances the usage API reports. Their amounts are in minor units (cents), as Claude Code itself reads them.
const CREDIT_KEYS = [
  // The one-time Claude Code and Cowork credit (the desktop app's "cloud session credits"); `resets_at` is its expiry.
  { key: 'cinder_cove', label: '云端额度', endKind: 'expires' },
  // Pay-as-you-go usage beyond the plan, capped by a monthly spend limit; only shown while turned on.
  { key: 'extra_usage', label: '额外用量', endKind: 'resets' },
] as const;
// ISO 4217 currencies without minor units, whose amounts are not divided by 100.
const ZERO_DECIMAL_CURRENCIES = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
// Only key names shaped like identifiers are logged; anything else is counted, never echoed.
const LOGGABLE_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

// The read-only query behind Claude Code's /usage. It accepts the claude.ai OAuth login only (not an API key).
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const USAGE_BETA = 'oauth-2025-04-20';
const USAGE_TIMEOUT_MS = 5_000;
// Widgets poll every minute; one answer serves every caller for this long (the owner prefers few requests).
const USAGE_CACHE_MS = 5 * 60_000;
// After a refusal or an outage the API is left alone this long; it is also the first wait of a run of 429s.
const USAGE_BACKOFF_MS = 5 * 60_000;
// Each 429 in a row doubles the wait (5, 10, 20, 40 min) up to this cap; a longer Retry-After wins, up to the cap too.
const USAGE_MAX_BACKOFF_MS = 60 * 60_000;
// The last good reading, standing in while the API cannot be read, is flagged as possibly out of date after this.
const LAST_READING_STALE_MS = 15 * 60_000;
// A saved reading is a few windows and credits (about 2 KB); a file far larger is not one of ours.
const LAST_READING_MAX_BYTES = 64 * 1024;
const LAST_READING_VERSION = 1;
// A saved reading timed further ahead than this (a wrong clock, a hand-edited file) is ignored.
const LAST_READING_CLOCK_SKEW_MS = 5 * 60_000;
// Bounds on what a saved reading may hold, well above any real answer.
const LAST_READING_MAX_ITEMS = 64;
const STORED_TEXT_MAX_CHARS = 80;
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

type UsageCause = keyof typeof USAGE_NOTES;

/**
 * The failures for which the last good reading may stand in, each with the start of the note that says so. None of
 * them says anything about which account is signed in or what it may use: a 429, an outage, a timeout or a malformed
 * answer (also while backing off from one), and an access token that expired before the Claude CLI renewed it (the
 * same login, renewed on the CLI's next run).
 *
 * A refusal (401/403) is left out on purpose. The login in the file was turned down, so it may have been signed out or
 * replaced by another account: earlier figures could belong to someone else, and showing them would hide that the
 * owner has to sign in again. A statusLine or SDK snapshot (written by whichever login Claude Code actually runs with)
 * or the refusal note is shown instead; the saved reading is kept and replaced by the next good one. The other causes
 * in ACCOUNT_IN_DOUBT are left out for the same reason, and STUDIO_CLAUDE_USAGE_API=off never has a last reading.
 */
const LAST_READING_REASONS: Partial<Record<UsageCause, string>> = {
  rateLimited: 'Claude 用量接口暂时限流',
  unavailable: 'Claude 用量接口暂时无法访问',
  expired: 'Claude 登录已过期（下次运行 Claude 时会自动续期）',
};

// After these, earlier usage figures may belong to another account or contradict the latest answer, so neither the
// last good reading nor Studio's own copy of it in the snapshot file (source 'usage-api') is shown.
const ACCOUNT_IN_DOUBT = new Set<UsageCause>(['rejected', 'signedOut', 'notSubscription', 'unreadable', 'empty']);

// Figures from one successful answer, as shown to the owner; never the token or anything else from the credentials.
type LastUsageReading = { windows: StudioQuotaWindow[]; credits: StudioQuotaCredit[]; observedAt: number };
type Skipped = { kind: 'skipped'; cause: UsageCause; note: string };
type UsageReading = ({ kind: 'windows' } & LastUsageReading) | Skipped;
type Credential = { kind: 'token'; accessToken: string; expiresAt: number | null } | Skipped;
type SnapshotReading =
  | { kind: 'snapshot'; snapshot: StudioQuotaSnapshot }
  | { kind: 'missing' }
  | { kind: 'empty' }
  | { kind: 'problem'; note: string };

function unavailable(note: string): StudioQuotaSnapshot {
  return { provider: 'claude', available: false, windows: [], balances: [], source: 'unavailable', observedAt: null, stale: false, note };
}

// Fits both UsageReading and Credential.
function skipped(cause: UsageCause): Skipped {
  return { kind: 'skipped', cause, note: USAGE_NOTES[cause] };
}

// Reads the OAuth access token the Claude CLI keeps in its credentials file. Error messages are never kept:
// a JSON syntax error quotes the text it choked on, which here is the token itself.
async function readCredential(credentialsFile: string, now: number): Promise<Credential> {
  let raw: string;
  try {
    raw = await readSmallRegularFile(credentialsFile, CREDENTIALS_MAX_BYTES);
  } catch (error) {
    return skipped((error as { code?: unknown } | null)?.code === 'ENOENT' ? 'signedOut' : 'unreadable');
  }
  let oauth: Record<string, unknown> | null;
  try {
    oauth = readObjectRecord(readObjectRecord(JSON.parse(raw))?.claudeAiOauth);
  } catch {
    return skipped('unreadable');
  }
  const accessToken = typeof oauth?.accessToken === 'string' ? oauth.accessToken.trim() : '';
  if (!accessToken) return skipped('notSubscription');
  if (!TOKEN_PATTERN.test(accessToken)) return skipped('unreadable');
  // Milliseconds in the file; never refreshed here, so a passed expiry simply means "not now".
  const expiresAt = readEpochMilliseconds(oauth?.expiresAt);
  if (expiresAt !== null && expiresAt - EXPIRY_MARGIN_MS <= now) return skipped('expired');
  return { kind: 'token', accessToken, expiresAt };
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// A percentage as the widgets show it: 0..100 with one decimal (an account over its limit reports more than 100).
function clampPercent(value: number) {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

function isoOrNull(value: unknown) {
  const milliseconds = readEpochMilliseconds(value);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

// "oauth_apps" → "OAuth 应用", "omelette" → "Omelette".
function modelKeyName(part: string) {
  return MODEL_KEY_NAMES[part] ?? part.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// `{ utilization: 0..100, resets_at: ISO | null }`; null (a limit the account does not have) gives no window.
function usageWindow(value: unknown, window: Omit<StudioQuotaWindow, 'usedPercent' | 'resetsAt'>): StudioQuotaWindow | null {
  const record = readObjectRecord(value);
  const used = finiteNumber(record?.utilization);
  if (!record || used === null) return null;
  return { ...window, usedPercent: clampPercent(used), resetsAt: isoOrNull(record.resets_at) };
}

/**
 * Every window in a usage answer: the plan-wide 5-hour and weekly ones first, then per-model ones from
 * `<plan window>_<model>` keys (sorted by key) and from `limits` entries of kind `weekly_scoped`. A model
 * already listed under a key is not repeated from `limits`; null and malformed entries are skipped.
 */
function usageWindows(payload: Record<string, unknown>): StudioQuotaWindow[] {
  const windows: StudioQuotaWindow[] = [];
  for (const { key, label, minutes } of PLAN_WINDOWS) {
    const window = usageWindow(payload[key], { id: key, label, windowMinutes: minutes });
    if (window) windows.push(window);
  }
  for (const key of Object.keys(payload).sort()) {
    const match = MODEL_WINDOW_KEY.exec(key);
    if (!match) continue;
    const plan = PLAN_WINDOWS.find(item => item.key === match[1])!;
    const model = modelKeyName(match[2]);
    const window = usageWindow(payload[key], { id: key, label: `${plan.label} · ${model}`, windowMinutes: plan.minutes, model });
    if (window) windows.push(window);
  }
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  for (const entry of limits) {
    const record = readObjectRecord(entry);
    const name = readObjectRecord(readObjectRecord(record?.scope)?.model)?.display_name;
    const used = finiteNumber(record?.percent ?? record?.utilization);
    if (!record || record.kind !== SCOPED_WEEKLY_KIND || typeof name !== 'string' || used === null) continue;
    const model = name.trim().slice(0, 40);
    const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!slug || windows.some(window => window.windowMinutes === 10080 && window.model?.toLowerCase() === model.toLowerCase())) continue;
    windows.push({
      id: `${SCOPED_WEEKLY_KIND}:${slug}`, label: `每周 · ${model}`, usedPercent: clampPercent(used),
      windowMinutes: 10080, resetsAt: isoOrNull(record.resets_at), model,
    });
  }
  return windows;
}

// Cents (or the currency's minor unit) to major units; null when absent.
function majorUnits(value: unknown, currency: string) {
  const amount = finiteNumber(value);
  if (amount === null) return null;
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? amount : Math.round(amount) / 100;
}

/**
 * Credit allowances in a usage answer. `extra_usage` is `{ is_enabled, monthly_limit, used_credits,
 * utilization, currency? }` (cents; `monthly_limit` null is no cap) and is skipped while turned off.
 * `cinder_cove` is `{ utilization, resets_at }`; amounts are read too if it ever carries them. A credit
 * with neither a percentage nor an amount is skipped.
 */
function usageCredits(payload: Record<string, unknown>): StudioQuotaCredit[] {
  const credits: StudioQuotaCredit[] = [];
  for (const { key, label, endKind } of CREDIT_KEYS) {
    const record = readObjectRecord(payload[key]);
    // Extra usage always says whether it is turned on; the one-time credit has no such flag.
    if (!record || ('is_enabled' in record && record.is_enabled !== true)) continue;
    const currency = typeof record.currency === 'string' && /^[A-Za-z]{3}$/.test(record.currency) ? record.currency.toUpperCase() : 'USD';
    const limit = majorUnits(record.monthly_limit ?? record.total_credits ?? record.granted_credits, currency);
    const used = majorUnits(record.used_credits, currency);
    const remaining = majorUnits(record.remaining_credits, currency) ?? (limit !== null && used !== null ? Math.max(0, Math.round((limit - used) * 100) / 100) : null);
    const utilization = finiteNumber(record.utilization);
    const usedPercent = utilization !== null ? clampPercent(utilization) : limit !== null && limit > 0 && used !== null ? clampPercent(used / limit * 100) : null;
    if (usedPercent === null && used === null && remaining === null) continue;
    credits.push({
      id: key, label, usedPercent, currency: limit !== null || used !== null || remaining !== null ? currency : null,
      limit, used, remaining, endsAt: isoOrNull(record.resets_at ?? record.expires_at), endKind,
    });
  }
  return credits;
}

// "five_hour, limits, seven_day, …": the sorted top-level key names, never a value.
function describeKeys(payload: Record<string, unknown>) {
  const keys = Object.keys(payload);
  const named = keys.filter(key => LOGGABLE_KEY.test(key)).sort();
  const other = keys.length - named.length;
  return `${named.join(', ') || '(none)'}${other ? ` (+${other} other)` : ''}`;
}

// Seconds from a 429's Retry-After, or null; an HTTP date is not worth parsing for a widget.
function retryAfterMs(response: Response) {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

// ── The last good reading, saved for the next process ──

// A non-empty string of bounded length, or null.
function storedText(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= STORED_TEXT_MAX_CHARS ? value : null;
}

// null stays null and a finite number is kept; anything else is undefined (malformed).
function storedNumber(value: unknown) {
  return value === null ? null : finiteNumber(value) ?? undefined;
}

// null stays null and a readable time string comes back as ISO; anything else is undefined (malformed).
function storedTime(value: unknown) {
  return value === null ? null : typeof value === 'string' ? isoOrNull(value) ?? undefined : undefined;
}

function storedWindow(value: unknown): StudioQuotaWindow | null {
  const record = readObjectRecord(value);
  const id = storedText(record?.id);
  const label = storedText(record?.label);
  const used = finiteNumber(record?.usedPercent);
  const windowMinutes = storedNumber(record?.windowMinutes);
  const resetsAt = storedTime(record?.resetsAt);
  const model = record?.model === undefined ? undefined : storedText(record.model);
  if (!id || !label || used === null || windowMinutes === undefined || resetsAt === undefined || model === null) return null;
  return { id, label, usedPercent: clampPercent(used), windowMinutes, resetsAt, ...(model ? { model } : {}) };
}

function storedCredit(value: unknown): StudioQuotaCredit | null {
  const record = readObjectRecord(value);
  const id = storedText(record?.id);
  const label = storedText(record?.label);
  const used = storedNumber(record?.usedPercent);
  const currency = record?.currency === null ? null : typeof record?.currency === 'string' && /^[A-Z]{3}$/.test(record.currency) ? record.currency : undefined;
  const limit = storedNumber(record?.limit);
  const spent = storedNumber(record?.used);
  const remaining = storedNumber(record?.remaining);
  const endsAt = storedTime(record?.endsAt);
  const endKind = record?.endKind === 'expires' || record?.endKind === 'resets' ? record.endKind : null;
  if (!id || !label || !endKind || used === undefined || currency === undefined || limit === undefined
    || spent === undefined || remaining === undefined || endsAt === undefined) return null;
  return { id, label, usedPercent: used === null ? null : clampPercent(used), currency, limit, used: spent, remaining, endsAt, endKind };
}

// Every entry read back, or null when the list is missing, too long or holds one malformed entry.
function storedList<T>(value: unknown, read: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > LAST_READING_MAX_ITEMS) return null;
  const items: T[] = [];
  for (const entry of value) {
    const item = read(entry);
    if (!item) return null;
    items.push(item);
  }
  return items;
}

/**
 * The reading saved by `saveLastReading`, or null when there is none or the file is not one: missing, not a small
 * regular file (read with readSmallRegularFile, so a FIFO cannot block it), not JSON, another version, a time that
 * is unreadable or too far ahead, no figures at all, or any malformed window or credit (one bad entry discards the
 * whole file, which is then no longer what this code wrote). Every entry is rebuilt field by field, so nothing else
 * in the file reaches a widget. Never throws.
 */
async function readLastReading(file: string, now: number): Promise<LastUsageReading | null> {
  let record: Record<string, unknown> | null;
  try {
    record = readObjectRecord(JSON.parse(await readSmallRegularFile(file, LAST_READING_MAX_BYTES)));
  } catch {
    return null;
  }
  if (!record || record.version !== LAST_READING_VERSION || typeof record.observedAt !== 'string') return null;
  const observedAt = readEpochMilliseconds(record.observedAt);
  if (observedAt === null || observedAt > now + LAST_READING_CLOCK_SKEW_MS) return null;
  const windows = storedList(record.windows, storedWindow);
  const credits = storedList(record.credits, storedCredit);
  if (!windows || !credits || (!windows.length && !credits.length)) return null;
  return { windows, credits, observedAt };
}

// Replaces `file` with `body` as JSON atomically, through a new owner-only (0600) temporary file and a rename, so a
// reader never sees half of it. Rejects on a disk problem.
async function replaceJsonFile(file: string, body: unknown) {
  // One level only (normally ~/.claude), as the snapshot writers do it.
  await mkdir(path.dirname(file)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const temporaryPath = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // `wx`: a fresh file, never one planted at that name beforehand.
    await writeFile(temporaryPath, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, file);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Saves the last good reading for the next process as `{ version, observedAt, windows, credits }`: only the figures
 * shown to the owner (percentages, reset times, credit amounts), never the token or anything else from the
 * credentials. Atomic (replaceJsonFile); rejects on a disk problem.
 */
async function saveLastReading(file: string, reading: LastUsageReading) {
  await replaceJsonFile(file, { version: LAST_READING_VERSION, observedAt: new Date(reading.observedAt).toISOString(), windows: reading.windows, credits: reading.credits });
}

/**
 * Copies the plan-wide 5-hour and weekly windows of a successful answer into the statusLine snapshot, so the owner's
 * local tools reading that file see the official figures too. The shape is the one scripts/claude-statusline-snapshot.mjs
 * writes (and readSnapshot reads): `observedAt` and each window's `observed_at` as ISO strings, `used_percentage`
 * 0..100 and `resets_at` in Unix seconds, with `source: 'usage-api'`.
 *
 * The statusLine script and the SDK writer (recordClaudeRateLimitEvent) write this file too, so it is read first and
 * only `observedAt`, `source` and the windows this answer has are replaced; every other field (a window the answer
 * lacks, anything a local tool added) is kept. A file that is missing or not a small regular JSON object starts
 * afresh, as with those writers. Their writes are not queued with this one, so a write landing in between can still
 * replace these windows with its own; the next answer writes them again. Nothing else from the answer (per-model
 * windows, credits) and nothing from the credentials is written. Atomic (replaceJsonFile); rejects on a disk problem.
 */
async function copyToSnapshot(file: string, reading: LastUsageReading) {
  const windows = PLAN_WINDOWS.flatMap(({ key }) => reading.windows.filter(window => window.id === key).slice(0, 1));
  if (!windows.length) return;
  let existing: Record<string, unknown> = {};
  try {
    existing = readObjectRecord(JSON.parse(await readSmallRegularFile(file, CLAUDE_RATE_SNAPSHOT_MAX_BYTES))) ?? {};
  } catch {
    // Missing, unreadable or not a plain file: start a fresh snapshot.
  }
  const observedAt = new Date(reading.observedAt).toISOString();
  const next: Record<string, unknown> = { ...existing, observedAt, source: 'usage-api' };
  for (const window of windows) {
    const resetsAtMs = window.resetsAt === null ? null : Date.parse(window.resetsAt);
    next[window.id] = { used_percentage: window.usedPercent, resets_at: resetsAtMs === null ? null : Math.round(resetsAtMs / 1000), observed_at: observedAt };
  }
  await replaceJsonFile(file, next);
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
 *   reading is then skipped so the caller falls back to the last good reading or the snapshot.
 * - At most one request is in flight; an answer is reused for five minutes. A refusal (401/403), a
 *   5xx, a timeout (5 s), a network error or a malformed answer backs off for five minutes. A
 *   401/403 backoff ends early once the CLI has stored a different login (another expiry time).
 *   429s in a row back off for 5, 10, 20, 40 and then 60 minutes each, or for as long as their
 *   Retry-After asks if that is longer (still at most 60 minutes); only a successful answer starts
 *   the run over, other failures neither extend nor end it.
 * - The last answer with figures is kept (`last`) for the caller to show while the API cannot be
 *   read. With `lastReadingFile` it is also saved there after every successful answer and read back
 *   when the reader is created; a saved answer still within its five minutes is served as the answer
 *   cache, so a restart costs no request. With `snapshotFile`, every successful answer also copies
 *   its 5-hour and weekly windows into the statusLine snapshot (copyToSnapshot). Writes run one at a
 *   time and are never awaited by a read; a failed one logs one warning (with its error code only).
 * - `enabled` false (STUDIO_CLAUDE_USAGE_API=off) skips every request and never touches either
 *   file. `read` never rejects.
 * - The answer's shape is undocumented, so the first successful answer logs (at info level) the
 *   sorted names of its top-level keys, once per reader; the quota service keeps one reader for the
 *   process's lifetime, so that is once per process. Values are never logged.
 */
export function createClaudeUsageReader(options: {
  credentialsFile: string;
  enabled: boolean;
  request: typeof fetch;
  now: () => number;
  timeoutMs?: number;
  // Where the last good reading survives a restart (the quota service: claude-usage-last.json next to the snapshot).
  lastReadingFile?: string | null;
  // The statusLine snapshot (studio-rate-limits.json) that each successful answer's plan windows are copied into.
  snapshotFile?: string | null;
}) {
  const timeoutMs = options.timeoutMs ?? USAGE_TIMEOUT_MS;
  const lastReadingFile = options.enabled ? options.lastReadingFile ?? null : null;
  const snapshotFile = options.enabled ? options.snapshotFile ?? null : null;
  let keysLogged = false;
  let answer: { reading: UsageReading; until: number } | null = null;
  // `expiresAt` set: the backoff belongs to that login (a refused token) and ends when the login changes.
  let backoff: { until: number; cause: UsageCause; login: { expiresAt: number | null } | null } | null = null;
  let inFlight: Promise<UsageReading> | null = null;
  // The last answer with figures, from this process or saved by an earlier one.
  let last: LastUsageReading | null = null;
  // 429s since the last successful answer; each one doubles the next wait.
  let rateLimitStreak = 0;
  // Saves run one after another, so an older reading can never land after a newer one.
  let saving: Promise<void> = Promise.resolve();
  // Started at once; every read waits for it, so the saved reading is back before the first request.
  const restoring = lastReadingFile ? restore(lastReadingFile).catch(() => {}) : Promise.resolve();

  async function restore(file: string) {
    const saved = await readLastReading(file, options.now());
    if (!saved || (last && last.observedAt >= saved.observedAt)) return;
    last = saved;
    const until = saved.observedAt + USAGE_CACHE_MS;
    if (!answer && options.now() < until) answer = { reading: { kind: 'windows', ...saved }, until };
  }

  // Queues one write after the others; its failure is logged with the error code only and stops nothing.
  function queueWrite(what: string, write: () => Promise<void>) {
    saving = saving.then(write).catch((error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code;
      console.warn(`[quota] Could not write ${what} (${typeof code === 'string' && LOGGABLE_KEY.test(code) ? code : 'error'})`);
    });
  }

  function remember(reading: LastUsageReading) {
    last = reading;
    if (lastReadingFile) {
      const file = lastReadingFile;
      queueWrite('the last Claude usage reading', () => saveLastReading(file, reading));
    }
    if (snapshotFile) {
      const file = snapshotFile;
      queueWrite('Claude usage to the snapshot file', () => copyToSnapshot(file, reading));
    }
  }

  function fail(cause: UsageCause, reason: string, login: { expiresAt: number | null } | null, delayMs = USAGE_BACKOFF_MS): UsageReading {
    backoff = { until: options.now() + delayMs, cause, login };
    // The reason is a fixed phrase or a status code: nothing from the response or the credentials.
    console.warn(`[quota] Claude usage API ${reason}; next attempt in ${Math.round(delayMs / 60_000)} min`);
    return skipped(cause);
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
      return fail('unavailable', controller.signal.aborted ? 'timed out' : 'request failed', null);
    }
    try {
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const status = response.status;
        if (status === 401 || status === 403) return fail('rejected', `returned ${status}`, { expiresAt });
        if (status === 429) {
          rateLimitStreak += 1;
          // 5, 10, 20, 40, then 60 minutes; the exponent is bounded so a long run cannot overflow.
          const doubled = USAGE_BACKOFF_MS * 2 ** Math.min(rateLimitStreak - 1, 8);
          const delay = Math.min(USAGE_MAX_BACKOFF_MS, Math.max(doubled, retryAfterMs(response) ?? 0));
          return fail('rateLimited', `returned 429 (${rateLimitStreak} in a row)`, null, delay);
        }
        return fail('unavailable', `returned ${status}`, null);
      }
      const text = await Promise.race([response.text(), abandoned]);
      let payload: Record<string, unknown> | null = null;
      try {
        payload = text.length <= USAGE_RESPONSE_MAX_CHARS ? readObjectRecord(JSON.parse(text)) : null;
      } catch {
        payload = null;
      }
      if (!payload) return fail('unavailable', 'returned a malformed answer', null);
      const observedAt = options.now();
      backoff = null;
      rateLimitStreak = 0;
      if (!keysLogged) {
        keysLogged = true;
        console.info(`[quota] Claude usage API answer keys: ${describeKeys(payload)}`);
      }
      const windows = usageWindows(payload);
      const credits = usageCredits(payload);
      const reading: UsageReading = windows.length || credits.length ? { kind: 'windows', windows, credits, observedAt } : skipped('empty');
      answer = { reading, until: observedAt + USAGE_CACHE_MS };
      if (reading.kind === 'windows') remember({ windows, credits, observedAt });
      return reading;
    } catch {
      return fail('unavailable', controller.signal.aborted ? 'timed out' : 'answer could not be read', null);
    } finally {
      clearTimeout(timer);
    }
  }

  async function load(): Promise<UsageReading> {
    await restoring;
    if (answer && options.now() < answer.until) return answer.reading;
    const credential = await readCredential(options.credentialsFile, options.now());
    if (credential.kind === 'skipped') return credential;
    const current = backoff;
    if (current && options.now() < current.until && (!current.login || current.login.expiresAt === credential.expiresAt)) {
      return skipped(current.cause);
    }
    return request(credential.accessToken, credential.expiresAt);
  }

  return {
    /** Live windows, or why there are none this time (the caller then shows `last` or the snapshot). */
    read(): Promise<UsageReading> {
      if (!options.enabled) return Promise.resolve(skipped('disabled'));
      if (answer && options.now() < answer.until) return Promise.resolve(answer.reading);
      inFlight ??= load().catch(() => skipped('unavailable')).finally(() => { inFlight = null; });
      return inFlight;
    },
    /** The last answer with figures (from this process or saved by an earlier one), or null; never the token. */
    last(): LastUsageReading | null {
      return last;
    },
    /** Resolves once the saved reading has been read back and every write started so far has finished (or failed). */
    async flush(): Promise<void> {
      await restoring;
      await saving;
    },
  };
}

// The statusLine / SDK / usage-API snapshot (`{ observedAt, source, five_hour?, seven_day? }`, `resets_at` in Unix
// seconds, optional per-window `observed_at`). A `usage-api` one is Studio's own copy of an answer (copyToSnapshot),
// refreshed every few minutes while the API answers, so it is flagged after 15 minutes like the last good reading.
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
  const source = record.source === 'sdk-event' || record.source === 'usage-api' ? record.source : 'statusline';
  const staleAfterMs = source === 'usage-api' ? LAST_READING_STALE_MS : OBSERVATION_STALE_MS;
  return {
    kind: 'snapshot',
    snapshot: {
      provider: 'claude',
      available: true,
      windows,
      balances: [],
      source,
      observedAt: observedMs === null ? null : new Date(observedMs).toISOString(),
      stale: resetPassed || oldestObservedMs === null || now - oldestObservedMs > staleAfterMs,
    },
  };
}

// A window past its reset time no longer describes the current window.
function resetPassed(windows: StudioQuotaWindow[], now: number) {
  return windows.some(window => window.resetsAt !== null && Date.parse(window.resetsAt) <= now);
}

function usageApiSnapshot(reading: LastUsageReading, stale: boolean, note: string | null): StudioQuotaSnapshot {
  return {
    provider: 'claude',
    available: true,
    windows: reading.windows,
    balances: [],
    ...(reading.credits.length ? { credits: reading.credits } : {}),
    source: 'usage-api',
    observedAt: new Date(reading.observedAt).toISOString(),
    stale,
    ...(note ? { note } : {}),
  };
}

function lastReadingStale(reading: LastUsageReading, now: number) {
  return now - reading.observedAt > LAST_READING_STALE_MS || resetPassed(reading.windows, now);
}

// "12 分钟前", "3 小时前", "2 天前": how long ago a reading was taken, counted from `now`.
function readingAge(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '不到 1 分钟前';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`;
}

// The last good reading stands in when there is no usable snapshot, when it is at least as recent as the snapshot,
// or when the snapshot is flagged as possibly out of date and the reading is not.
function prefersLastReading(reading: LastUsageReading, snapshot: SnapshotReading, now: number) {
  if (snapshot.kind !== 'snapshot') return true;
  if (snapshot.snapshot.stale && !lastReadingStale(reading, now)) return true;
  const snapshotAt = snapshot.snapshot.observedAt === null ? null : Date.parse(snapshot.snapshot.observedAt);
  return snapshotAt === null || reading.observedAt >= snapshotAt;
}

/**
 * Used by the Studio quota service to describe Claude plan usage for the home-screen widget.
 *
 * With a `usage` reader (createClaudeUsageReader), the live figures from the machine's Claude login
 * come first (`source: 'usage-api'`): the 5-hour and weekly windows, any per-model weekly windows
 * (each with its `model`), and any credit allowances as `credits`. When they cannot be read because
 * of a 429, an outage, a timeout, a malformed answer (also while backing off from one) or a login
 * that expired before the CLI renewed it, the reader's last good reading stands in, unless the
 * snapshot below is more recent (see prefersLastReading): still `source: 'usage-api'` with the
 * `observedAt` of that read, a note saying why and how old it is ("Claude 用量接口暂时限流，显示
 * 12 分钟前的读数。", counted from `now`), and `stale` once it is more than 15 minutes old or a
 * window's reset time has passed. A refusal (401/403) never lets it stand in (LAST_READING_REASONS
 * says why). Otherwise (signed out, API-key login, a refusal, STUDIO_CLAUDE_USAGE_API=off, or no
 * last reading), the snapshot written by the Claude Code statusLine script, by Studio's own Agent
 * SDK sessions or by this reader's successful answers (`source: 'usage-api'`, passed over with the
 * account in doubt, see ACCOUNT_IN_DOUBT) is used, and if that is missing too, the note says why and
 * how to enable one. A snapshot used as the fallback carries the reason as its note. An oversized
 * snapshot or anything but a regular file (a FIFO would block a plain read forever) is refused
 * without being read. The snapshot is stale once a window's reset time has passed or any window was
 * observed more than six hours ago (15 minutes for a `usage-api` one). Never throws.
 */
export async function readClaudeQuota(input: {
  snapshotFile: string;
  now: number;
  usage?: ReturnType<typeof createClaudeUsageReader> | null;
}): Promise<StudioQuotaSnapshot> {
  let usageNote: string | null = null;
  let usageCause: UsageCause | null = null;
  let standIn: { reading: LastUsageReading; reason: string } | null = null;
  if (input.usage) {
    const reading = await input.usage.read().catch(() => skipped('unavailable'));
    if (reading.kind === 'windows') return usageApiSnapshot(reading, resetPassed(reading.windows, input.now), null);
    usageNote = reading.note;
    usageCause = reading.cause;
    const reason = LAST_READING_REASONS[reading.cause];
    const last = reason ? input.usage.last() : null;
    if (reason && last) standIn = { reading: last, reason };
  }

  let snapshot = await readSnapshot(input.snapshotFile, input.now);
  // Studio's own copy of an earlier answer is no more trustworthy than the last good reading: with the account itself
  // in doubt it is passed over like a missing snapshot.
  if (usageCause && ACCOUNT_IN_DOUBT.has(usageCause) && snapshot.kind === 'snapshot' && snapshot.snapshot.source === 'usage-api') {
    snapshot = { kind: 'missing' };
  }
  if (standIn && prefersLastReading(standIn.reading, snapshot, input.now)) {
    const { reading, reason } = standIn;
    return usageApiSnapshot(reading, lastReadingStale(reading, input.now), `${reason}，显示 ${readingAge(input.now - reading.observedAt)}的读数。`);
  }
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
