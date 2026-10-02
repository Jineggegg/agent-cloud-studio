import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  readEpochMilliseconds,
  readSmallRegularFile,
  recordClaudeRateLimitEvent,
  resolveClaudeRateSnapshotPath,
  resolveHomeRelativePath,
} from '@/shared/utils.js';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');

test('epoch readings accept Unix seconds, milliseconds and ISO strings', () => {
  assert.equal(readEpochMilliseconds(1_790_000_000), 1_790_000_000_000);
  assert.equal(readEpochMilliseconds(1_790_000_000_123), 1_790_000_000_123);
  assert.equal(readEpochMilliseconds('2026-10-02T12:00:00.000Z'), NOW);
  for (const invalid of [0, -5, Number.NaN, 'soon', null, undefined, {}]) assert.equal(readEpochMilliseconds(invalid), null);
});

test('configured paths are anchored at the home directory, never at the working directory', () => {
  const home = os.homedir();
  assert.equal(resolveHomeRelativePath('~'), home);
  assert.equal(resolveHomeRelativePath('~/.claude/x.json'), path.join(home, '.claude', 'x.json'));
  assert.equal(resolveHomeRelativePath('studio-rate.json'), path.join(home, 'studio-rate.json'));
  assert.equal(resolveHomeRelativePath('./a/../b.json'), path.join(home, 'b.json'));
  assert.equal(resolveHomeRelativePath('/tmp/custom-rate.json'), path.resolve('/tmp/custom-rate.json'));
});

test('the snapshot path honours STUDIO_CLAUDE_RATE_FILE, expanding ~ and relative values', () => {
  const previous = process.env.STUDIO_CLAUDE_RATE_FILE;
  try {
    process.env.STUDIO_CLAUDE_RATE_FILE = '/tmp/custom-rate.json';
    assert.equal(resolveClaudeRateSnapshotPath(), path.resolve('/tmp/custom-rate.json'));
    // A systemd Environment= line passes ~ through literally.
    process.env.STUDIO_CLAUDE_RATE_FILE = ' ~/.claude/x.json ';
    assert.equal(resolveClaudeRateSnapshotPath(), path.join(os.homedir(), '.claude', 'x.json'));
    process.env.STUDIO_CLAUDE_RATE_FILE = 'studio-rate.json';
    assert.equal(resolveClaudeRateSnapshotPath(), path.join(os.homedir(), 'studio-rate.json'));
    delete process.env.STUDIO_CLAUDE_RATE_FILE;
    assert.equal(resolveClaudeRateSnapshotPath(), path.join(os.homedir(), '.claude', 'studio-rate-limits.json'));
  } finally {
    if (previous === undefined) delete process.env.STUDIO_CLAUDE_RATE_FILE;
    else process.env.STUDIO_CLAUDE_RATE_FILE = previous;
  }
});

test('small regular files are read and special or oversized files are refused without blocking', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'small-regular-file-'));
  const file = path.join(directory, 'snapshot.json');
  try {
    writeFileSync(file, '{"ok":true}');
    assert.equal(await readSmallRegularFile(file, 64), '{"ok":true}');
    writeFileSync(file, 'x'.repeat(65));
    await assert.rejects(readSmallRegularFile(file, 64), { code: 'FILE_TOO_LARGE' });
    await assert.rejects(readSmallRegularFile(directory, 64), { code: 'NOT_A_REGULAR_FILE' });
    await assert.rejects(readSmallRegularFile(path.join(directory, 'missing.json'), 64), { code: 'ENOENT' });
    // A character device reports size 0 and never ends; a plain readFile would read it forever.
    if (process.platform !== 'win32') {
      await assert.rejects(readSmallRegularFile('/dev/zero', 64), { code: 'NOT_A_REGULAR_FILE' });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('SDK utilization is always a fraction: over-limit readings become 100%, not 1%', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'claude-rate-utilization-'));
  const file = path.join(directory, 'studio-rate-limits.json');
  const usedFor = async (info: Record<string, unknown>) => {
    await recordClaudeRateLimitEvent({ rateLimitType: 'five_hour', ...info }, { filePath: file, now: () => NOW });
    return JSON.parse(readFileSync(file, 'utf8')).five_hour.used_percentage;
  };
  try {
    assert.equal(await usedFor({ status: 'rejected', utilization: 1.04 }), 100);
    assert.equal(await usedFor({ status: 'allowed_warning', utilization: 1 }), 100);
    assert.equal(await usedFor({ status: 'allowed', utilization: 0.009 }), 0.9);
    assert.equal(await usedFor({ status: 'allowed', utilization: 0 }), 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('SDK rate limit events merge atomically into the snapshot and never throw', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'claude-rate-snapshot-'));
  const file = path.join(directory, 'nested', 'studio-rate-limits.json');
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  try {
    // An earlier statusline write is kept for the window the event does not touch.
    await recordClaudeRateLimitEvent({ status: 'allowed', rateLimitType: 'seven_day', utilization: 0.1, resetsAt: 1_790_600_000 }, { filePath: file, now: () => NOW - 1000 });
    // Parallel events from two sessions must both land.
    await Promise.all([
      recordClaudeRateLimitEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.4243, resetsAt: 1_790_000_000_000 }, { filePath: file, now: () => NOW }),
      recordClaudeRateLimitEvent({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.9, resetsAt: 1_790_600_000 }, { filePath: file, now: () => NOW }),
    ]);
    assert.deepEqual(read(), {
      observedAt: new Date(NOW).toISOString(), source: 'sdk-event',
      five_hour: { used_percentage: 42.4, resets_at: 1_790_000_000, observed_at: new Date(NOW).toISOString() },
      seven_day: { used_percentage: 90, resets_at: 1_790_600_000, observed_at: new Date(NOW).toISOString() },
    });

    const before = readFileSync(file, 'utf8');
    // Events the snapshot has no slot or no figure for are skipped.
    await recordClaudeRateLimitEvent({ status: 'allowed', rateLimitType: 'overage', utilization: 0.5 }, { filePath: file });
    await recordClaudeRateLimitEvent({ status: 'allowed', rateLimitType: 'five_hour' }, { filePath: file });
    await recordClaudeRateLimitEvent(null, { filePath: file });
    assert.equal(readFileSync(file, 'utf8'), before);
    await recordClaudeRateLimitEvent({ status: 'rejected', rateLimitType: 'five_hour' }, { filePath: file, now: () => NOW });
    assert.equal(read().five_hour.used_percentage, 100);
    assert.equal(read().five_hour.resets_at, null);
    assert.deepEqual(readdirSync(path.dirname(file)), ['studio-rate-limits.json'], 'no temporary files are left behind');

    // A corrupt file is replaced; an unwritable target resolves quietly.
    writeFileSync(file, '{broken');
    await recordClaudeRateLimitEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.05 }, { filePath: file, now: () => NOW });
    assert.deepEqual(Object.keys(read()), ['observedAt', 'source', 'five_hour']);
    await assert.doesNotReject(recordClaudeRateLimitEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.05 }, { filePath: directory }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
