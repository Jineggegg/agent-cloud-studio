import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { readCodexQuota } from '../quota/codex-quota.adapter.js';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const seconds = (ms: number) => Math.round(ms / 1000);

function tokenCount(timestamp: string, rateLimits: unknown) {
  return JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: rateLimits } });
}

function sessionsDirectory() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-quota-test-'));
  const day = path.join(root, '2026', '10', '02');
  mkdirSync(day, { recursive: true });
  return { root, day };
}

test('official app-server limits map to labelled windows and win over local logs', async () => {
  const { root, day } = sessionsDirectory();
  try {
    writeFileSync(path.join(day, 'rollout-a.jsonl'), `${tokenCount('2026-10-02T11:59:00.000Z', { primary: { used_percent: 99, window_minutes: 300 } })}\n`);
    let calls = 0;
    const main = {
      limitId: 'codex', limitName: null,
      primary: { usedPercent: 42.44, windowDurationMins: 300, resetsAt: seconds(NOW + 3_600_000) },
      secondary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: seconds(NOW + 86_400_000) },
    };
    const snapshot = await readCodexQuota({
      now: NOW,
      sessionDirectories: [root],
      readRateLimits: async () => {
        calls++;
        return {
          rateLimits: main,
          rateLimitsByLimitId: {
            spark: { limitId: 'spark', limitName: 'Codex Spark', primary: { usedPercent: 5, windowDurationMins: 120, resetsAt: null }, secondary: null },
            codex: main,
          },
          ordinaryUsageAllowed: true,
        };
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(snapshot, {
      provider: 'codex', available: true, balances: [], source: 'official',
      observedAt: new Date(NOW).toISOString(), stale: false,
      windows: [
        { id: 'codex:primary', label: '5 小时', usedPercent: 42.4, windowMinutes: 300, resetsAt: new Date(NOW + 3_600_000).toISOString() },
        { id: 'codex:secondary', label: '每周', usedPercent: 18, windowMinutes: 10080, resetsAt: new Date(NOW + 86_400_000).toISOString() },
        { id: 'spark:primary', label: '2 小时 · Codex Spark', usedPercent: 5, windowMinutes: 120, resetsAt: null },
      ],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failing app-server falls back to the newest token_count in the most recent rollout logs', async () => {
  const { root, day } = sessionsDirectory();
  try {
    const older = path.join(day, 'rollout-older.jsonl');
    writeFileSync(older, `${tokenCount('2026-10-02T09:00:00.000Z', { primary: { used_percent: 70, window_minutes: 300, resets_at: seconds(NOW + 600_000) } })}\n`);
    utimesSync(older, new Date(NOW - 3_600_000), new Date(NOW - 3_600_000));
    writeFileSync(path.join(day, 'rollout-newer.jsonl'), [
      JSON.stringify({ timestamp: '2026-10-02T11:50:00.000Z', type: 'session_meta', payload: { id: 'x' } }),
      tokenCount('2026-10-02T11:52:00.000Z', { primary: { used_percent: 10, window_minutes: 300 } }),
      tokenCount('2026-10-02T11:55:00.000Z', {
        limit_id: 'codex',
        primary: { used_percent: 31.25, window_minutes: 300, resets_at: seconds(NOW + 7_200_000) },
        secondary: { used_percent: 12, window_minutes: 10080, resets_in_seconds: 3600 },
      }),
      tokenCount('2026-10-02T11:56:00.000Z', null),
      JSON.stringify({ timestamp: '2026-10-02T11:57:00.000Z', type: 'response_item', payload: { type: 'message' } }),
      '{"timestamp":"2026-10-02T11:58:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_li',
    ].join('\n'));
    const snapshot = await readCodexQuota({
      now: NOW,
      sessionDirectories: [path.join(root, 'missing'), root],
      readRateLimits: async () => { throw new Error('not signed in'); },
    });
    assert.equal(snapshot.source, 'local-log');
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.stale, false);
    assert.equal(snapshot.observedAt, '2026-10-02T11:55:00.000Z');
    assert.match(snapshot.note ?? '', /官方接口/);
    assert.deepEqual(snapshot.windows, [
      { id: 'codex:primary', label: '5 小时', usedPercent: 31.3, windowMinutes: 300, resetsAt: new Date(NOW + 7_200_000).toISOString() },
      // Old logs give a relative reset, counted from the event time.
      { id: 'codex:secondary', label: '每周', usedPercent: 12, windowMinutes: 10080, resetsAt: '2026-10-02T12:55:00.000Z' },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('old log readings are stale, only the file tail is read, and no data means unavailable', async () => {
  const { root, day } = sessionsDirectory();
  try {
    const file = path.join(day, 'rollout-old.jsonl');
    writeFileSync(file, `${tokenCount('2026-10-02T10:00:00.000Z', { primary: { used_percent: 50, window_minutes: 90 } })}\n`);
    const old = await readCodexQuota({ now: NOW, sessionDirectories: [root], readRateLimits: null });
    assert.equal(old.stale, true);
    assert.equal(old.windows[0].label, '1.5 小时');
    assert.doesNotMatch(old.note ?? '', /官方接口/);

    // The only token_count sits before the last 256 KiB, so the bounded tail read never sees it.
    const filler = `${JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1000) } })}\n`.repeat(300);
    writeFileSync(file, `${tokenCount('2026-10-02T11:59:00.000Z', { primary: { used_percent: 50, window_minutes: 300 } })}\n${filler}`);
    const missing = await readCodexQuota({ now: NOW, sessionDirectories: [root], readRateLimits: async () => ({ rateLimits: null }) });
    assert.equal(missing.available, false);
    assert.equal(missing.source, 'unavailable');
    assert.deepEqual(missing.windows, []);
    assert.ok(missing.note);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
