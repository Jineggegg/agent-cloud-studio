import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import type { StudioBuildOutcome, StudioBuildRunner, StudioBuildRunSnapshot, StudioBuildTodo } from '@/shared/types.js';

import { createProjectHubService } from '../project-hub.service.js';
import { createStudioBuildsService } from '../builds.service.js';

type Start = { input: Parameters<StudioBuildRunner['start']>[0]; resolve: (outcome: StudioBuildOutcome) => void };

const flush = () => new Promise(resolve => setImmediate(resolve));

/** A fake runDetachedChatTurn seam: each started turn waits until the test settles it. */
function fakeRunner() {
  const starts: Start[] = [];
  const aborted: string[] = [];
  let snapshot: StudioBuildRunSnapshot | null = null;
  let history: StudioBuildTodo[] | null = null;
  const runner: StudioBuildRunner = {
    start: input => new Promise(resolve => starts.push({ input, resolve })),
    async abort(sessionId) { aborted.push(sessionId); return true; },
    inspect: () => snapshot,
    readChecklist: async () => history,
    environment: () => ({ mode: 'restricted', missing: ['socat'] }),
  };
  return {
    runner, starts, aborted,
    setSnapshot(value: StudioBuildRunSnapshot | null) { snapshot = value; },
    setHistory(value: StudioBuildTodo[] | null) { history = value; },
  };
}

function fixture(options: { maxParallel?: number; failGit?: boolean; home?: (root: string) => string } = {}) {
  const database = new Database(':memory:');
  const root = path.join(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'studio-builds-'))), 'projects');
  const hub = createProjectHubService({
    database,
    resolveWorkspace: async directory => ({ projectId: 'unused', path: directory }),
    listSessions: () => [],
    pendingSchedules: () => 0,
    schedule: () => ({ id: 'unused' }),
  });
  const fake = fakeRunner();
  const repositories: string[] = [];
  const sessions: { path: string; title: string }[] = [];
  const registered: string[] = [];
  const deps = {
    database, root, hub, runner: fake.runner, maxParallel: options.maxParallel, resumeDelayMs: 0, home: options.home?.(root),
    async initRepository(directory: string) {
      if (options.failGit) throw new Error('git is not installed');
      repositories.push(directory);
    },
    async resolveWorkspace(directory: string) { registered.push(directory); return { projectId: `ide-${registered.length}`, path: realpathSync(directory) }; },
    createSession(workspacePath: string, title: string) { sessions.push({ path: workspacePath, title }); return { sessionId: `session-${sessions.length}` }; },
  };
  const service = createStudioBuildsService(deps);
  const cleanup = () => { database.close(); rmSync(path.dirname(root), { recursive: true, force: true }); };
  return { database, root, hub, fake, repositories, sessions, registered, deps, service, cleanup };
}

const input = (name: string, prompt = '做一个每天打卡喝水的网页，能设置目标并查看一周统计。') => ({ name, tone: 'sage', glyph: 'sparkles', prompt });

