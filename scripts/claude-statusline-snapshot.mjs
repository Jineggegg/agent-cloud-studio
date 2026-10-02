#!/usr/bin/env node
// Claude Code statusLine command for Agent Cloud Studio.
//
// Claude Code pipes a JSON description of the session to this script on stdin
// and shows whatever it prints as the status line. When that JSON carries
// plan usage (rate_limits.five_hour / seven_day, Claude.ai subscriptions only),
// the figures are saved for Studio's home-screen quota widget:
//   ~/.claude/studio-rate-limits.json   (override: STUDIO_CLAUDE_RATE_FILE)
//   { observedAt, source: "statusline", five_hour?, seven_day? }
//   each window { used_percentage (0..100), resets_at (Unix seconds), observed_at }
// A relative or ~ override is anchored at the home directory, never at the
// current directory: this script runs in whichever project Claude Code has
// open, while the server reads from its own directory (resolveHomeRelativePath).
// The Studio server writes the same file from its own Claude sessions, so the
// shape must match server/shared/utils.ts (recordClaudeRateLimitEvent).
//
// Enable it in ~/.claude/settings.json:
//   "statusLine": { "type": "command", "command": "node /path/to/scripts/claude-statusline-snapshot.mjs" }
//
// It must never break Claude Code: every failure is swallowed and a minimal
// line is still printed. Only percentages and reset times are stored.
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WINDOWS = [
  { key: 'five_hour', short: '5h' },
  { key: 'seven_day', short: '周' },
];
// The status line refreshes often; an unchanged reading is rewritten at most this often.
const REWRITE_UNCHANGED_MS = 60_000;
// Same bound as the server (CLAUDE_RATE_SNAPSHOT_MAX_BYTES); the real file is a few hundred bytes.
const MAX_SNAPSHOT_BYTES = 64 * 1024;

// Mirrors resolveHomeRelativePath in server/shared/utils.ts.
function snapshotPath() {
  const configured = process.env.STUDIO_CLAUDE_RATE_FILE?.trim();
  if (!configured) return path.join(os.homedir(), '.claude', 'studio-rate-limits.json');
  if (configured === '~') return os.homedir();
  return path.resolve(os.homedir(), configured.startsWith('~/') ? configured.slice(2) : configured);
}

function readInput() {
  if (process.stdin.isTTY) return {};
  try {
    const parsed = JSON.parse(readFileSync(0, 'utf8') || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Claude Code reports `utilization * 100` uncapped, so an over-limit window can exceed 100.
function percentage(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(100, Math.round(value * 10) / 10) : null;
}

// Unix seconds as documented; milliseconds and ISO strings are tolerated.
function resetSeconds(value) {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : Math.round(parsed / 1000);
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value > 1e12 ? value / 1000 : value);
}

// Opened non-blocking and checked through the descriptor, so a FIFO or device at
// the path is skipped instead of hanging the status line (mirrors the server's
// readSmallRegularFile).
function readSmallRegularFile(file) {
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0));
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) return '';
    const buffer = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return length > MAX_SNAPSHOT_BYTES ? '' : buffer.toString('utf8', 0, length);
  } finally {
    closeSync(descriptor);
  }
}

function readExisting(file) {
  try {
    const parsed = JSON.parse(readSmallRegularFile(file));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveSnapshot(windows, now) {
  const file = snapshotPath();
  const existing = readExisting(file);
  const unchanged = Object.entries(windows).every(([key, window]) =>
    existing[key]?.used_percentage === window.used_percentage && existing[key]?.resets_at === window.resets_at);
  const age = now - Date.parse(existing.observedAt ?? '');
  if (unchanged && existing.source === 'statusline' && age >= 0 && age < REWRITE_UNCHANGED_MS) return;

  const observedAt = new Date(now).toISOString();
  const next = { observedAt, source: 'statusline' };
  for (const { key } of WINDOWS) {
    if (windows[key]) next[key] = { ...windows[key], observed_at: observedAt };
    else if (existing[key] && typeof existing[key] === 'object') next[key] = existing[key];
  }
  // One level only (normally ~/.claude): recursive mkdir can spin forever on
  // special filesystems, and a statusLine command must never hang.
  try {
    mkdirSync(path.dirname(file));
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const temporary = `${file}.${process.pid}.${now}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function main() {
  const input = readInput();
  const now = Date.now();
  const windows = {};
  for (const { key } of WINDOWS) {
    const window = input.rate_limits?.[key];
    const used = percentage(window?.used_percentage);
    if (used !== null) windows[key] = { used_percentage: used, resets_at: resetSeconds(window.resets_at) };
  }
  if (Object.keys(windows).length) {
    try {
      saveSnapshot(windows, now);
    } catch {
      // The widget simply keeps its previous reading.
    }
  }

  const model = typeof input.model?.display_name === 'string' && input.model.display_name.trim()
    ? input.model.display_name.trim()
    : 'Claude';
  const parts = [model];
  for (const { key, short } of WINDOWS) {
    if (windows[key]) parts.push(`${short} ${Math.round(windows[key].used_percentage)}%`);
  }
  if (parts.length === 1 && typeof input.workspace?.current_dir === 'string' && input.workspace.current_dir) {
    parts.push(path.basename(input.workspace.current_dir));
  }
  return parts.join(' · ');
}

let line = 'Claude';
try {
  line = main();
} catch {
  // Fall through to the minimal line.
}
try {
  process.stdout.write(`${line}\n`);
} catch {
  // Nothing sensible left to do.
}
