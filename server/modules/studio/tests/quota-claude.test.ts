import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { recordClaudeRateLimitEvent } from '@/shared/utils.js';

import { readClaudeQuota } from '../quota/claude-quota.adapter.js';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const seconds = (ms: number) => Math.round(ms / 1000);

function snapshotFile() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'claude-quota-test-'));
  return { directory, file: path.join(directory, 'studio-rate-limits.json') };
}

test('a missing snapshot explains how to enable it and a malformed one is unavailable', async () => {
  const { directory, file } = snapshotFile();
  try {
    const missing = await readClaudeQuota({ snapshotFile: file, now: NOW });
    assert.equal(missing.available, false);
    assert.equal(missing.source, 'unavailable');
    assert.match(missing.note ?? '', /statusLine/);
    writeFileSync(file, '{not json');
    assert.equal((await readClaudeQuota({ snapshotFile: file, now: NOW })).available, false);
    writeFileSync(file, JSON.stringify({ observedAt: new Date(NOW).toISOString(), source: 'statusline' }));
    const empty = await readClaudeQuota({ snapshotFile: file, now: NOW });
    assert.equal(empty.available, false);
    assert.match(empty.note ?? '', /API 密钥/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('statusline snapshots map to 5-hour and weekly windows with staleness rules', async () => {
  const { directory, file } = snapshotFile();
  try {
    const fresh = {
      observedAt: new Date(NOW - 60_000).toISOString(), source: 'statusline',
      five_hour: { used_percentage: 42.04, resets_at: seconds(NOW + 3_600_000) },
      seven_day: { used_percentage: 18, resets_at: seconds(NOW + 86_400_000) },
    };
    writeFileSync(file, JSON.stringify(fresh));
    assert.deepEqual(await readClaudeQuota({ snapshotFile: file, now: NOW }), {
      provider: 'claude', available: true, balances: [], source: 'statusline',
      observedAt: new Date(NOW - 60_000).toISOString(), stale: false,
      windows: [
        { id: 'five_hour', label: '5 小时', usedPercent: 42, windowMinutes: 300, resetsAt: new Date(NOW + 3_600_000).toISOString() },
        { id: 'seven_day', label: '每周', usedPercent: 18, windowMinutes: 10080, resetsAt: new Date(NOW + 86_400_000).toISOString() },
      ],
    });

    writeFileSync(file, JSON.stringify({ ...fresh, five_hour: { used_percentage: 90, resets_at: seconds(NOW - 1000) } }));
    assert.equal((await readClaudeQuota({ snapshotFile: file, now: NOW })).stale, true, 'a passed reset makes the reading stale');

    writeFileSync(file, JSON.stringify({ ...fresh, observedAt: new Date(NOW - 7 * 3_600_000).toISOString() }));
    assert.equal((await readClaudeQuota({ snapshotFile: file, now: NOW })).stale, true, 'readings older than six hours are stale');

    writeFileSync(file, JSON.stringify({ ...fresh, seven_day: { ...fresh.seven_day, observed_at: new Date(NOW - 2 * 86_400_000).toISOString() } }));
    assert.equal((await readClaudeQuota({ snapshotFile: file, now: NOW })).stale, true, 'an old weekly window is not hidden by a fresh top-level time');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('snapshots written from SDK rate_limit_event are read back as sdk-event windows', async () => {
  const { directory, file } = snapshotFile();
  try {
    await recordClaudeRateLimitEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.25, resetsAt: seconds(NOW + 600_000) }, { filePath: file, now: () => NOW });
    await recordClaudeRateLimitEvent({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.81, resetsAt: seconds(NOW + 86_400_000) }, { filePath: file, now: () => NOW });
    const snapshot = await readClaudeQuota({ snapshotFile: file, now: NOW + 1000 });
    assert.equal(snapshot.source, 'sdk-event');
    assert.equal(snapshot.stale, false);
    assert.deepEqual(snapshot.windows.map(window => [window.id, window.usedPercent]), [['five_hour', 25], ['seven_day', 81]]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
