import {
  CLAUDE_RATE_SNAPSHOT_MAX_BYTES,
  readEpochMilliseconds,
  readObjectRecord,
  readSmallRegularFile,
} from '@/shared/utils.js';
import type { StudioQuotaSnapshot, StudioQuotaWindow } from '@/shared/types.js';

// The snapshot only refreshes while Claude is in use; after this it is shown but flagged.
const OBSERVATION_STALE_MS = 6 * 60 * 60_000;
const SNAPSHOT_WINDOWS = [
  { key: 'five_hour', label: '5 小时', minutes: 300 },
  { key: 'seven_day', label: '每周', minutes: 10080 },
] as const;
const ENABLE_HINT = '在 ~/.claude/settings.json 的 statusLine 中运行 scripts/claude-statusline-snapshot.mjs，或在 Studio 里完成一次 Claude 对话后即可显示。';

function unavailable(note: string): StudioQuotaSnapshot {
  return { provider: 'claude', available: false, windows: [], balances: [], source: 'unavailable', observedAt: null, stale: false, note };
}

/**
 * Used by the Studio quota service to describe Claude plan usage for the home-screen widget.
 *
 * Reads the snapshot written by the Claude Code statusLine script or by Studio's own Agent SDK
 * sessions (`{ observedAt, source, five_hour?, seven_day? }`, `resets_at` in Unix seconds, optional
 * per-window `observed_at`). A missing file explains how to enable it; an oversized file or
 * anything but a regular file (a FIFO would block a plain read forever) is refused without being
 * read. The snapshot is stale once a window's reset time has passed or any window was observed
 * more than six hours ago. Never throws.
 */
export async function readClaudeQuota(input: { snapshotFile: string; now: number }): Promise<StudioQuotaSnapshot> {
  let record: Record<string, unknown> | null;
  try {
    record = readObjectRecord(JSON.parse(await readSmallRegularFile(input.snapshotFile, CLAUDE_RATE_SNAPSHOT_MAX_BYTES)));
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') return unavailable(`尚未记录 Claude 用量。${ENABLE_HINT}`);
    if (code === 'FILE_TOO_LARGE') return unavailable('Claude 用量快照文件过大，已忽略');
    if (code === 'NOT_A_REGULAR_FILE') return unavailable('Claude 用量快照路径不是普通文件，已忽略');
    return unavailable('无法读取 Claude 用量快照文件');
  }
  if (!record) return unavailable('Claude 用量快照文件格式无效');

  const observedMs = readEpochMilliseconds(record.observedAt);
  const windows: StudioQuotaWindow[] = [];
  // The oldest per-window observation decides freshness, so an old weekly figure is not hidden by a fresh 5-hour one.
  let oldestObservedMs = observedMs;
  for (const { key, label, minutes } of SNAPSHOT_WINDOWS) {
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
  if (!windows.length) return unavailable(`快照中还没有 Claude 套餐用量（API 密钥登录没有 5 小时 / 每周限额）。${ENABLE_HINT}`);

  const resetPassed = windows.some(window => window.resetsAt !== null && Date.parse(window.resetsAt) <= input.now);
  return {
    provider: 'claude',
    available: true,
    windows,
    balances: [],
    source: record.source === 'sdk-event' ? 'sdk-event' : 'statusline',
    observedAt: observedMs === null ? null : new Date(observedMs).toISOString(),
    stale: resetPassed || oldestObservedMs === null || input.now - oldestObservedMs > OBSERVATION_STALE_MS,
  };
}
