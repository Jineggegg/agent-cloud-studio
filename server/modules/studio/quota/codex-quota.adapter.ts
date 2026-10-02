import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { readEpochMilliseconds, readObjectRecord } from '@/shared/utils.js';
import type { StudioQuotaSnapshot, StudioQuotaWindow } from '@/shared/types.js';

// The app-server answers within a second or two once started; a slow start must not hold the widget.
const DEFAULT_OFFICIAL_TIMEOUT_MS = 12_000;
// A rollout log only updates while Codex is in use, so older readings are shown but flagged.
const LOG_STALE_MS = 15 * 60_000;
// Bounds on log scanning: files stat'ed per directory, files opened, and bytes read from each tail.
const LOG_FILES_TO_STAT = 400;
const LOG_FILES_TO_READ = 4;
const LOG_TAIL_BYTES = 256 * 1024;

type RateWindow = { usedPercent: number; windowMinutes: number | null; resetsAtMs: number | null };
type RateBucket = { id: string; name: string | null; primary: RateWindow | null; secondary: RateWindow | null };
type LogReading = { observedMs: number; rateLimits: unknown };
// The providers barrel's `readCodexAccountRateLimits`, or a fake; it must stop work once `signal` aborts.
type OfficialRateLimitReader = (options: { signal: AbortSignal }) => Promise<unknown>;

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Accepts the app-server's camelCase window and the rollout log's snake_case one.
// Old logs only carry `resets_in_seconds`, which is relative to the event time.
function rateWindow(value: unknown, observedMs: number | null): RateWindow | null {
  const record = readObjectRecord(value);
  const used = finiteNumber(record?.usedPercent ?? record?.used_percent);
  if (!record || used === null) return null;
  const minutes = finiteNumber(record.windowDurationMins ?? record.window_minutes ?? record.window_duration_mins);
  let resetsAtMs = readEpochMilliseconds(record.resetsAt ?? record.resets_at);
  const resetsIn = finiteNumber(record.resetsInSeconds ?? record.resets_in_seconds);
  if (resetsAtMs === null && resetsIn !== null && observedMs !== null) resetsAtMs = observedMs + resetsIn * 1000;
  return {
    usedPercent: Math.min(100, Math.max(0, Math.round(used * 10) / 10)),
    windowMinutes: minutes !== null && minutes > 0 ? Math.round(minutes) : null,
    resetsAtMs,
  };
}

function rateBucket(value: unknown, fallbackId: string, observedMs: number | null): RateBucket | null {
  const record = readObjectRecord(value);
  if (!record) return null;
  const primary = rateWindow(record.primary, observedMs);
  const secondary = rateWindow(record.secondary, observedMs);
  if (!primary && !secondary) return null;
  const id = record.limitId ?? record.limit_id;
  const name = record.limitName ?? record.limit_name;
  return {
    id: typeof id === 'string' && id ? id : fallbackId,
    name: typeof name === 'string' && name ? name : null,
    primary,
    secondary,
  };
}

// The two plan windows Codex uses get names; anything else is described in hours.
function windowLabel(minutes: number | null) {
  if (minutes === null) return '用量';
  if (minutes === 300) return '5 小时';
  if (minutes === 10080) return '每周';
  return `${Number((minutes / 60).toFixed(1))} 小时`;
}

function quotaWindows(buckets: RateBucket[]): StudioQuotaWindow[] {
  const windows: StudioQuotaWindow[] = [];
  buckets.forEach((bucket, index) => {
    for (const [slot, window] of [['primary', bucket.primary], ['secondary', bucket.secondary]] as const) {
      if (!window) continue;
      // The first bucket is the account's main Codex allowance; extra buckets (a model with its own limit) are named.
      const suffix = index === 0 ? '' : ` · ${bucket.name ?? bucket.id}`;
      windows.push({
        id: `${bucket.id}:${slot}`,
        label: `${windowLabel(window.windowMinutes)}${suffix}`,
        usedPercent: window.usedPercent,
        windowMinutes: window.windowMinutes,
        resetsAt: window.resetsAtMs === null ? null : new Date(window.resetsAtMs).toISOString(),
      });
    }
  });
  return windows;
}

// `rateLimits` is the backward-compatible main bucket; `rateLimitsByLimitId` may add more, keyed by limit id.
function officialBuckets(result: unknown): RateBucket[] {
  const record = readObjectRecord(result);
  if (!record) return [];
  const buckets: RateBucket[] = [];
  const main = rateBucket(record.rateLimits, 'codex', null);
  if (main) buckets.push(main);
  const byLimitId = readObjectRecord(record.rateLimitsByLimitId) ?? {};
  const keys = Object.keys(byLimitId).sort((a, b) => Number(b === 'codex') - Number(a === 'codex') || a.localeCompare(b));
  for (const key of keys) {
    const extra = rateBucket(byLimitId[key], key, null);
    if (extra && !buckets.some(bucket => bucket.id === extra.id)) buckets.push(extra);
  }
  return buckets;
}