test('a build creates a folder, a git repository, an agents project and a Claude session, then starts at once', async () => {
  const f = fixture();
  try {
    const { build, project } = await f.service.create(1, input('Habit Tracker'));
    const directory = path.join(f.root, 'habit-tracker');
    assert.ok(existsSync(directory));
    assert.deepEqual(f.repositories, [directory]);
    assert.equal(project.workspacePath, directory);
    assert.deepEqual(project.modules, ['agents']);
    assert.deepEqual(project.providers, ['claude', 'codex', 'deepseek']);
    assert.equal(project.tone, 'sage');
    assert.equal(f.hub.get(1, project.id).name, 'Habit Tracker');
    assert.deepEqual(f.sessions, [{ path: directory, title: 'Habit Tracker（AI 开发）' }]);
    assert.equal(build.state, 'building');
    assert.equal(build.hubProjectId, project.id);
    assert.equal(build.ideProjectId, 'ide-1');
    assert.equal(build.sessionId, 'session-1');
    assert.ok(build.startedAt);

    const turn = f.fake.starts[0].input;
    assert.equal(turn.userId, 1);
    assert.equal(turn.sessionId, 'session-1');
    assert.equal(turn.workspacePath, directory);
    assert.match(turn.content, /做一个每天打卡喝水的网页/);
    assert.match(turn.content, /TodoWrite/);
    assert.match(turn.content, /README/);
    assert.match(turn.content, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(turn.content, /不 git push/);

    // Progress follows the checklist; the current task is the in-progress step's present-tense wording.
    turn.onChecklist([
      { content: '搭建项目', status: 'completed' },
      { content: '实现打卡', status: 'in_progress', activeForm: '正在实现打卡' },
      { content: '写测试', status: 'pending' },
    ]);
    assert.deepEqual(
      (({ total, completed, currentTask }) => ({ total, completed, currentTask }))(f.service.get(1, build.id)),
      { total: 3, completed: 1, currentTask: '正在实现打卡' },
    );

    f.fake.starts[0].resolve({ started: true, success: true, error: null });
    await flush();
    const done = f.service.get(1, build.id);
    assert.equal(done.state, 'done');
    assert.equal(done.currentTask, null);
    assert.ok(done.finishedAt);
    assert.deepEqual(f.service.list(1).map(item => item.id), [build.id]);
  } finally { f.cleanup(); }
});

test('folder names are unique slugs, names without ASCII words become ai-app, and bad input touches nothing', async () => {
  const f = fixture();
  try {
    await f.service.create(1, input('Habit Tracker'));
    await f.service.create(1, input('Habit  Tracker!'));
    await f.service.create(1, input('记账本'));
    assert.deepEqual(readdirSync(f.root).sort(), ['ai-app', 'habit-tracker', 'habit-tracker-2']);

    await assert.rejects(f.service.create(1, { ...input('坏图标'), tone: 'neon' }), /图标无效/);
    await assert.rejects(f.service.create(1, input('', 'x')), /名称/);
    await assert.rejects(f.service.create(1, input('空描述', '   ')), /想做什么/);
    await assert.rejects(f.service.create(1, input('太长', 'x'.repeat(8001))), /8000/);
    assert.equal(readdirSync(f.root).length, 3);
    assert.equal(f.service.list(1).length, 3);
  } finally { f.cleanup(); }
});

test('two builds with the same name started together get separate folders', async () => {
  const f = fixture();
  try {
    // Folder choice and creation happen in one synchronous stretch, so concurrent requests cannot pick the same one.
    const [first, second] = await Promise.all([f.service.create(1, input('Habit Tracker')), f.service.create(1, input('Habit Tracker'))]);
    assert.deepEqual([first.project.workspacePath, second.project.workspacePath].map(folder => path.basename(folder)), ['habit-tracker', 'habit-tracker-2']);
    assert.deepEqual(readdirSync(f.root).sort(), ['habit-tracker', 'habit-tracker-2']);
  } finally { f.cleanup(); }
});

test('a builds root outside the home directory is a clear configuration error that touches nothing', async () => {
  const outside = fixture({ home: root => path.join(path.dirname(root), 'home') });
  try {
    await assert.rejects(outside.service.create(1, input('Habit Tracker')), (error: Error & { statusCode?: number }) => {
      assert.match(error.message, /STUDIO_BUILDS_ROOT 必须在家目录/);
      assert.equal(error.statusCode, 500);
      return true;
    });
    assert.equal(existsSync(outside.root), false, 'no folder was created');
    assert.deepEqual(outside.hub.list(1).map(project => project.name), ['SNR 3.0', '超级教授', 'Trading 212'], 'no icon was added');
  } finally { outside.cleanup(); }
  const inside = fixture({ home: root => path.dirname(root) });
  try {
    assert.equal((await inside.service.create(1, input('Habit Tracker'))).build.state, 'building');
    assert.deepEqual(inside.service.environment(), { mode: 'restricted', missing: ['socat'] });
  } finally { inside.cleanup(); }
});

test('a failure after the folder exists rolls back the folder and the icon', async () => {
  const f = fixture({ failGit: true });
  try {
    await assert.rejects(f.service.create(1, input('Habit Tracker')), /创建项目失败：git is not installed/);
    assert.deepEqual(readdirSync(f.root), []);
    assert.deepEqual(f.hub.list(1).map(project => project.name), ['SNR 3.0', '超级教授', 'Trading 212']);
    assert.equal(f.service.list(1).length, 0);
  } finally { f.cleanup(); }
});

test('builds beyond the parallel limit wait as queued; cancel works while queued and while building', async () => {
  const f = fixture({ maxParallel: 1 });
  try {
    const first = (await f.service.create(1, input('One'))).build;
    const second = (await f.service.create(1, input('Two'))).build;
    const third = (await f.service.create(1, input('Three'))).build;
    assert.deepEqual([first.state, second.state, third.state], ['building', 'queued', 'queued']);
    assert.equal(f.fake.starts.length, 1);

    const cancelledWhileQueued = await f.service.cancel(1, third.id);
    assert.equal(cancelledWhileQueued.state, 'failed');
    assert.equal(cancelledWhileQueued.error, '已取消');

    f.fake.starts[0].resolve({ started: true, success: false, error: 'Claude AI usage limit reached' });
    await flush();
    assert.equal(f.service.get(1, first.id).state, 'failed');
    assert.equal(f.service.get(1, first.id).error, 'Claude AI usage limit reached');
    // The freed slot goes to the next queued build, never to the cancelled one.
    assert.equal(f.fake.starts.length, 2);
    assert.equal(f.fake.starts[1].input.sessionId, second.sessionId);
    assert.equal(f.service.get(1, second.id).state, 'building');

    const stopped = await f.service.cancel(1, second.id);
    assert.deepEqual(f.fake.aborted, [second.sessionId]);
    assert.equal(stopped.state, 'failed');
    assert.equal(stopped.error, '已取消');
    // The aborted turn reporting a failure later does not overwrite the cancellation.
    f.fake.starts[1].resolve({ started: true, success: false, error: '开发已停止' });
    await flush();
    assert.equal(f.service.get(1, second.id).error, '已取消');
    await assert.rejects(f.service.cancel(1, second.id), /已经结束/);
  } finally { f.cleanup(); }
});

test('continue sends a wrapped follow-up in the same session; running builds and other users are refused', async () => {
  const f = fixture();
  try {
    const { build } = await f.service.create(1, input('Habit Tracker'));
    assert.throws(() => f.service.resume(1, build.id, '再加深色模式'), /正在开发中/);
    assert.throws(() => f.service.get(2, build.id), /不存在/);
    assert.equal(f.service.list(2).length, 0);
    f.fake.starts[0].input.onChecklist([{ content: 'A', status: 'completed' }]);
    f.fake.starts[0].resolve({ started: true, success: true, error: null });
    await flush();

    const resumed = f.service.resume(1, build.id, '再加深色模式');
    assert.equal(resumed.state, 'building');
    assert.equal(resumed.total, 0, 'a continued build plans again from an empty ring');
    assert.equal(f.fake.starts.length, 2);
    assert.equal(f.fake.starts[1].input.sessionId, build.sessionId);
    assert.match(f.fake.starts[1].input.content, /再加深色模式/);
    assert.match(f.fake.starts[1].input.content, /TodoWrite/);

    f.fake.starts[1].resolve({ started: false, success: false, error: null });
    await flush();
    assert.equal(f.service.get(1, build.id).error, '无法启动开发');
    // A session someone is using in the workbench right now cannot be continued from the home screen.
    f.fake.setSnapshot({ running: true, startedAt: 0, success: null, todos: null });
    assert.throws(() => f.service.resume(1, build.id, ''), /会话正在运行/);
  } finally { f.cleanup(); }
});

test('a failed build resumed in the workbench is adopted from the run registry until it lights up', async () => {
  const f = fixture();
  try {
    const { build } = await f.service.create(1, input('Habit Tracker'));
    f.fake.starts[0].resolve({ started: true, success: false, error: 'Claude Code process exited with code 1' });
    await flush();
    const failed = f.service.get(1, build.id);
    assert.equal(failed.state, 'failed');

    // The build's own (older) run is still in the registry: nothing changes.
    f.fake.setSnapshot({ running: false, startedAt: Date.parse(failed.startedAt as string), success: false, todos: null });
    assert.equal(f.service.get(1, build.id).state, 'failed');

    const later = Date.parse(failed.finishedAt as string) + 1000;
    f.fake.setSnapshot({ running: true, startedAt: later, success: null, todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }] });
    const adopted = f.service.list(1)[0];
    assert.deepEqual([adopted.state, adopted.total, adopted.completed, adopted.currentTask, adopted.error], ['building', 2, 1, 'B', null]);

    f.fake.setSnapshot({ running: false, startedAt: later, success: true, todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'completed' }] });
    const lit = f.service.get(1, build.id);
    assert.deepEqual([lit.state, lit.completed], ['done', 2]);
    // Done builds are not adopted again by later runs of the session.
    f.fake.setSnapshot({ running: true, startedAt: later + 5000, success: null, todos: null });
    assert.equal(f.service.get(1, build.id).state, 'done');
  } finally { f.cleanup(); }
});

