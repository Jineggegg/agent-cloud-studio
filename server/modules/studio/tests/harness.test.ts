import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { createHarnessService } from '../harness.service.js';
import { createHarnessRouter } from '../harness.routes.js';

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const MINUTE = 60_000;

function tempHome(name: string) {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), name)));
}
function write(file: string, content: string, mtime?: number) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mtime !== undefined) utimesSync(file, mtime / 1000, mtime / 1000);
}
const jsonl = (...lines: unknown[]) => `${lines.map(line => JSON.stringify(line)).join('\n')}\n`;

// A Claude Code registry entry and, when `transcriptAt` is given, its transcript.
function claudeSession(home: string, entry: Record<string, unknown>, transcriptAt?: number) {
  write(path.join(home, '.claude', 'sessions', `${entry.pid}.json`), JSON.stringify(entry));
  if (transcriptAt !== undefined) {
    const folder = String(entry.cwd).replace(/[^a-zA-Z0-9]/g, '-');
    write(path.join(home, '.claude', 'projects', folder, `${entry.sessionId}.jsonl`), '{}\n', transcriptAt);
  }
}
// A Codex rollout in today's day folder, with its session_meta line and the given events.
function codexRollout(home: string, id: string, meta: Record<string, unknown>, events: Record<string, unknown>[], mtime: number) {
  const day = new Date(NOW);
  const folder = path.join(home, '.codex', 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
  write(path.join(folder, `rollout-2026-10-03T10-00-00-${id}.jsonl`), jsonl(
    { timestamp: '2026-10-03T10:00:00.000Z', type: 'session_meta', payload: { id, thread_source: 'user', ...meta } },
    ...events.map(payload => ({ timestamp: '2026-10-03T11:00:00.000Z', type: 'event_msg', payload })),
  ), mtime);
}

function service(homes: { machine: 'wsl' | 'windows'; home: string }[], studioRuns = new Set<string>()) {
  return createHarnessService({
    homes, linuxHome: '/home/owner', now: () => NOW,
    studioRuns: async () => studioRuns,
    href: sessionId => `/work/p/s/${sessionId}`,
  });
}

test('Claude sessions on WSL count only while their process lives, and link to the workbench', async () => {
  const home = tempHome('harness-wsl-');
  try {
    claudeSession(home, { pid: process.pid, sessionId: 'busy-1', cwd: '/home/owner/projects/site', status: 'busy', name: '修首页', entrypoint: 'cli', startedAt: NOW - 60 * MINUTE, statusUpdatedAt: NOW - 5 * MINUTE, updatedAt: NOW - 5 * MINUTE });
    // A pid that cannot exist: the registry file outlived its process.
    claudeSession(home, { pid: 2 ** 22 + 7, sessionId: 'dead-1', cwd: '/home/owner', status: 'busy', updatedAt: NOW });
    const { tasks, machines } = await service([{ machine: 'wsl', home }], new Set(['busy-1'])).tasks();
    assert.deepEqual(machines, ['wsl']);
    assert.equal(tasks.length, 1);
    assert.deepEqual(
      { state: tasks[0].state, title: tasks[0].title, directory: tasks[0].directory, client: tasks[0].client, href: tasks[0].href, startedAt: tasks[0].startedAt },
      { state: 'running', title: '修首页', directory: '~/projects/site', client: 'Studio', href: '/work/p/s/busy-1', startedAt: new Date(NOW - 5 * MINUTE).toISOString() },
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Windows Claude sessions stand on how recently their transcript moved, and never link to the workbench', async () => {
  const home = tempHome('harness-win-');
  try {
    const unc = '\\\\wsl.localhost\\ubuntu\\home\\owner\\projects\\studio';
    claudeSession(home, { pid: 101, sessionId: 'win-busy', cwd: unc, status: 'busy', name: 'v7 安全', entrypoint: 'claude-desktop', updatedAt: NOW - 90 * MINUTE }, NOW - 2 * MINUTE);
    // Busy, but nothing written for an hour: a crash left the status behind, so it is only an open session now.
    claudeSession(home, { pid: 102, sessionId: 'win-stale', cwd: 'C:\\Users\\owner\\work', status: 'busy', updatedAt: NOW - 70 * MINUTE }, NOW - 60 * MINUTE);
    // Untouched for a day: gone from the list.
    claudeSession(home, { pid: 103, sessionId: 'win-old', cwd: 'C:\\Users\\owner', status: 'idle', updatedAt: NOW - 24 * 60 * MINUTE });
    const { tasks } = await service([{ machine: 'windows', home }]).tasks();
    assert.deepEqual(tasks.map(task => [task.sessionId, task.state, task.client, task.href]), [
      ['win-busy', 'running', '桌面版', null],
      ['win-stale', 'idle', null, null],
    ]);
    assert.equal(tasks[0].directory, '~/projects/studio');
    assert.equal(tasks[0].updatedAt, new Date(NOW - 2 * MINUTE).toISOString());
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Codex threads run from task_started until task_complete, are named from the index and skip sub-agents', async () => {
  const home = tempHome('harness-codex-');
  try {
    write(path.join(home, '.codex', 'session_index.jsonl'), jsonl(
      { id: '01a0-run', thread_name: '旧名字' },
      { id: '01a0-run', thread_name: '排查网络' },
      { id: '01a0-done', thread_name: '注册 API Key' },
    ));
    codexRollout(home, '01a0-run', { cwd: '/home/owner/projects/net', originator: 'codex_cli_rs' },
      [{ type: 'task_started', started_at: (NOW - 3 * MINUTE) / 1000 }], NOW - MINUTE);
    codexRollout(home, '01a0-done', { cwd: 'C:\\Users\\owner\\ca', originator: 'codex_work_desktop' },
      [{ type: 'task_started', started_at: (NOW - 50 * MINUTE) / 1000 }, { type: 'task_complete', last_agent_message: '**已推送到 GitHub**，未合并。\n- 分支：[codex/x](https://github.com/o/r/tree/codex/x)' }], NOW - 40 * MINUTE);
    codexRollout(home, '01a0-sub', { cwd: '/home/owner', thread_source: 'subagent' }, [{ type: 'task_started' }], NOW - MINUTE);
    // An open turn whose rollout went quiet long ago, and long enough ago to drop off.
    codexRollout(home, '01a0-gone', { cwd: '/home/owner' }, [{ type: 'task_started' }], NOW - 4 * 60 * MINUTE);
    const { tasks } = await service([{ machine: 'wsl', home }]).tasks();
    assert.deepEqual(tasks.map(task => [task.sessionId, task.state, task.title, task.client]), [
      ['01a0-run', 'running', '排查网络', '终端'],
      ['01a0-done', 'done', '注册 API Key', '桌面版'],
    ]);
    assert.equal(tasks[0].startedAt, new Date(NOW - 3 * MINUTE).toISOString());
    assert.equal(tasks[0].summary, null);
    assert.equal(tasks[1].summary, '已推送到 GitHub，未合并。 分支：codex/x');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a missing home lists nothing, and polls within a few seconds share one scan', async () => {
  let scans = 0;
  const harness = createHarnessService({
    homes: [{ machine: 'windows', home: path.join(os.tmpdir(), 'harness-missing-home') }], linuxHome: '/home/owner', now: () => NOW,
    studioRuns: async () => { scans += 1; return new Set(); }, href: () => null,
  });
  assert.deepEqual((await harness.tasks()).tasks, []);
  await harness.tasks();
  assert.equal(scans, 1);
});

test('the tasks route needs a signed-in user', async () => {
  const harness = service([]);
  const app = express();
  app.use((req, _res, next) => { if (req.headers['x-user']) (req as express.Request & { user?: { id: number } }).user = { id: 1 }; next(); });
  app.use('/harness', createHarnessRouter(harness));
  app.use((error: { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.statusCode ?? 500).json({ success: false }); });
  const server = http.createServer(app).listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/harness/tasks`;
    assert.equal((await fetch(base)).status, 401);
    const signedIn = await fetch(base, { headers: { 'x-user': '1' } });
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.headers.get('cache-control'), 'no-store');
    assert.deepEqual(((await signedIn.json()) as { tasks: unknown[] }).tasks, []);
  } finally { server.close(); }
});