// The deadline aborts the signal handed to the reader, which is what lets the real reader kill
// its app-server child; the race still returns on time if a reader ignores the signal.
async function readOfficialBeforeDeadline(read: OfficialRateLimitReader, milliseconds: number): Promise<unknown> {
  const controller = new AbortController();
  const abandoned = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  });
  const timer = setTimeout(() => controller.abort(), milliseconds);
  try {
    return await Promise.race([read({ signal: controller.signal }), abandoned]);
  } finally {
    clearTimeout(timer);
  }
}

// Codex nests rollouts as YYYY/MM/DD/rollout-*.jsonl. Names are visited newest first and the
// number of files stat'ed is capped, so a years-old history never turns into a full scan.
async function newestRolloutFiles(directories: string[]) {
  const found: { file: string; mtimeMs: number }[] = [];
  for (const root of directories) {
    let budget = LOG_FILES_TO_STAT;
    const walk = async (directory: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => b.name.localeCompare(a.name));
      for (const entry of entries) {
        if (budget <= 0) return;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory() && depth < 4) {
          await walk(full, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          budget--;
          try {
            found.push({ file: full, mtimeMs: (await stat(full)).mtimeMs });
          } catch {
            // Rotated away between readdir and stat.
          }
        }
      }
    };
    await walk(root, 0);
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, LOG_FILES_TO_READ);
}

async function readTail(file: string) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    // The first line of a partial read is cut mid-way; drop it.
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await handle.close();
  }
}

// The newest `event_msg` whose payload is a `token_count` carrying `rate_limits`.
function newestTokenCount(text: string, fallbackMs: number): LogReading | null {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line.includes('"token_count"') || !line.includes('rate_limits')) continue;
    try {
      const entry = readObjectRecord(JSON.parse(line));
      const payload = readObjectRecord(entry?.payload);
      if (entry?.type !== 'event_msg' || payload?.type !== 'token_count' || !readObjectRecord(payload.rate_limits)) continue;
      return { observedMs: readEpochMilliseconds(entry.timestamp) ?? fallbackMs, rateLimits: payload.rate_limits };
    } catch {
      // A line still being written, or not JSON.
    }
  }
  return null;
}

async function newestLogReading(directories: string[]) {
  let newest: LogReading | null = null;
  for (const { file, mtimeMs } of await newestRolloutFiles(directories)) {
    try {
      const reading = newestTokenCount(await readTail(file), mtimeMs);
      if (reading && (!newest || reading.observedMs > newest.observedMs)) newest = reading;
    } catch {
      // Unreadable file: try the next one.
    }
  }
  return newest;
}

function resetPassed(windows: StudioQuotaWindow[], now: number) {
  return windows.some(window => window.resetsAt !== null && Date.parse(window.resetsAt) <= now);
}

/**
 * Used by the Studio quota service to describe Codex plan usage for the home-screen widget.
 *
 * Tries the official app-server `account/rateLimits/read` first (`readRateLimits`, null to skip),
 * then the newest `token_count` event in recent rollout logs under `sessionDirectories`.
 * The official read gets `officialTimeoutMs` (12 s by default; tests shorten it); when that
 * passes, the signal given to `readRateLimits` is aborted and the logs are used instead.
 * Never throws: every failure ends in a snapshot whose `note` explains what is missing.
 */
export async function readCodexQuota(input: {
  readRateLimits: OfficialRateLimitReader | null;
  sessionDirectories: string[];
  now: number;
  officialTimeoutMs?: number;
}): Promise<StudioQuotaSnapshot> {
  const { now } = input;
  let officialFailed = false;
  if (input.readRateLimits) {
    try {
      const result = await readOfficialBeforeDeadline(input.readRateLimits, input.officialTimeoutMs ?? DEFAULT_OFFICIAL_TIMEOUT_MS);
      const windows = quotaWindows(officialBuckets(result));
      if (windows.length) {
        const exhausted = readObjectRecord(result)?.ordinaryUsageAllowed === false;
        return {
          provider: 'codex', available: true, windows, balances: [], source: 'official',
          observedAt: new Date(now).toISOString(), stale: resetPassed(windows, now),
          ...(exhausted ? { note: '已达到 Codex 套餐用量上限' } : {}),
        };
      }
      officialFailed = true;
    } catch {
      officialFailed = true;
    }
  }

  const reading = await newestLogReading(input.sessionDirectories).catch(() => null);
  const bucket = reading ? rateBucket(reading.rateLimits, 'codex', reading.observedMs) : null;
  const windows = bucket ? quotaWindows([bucket]) : [];
  if (reading && windows.length) {
    return {
      provider: 'codex', available: true, windows, balances: [], source: 'local-log',
      observedAt: new Date(reading.observedMs).toISOString(),
      stale: now - reading.observedMs > LOG_STALE_MS || resetPassed(windows, now),
      note: officialFailed ? '官方接口暂不可用，显示最近一次 Codex 会话记录的用量' : '显示最近一次 Codex 会话记录的用量',
    };
  }
  return {
    provider: 'codex', available: false, windows: [], balances: [], source: 'unavailable', observedAt: null, stale: false,
    note: '暂无 Codex 用量：请确认 Codex 已登录 ChatGPT 账号，并至少完成过一次对话',
  };
}