test('an adopted run the registry has already forgotten settles by its last checklist instead of spinning forever', async () => {
  const f = fixture();
  try {
    const first = (await f.service.create(1, input('One'))).build;
    const second = (await f.service.create(1, input('Two'))).build;
    for (const start of f.fake.starts) start.resolve({ started: true, success: false, error: 'Claude Code process exited with code 1' });
    await flush();

    const later = Date.now() + 1000;
    f.fake.setSnapshot({ running: true, startedAt: later, success: null, todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }] });
    assert.deepEqual(f.service.list(1).map(item => item.state), ['building', 'building']);
    // One run checks its last step off; then both finish while nobody is looking and the registry evicts them.
    f.fake.setSnapshot({ running: true, startedAt: later, success: null, todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'completed' }] });
    assert.equal(f.service.get(1, first.id).completed, 2);
    f.fake.setSnapshot(null);

    const lit = f.service.get(1, first.id);
    assert.deepEqual([lit.state, lit.error], ['done', null]);
    const unfinished = f.service.get(1, second.id);
    assert.equal(unfinished.state, 'failed');
    assert.match(unfinished.error ?? '', /会话已结束/);
  } finally { f.cleanup(); }
});

test('a restart fails interrupted builds with their last checklist and resumes builds that never started', async () => {
  const f = fixture({ maxParallel: 1 });
  try {
    const running = (await f.service.create(1, input('One'))).build;
    const waiting = (await f.service.create(1, input('Two'))).build;
    assert.equal(waiting.state, 'queued');

    const restarted = fakeRunner();
    restarted.setHistory([{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }]);
    const service = createStudioBuildsService({ ...f.deps, runner: restarted.runner });
    const interrupted = service.get(1, running.id);
    assert.equal(interrupted.state, 'failed');
    assert.match(interrupted.error ?? '', /服务器重启/);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual([service.get(1, running.id).total, service.get(1, running.id).completed], [2, 1]);
    assert.equal(restarted.starts.length, 1);
    assert.equal(restarted.starts[0].input.sessionId, waiting.sessionId);
    assert.equal(service.get(1, waiting.id).state, 'building');
  } finally { f.cleanup(); }
});

test('deleting the project takes its build off the list', async () => {
  const f = fixture();
  try {
    const { build, project } = await f.service.create(1, input('Habit Tracker'));
    f.fake.starts[0].resolve({ started: true, success: true, error: null });
    await flush();
    f.hub.remove(1, project.id);
    assert.deepEqual(f.service.list(1), []);
    assert.equal(f.service.get(1, build.id).state, 'done');
  } finally { f.cleanup(); }
});
