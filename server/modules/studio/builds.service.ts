import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type Database from 'better-sqlite3';

import type {
  StudioBuildInput,
  StudioBuildOutcome,
  StudioBuildRecord,
  StudioBuildRunner,
  StudioBuildState,
  StudioBuildTodo,
  StudioProjectInput,
  StudioProjectRecord,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type BuildRow = {
  id: string;
  user_id: number;
  hub_project_id: string;
  ide_project_id: string;
  session_id: string;
  workspace_path: string;
  // The message the next (or current) turn sends: the wrapped request, or a wrapped follow-up after continue.
  prompt: string;
  state: StudioBuildState;
  total: number;
  completed: number;
  current_task: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
};

type Dependencies = {
  database: Database.Database;
  // Absolute directory new projects are created in (STUDIO_BUILDS_ROOT, default ~/projects).
  root: string;
  // The Studio project hub: the build's home-screen icon is an ordinary hub project.
  hub: {
    create(userId: number, input: StudioProjectInput): StudioProjectRecord;
    get(userId: number, id: string): StudioProjectRecord;
    remove(userId: number, id: string): unknown;
  };
  // Registers a directory as an IDE project and returns its id and canonical path.
  resolveWorkspace: (directory: string) => Promise<{ projectId: string; path: string }>;
  // Allocates the Claude Code session (app session id) that runs the build in `workspacePath`.
  createSession: (workspacePath: string, title: string) => { sessionId: string };
  // `git init` in a new directory; the git CLI unless a test replaces it.
  initRepository?: (directory: string) => Promise<void>;
  runner: StudioBuildRunner;
  // Builds that run at once; later ones wait as `queued` (STUDIO_BUILDS_MAX_PARALLEL, default 2).
  maxParallel?: number;
  // Delay before builds that were still queued at a restart start, so the provider runtimes are up first.
  resumeDelayMs?: number;
};

const MAX_REQUEST = 8000;
const SLUG_MAX = 40;
const INTERRUPTED = '服务器重启，开发中断了。点开图标可以在会话里继续。';
const CANCELLED = '已取消';
const ADOPTED_ENDED = '会话已结束，但清单还有步骤没完成。点开图标看看结果。';

const execFileAsync = promisify(execFile);

function fail(message: string, statusCode = 400): never {
  throw new AppError(message, { statusCode, code: 'STUDIO_BUILD_ERROR' });
}

// ASCII words of the name become the folder ("Habit Tracker" → habit-tracker); names without any become ai-app.
function slugFor(name: string) {
  const slug = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SLUG_MAX).replace(/-+$/, '');
  return slug || 'ai-app';
}

function uniqueDirectory(root: string, slug: string) {
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const candidate = path.join(root, attempt === 1 ? slug : `${slug}-${attempt}`);
    if (!existsSync(candidate)) return candidate;
  }
  return path.join(root, `${slug}-${randomUUID().slice(0, 8)}`);
}

async function initGitRepository(directory: string) {
  await execFileAsync('git', ['init', '--quiet'], { cwd: directory, timeout: 15_000 });
}

// The request wrapped with the unattended working rules; the build runner enforces the same boundaries.
function initialPrompt(name: string, request: string, directory: string) {
  return [
    `请从零开发一个新项目「${name}」。这是一次无人值守的开发：没有人会回答问题或批准计划，请自己做出合理的假设，并把假设写进 README。`,
    '',
    '需求：',
    request,
    '',
    '工作方式：',
    '1. 先用 TodoWrite 列出 3 到 8 个具体步骤的计划；每完成一步立刻更新，同一时间只有一步是 in_progress。主屏幕上的进度环按这个清单计算。',
    `2. 只在当前目录（${directory}）里工作：不读取、不修改这个目录之外的文件，不用 sudo，不全局安装，不 git push，不发布任何东西。命令被拒绝说明越界了，换一种在目录内完成的做法。`,
    '3. 选择简单、能在这台电脑上直接运行的技术方案；依赖装在项目里（npm 本地依赖；Python 用 uv 或 .venv）。',
    '4. 写 README.md：一两句话说明它是什么，以及怎样安装、运行和测试。',
    '5. 为核心逻辑写测试并运行，直到全部通过。',
    '6. 在本地 git 仓库提交成果（git add -A，然后 git commit）。',
    '7. 最后把清单里的步骤全部标为 completed，并用中文简短总结：做了什么、怎么运行、还能怎么改进。',
  ].join('\n');
}

function continuePrompt(message: string) {
  return [
    message || '继续完成尚未完成的步骤。',
    '',
    '（继续遵守之前的工作方式：用 TodoWrite 更新计划和进度，只在当前目录里工作，不 git push；完成后提交到本地仓库，并用中文简短总结。）',
  ].join('\n');
}

// The checklist reduced to what the home-screen ring needs.
function countsOf(todos: StudioBuildTodo[]) {
  const current = todos.find(todo => todo.status === 'in_progress');
  return {
    total: todos.length,
    completed: todos.filter(todo => todo.status === 'completed').length,
    current_task: current ? (current.activeForm ?? current.content) : null,
  };
}

function toRecord(row: BuildRow): StudioBuildRecord {
  return {
    id: row.id, hubProjectId: row.hub_project_id, ideProjectId: row.ide_project_id, sessionId: row.session_id,
    workspacePath: row.workspace_path, state: row.state, total: row.total, completed: row.completed,
    currentTask: row.current_task, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
    error: row.error,
  };
}

const now = () => new Date().toISOString();

/**
 * Used by the Studio builds wiring (and tests) for App Store-style AI builds: each build is a new folder, a hub
 * project (the icon) and a Claude Code session that a build runner drives unattended. Progress follows the
 * agent's checklist; runs of the same session started elsewhere (the owner continuing in the workbench) are
 * adopted from the run registry, so a rescued failed build still lights up.
 */
export function createStudioBuildsService(deps: Dependencies) {
  const db = deps.database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_builds (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, hub_project_id TEXT NOT NULL, ide_project_id TEXT NOT NULL,
      session_id TEXT NOT NULL, workspace_path TEXT NOT NULL, prompt TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'building', 'done', 'failed')),
      total INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, current_task TEXT,
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS studio_builds_by_user ON studio_builds (user_id, created_at);
  `);
  const maxParallel = Math.max(1, Math.floor(Number.isFinite(deps.maxParallel) ? Number(deps.maxParallel) : 2));
  const initRepository = deps.initRepository ?? initGitRepository;
  // Builds waiting for a slot, oldest first.
  const queue: string[] = [];
  // Builds whose turn this process is driving; `cancelled` keeps an explicit stop from reading as a failure.
  const active = new Map<string, { cancelled: boolean }>();

  const read = (id: string) => db.prepare('SELECT * FROM studio_builds WHERE id = ?').get(id) as BuildRow | undefined;
  function owned(userId: number, id: string) {
    const row = db.prepare('SELECT * FROM studio_builds WHERE id = ? AND user_id = ?').get(id, userId) as BuildRow | undefined;
    if (!row) fail('开发任务不存在', 404);
    return row;
  }
  function patch(id: string, fields: Partial<Omit<BuildRow, 'id' | 'user_id'>>) {
    const columns = Object.keys(fields);
    if (!columns.length) return;
    db.prepare(`UPDATE studio_builds SET ${columns.map(column => `${column} = @${column}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
  }
  const current = (id: string) => toRecord(read(id) as BuildRow);
  function projectExists(userId: number, id: string) {
    try { deps.hub.get(userId, id); return true; } catch { return false; }
  }

  function finish(id: string, outcome: StudioBuildOutcome) {
    const row = read(id);
    if (!row || row.state !== 'building') return;
    if (active.get(id)?.cancelled) {
      patch(id, { state: 'failed', error: CANCELLED, finished_at: now(), current_task: null });
    } else if (outcome.success) {
      patch(id, { state: 'done', error: null, finished_at: now(), current_task: null });
    } else {
      patch(id, { state: 'failed', error: outcome.error ?? (outcome.started ? 'AI 没能完成开发' : '无法启动开发'), finished_at: now(), current_task: null });
    }
  }

  function launch(id: string) {
    const row = read(id);
    if (!row || row.state !== 'queued') return;
    active.set(id, { cancelled: false });
    patch(id, { state: 'building', started_at: now(), finished_at: null, error: null });
    let outcome: Promise<StudioBuildOutcome>;
    try {
      outcome = deps.runner.start({
        sessionId: row.session_id, userId: row.user_id, content: row.prompt, workspacePath: row.workspace_path,
        onChecklist(todos) {
          if (read(id)?.state === 'building') patch(id, countsOf(todos));
        },
      });
    } catch (error) {
      outcome = Promise.reject(error);
    }
    void outcome
      .catch((error: unknown) => ({ started: false, success: false, error: error instanceof Error ? error.message.slice(0, 300) : '无法启动开发' }))
      .then(result => finish(id, result))
      .finally(() => {
        active.delete(id);
        pump();
      });
  }

  function pump() {
    while (active.size < maxParallel && queue.length) launch(queue.shift() as string);
  }

  function enqueue(id: string) {
    queue.push(id);
    pump();
  }

  // Follows runs this process is not driving: a failed build the owner resumed in the workbench, until it ends.
  function reconcile(row: BuildRow): BuildRow {
    if (active.has(row.id) || row.state === 'queued' || row.state === 'done') return row;
    const snapshot = deps.runner.inspect(row.session_id);
    if (!snapshot) {
      if (row.state !== 'building') return row;
      // An adopted run ended and the registry already forgot it (it keeps finished runs for minutes): judge it by
      // its last checklist rather than leaving the ring spinning, and polling, forever.
      const finished = row.total > 0 && row.completed >= row.total;
      patch(row.id, { state: finished ? 'done' : 'failed', error: finished ? null : ADOPTED_ENDED, finished_at: now(), current_task: null });
      return read(row.id) as BuildRow;
    }
    if (row.state === 'failed' && !(snapshot.startedAt > Date.parse(row.finished_at ?? row.created_at))) return row;
    const counts = snapshot.todos ? countsOf(snapshot.todos) : {};
    if (snapshot.running) {
      patch(row.id, {
        state: 'building', error: null, finished_at: null, ...counts,
        started_at: row.state === 'failed' ? new Date(snapshot.startedAt).toISOString() : row.started_at,
      });
    } else {
      patch(row.id, { state: snapshot.success ? 'done' : 'failed', error: snapshot.success ? null : 'AI 没能完成开发', finished_at: now(), ...counts, current_task: null });
    }
    return read(row.id) as BuildRow;
  }

  // A restart ends every turn this process was driving; builds that never started are resumed in order.
  for (const row of db.prepare("SELECT * FROM studio_builds WHERE state = 'building'").all() as BuildRow[]) {
    patch(row.id, { state: 'failed', error: INTERRUPTED, finished_at: now(), current_task: null });
    void deps.runner.readChecklist(row.session_id).then(todos => {
      if (todos && read(row.id)?.state === 'failed') patch(row.id, { ...countsOf(todos), current_task: null });
    }).catch(() => {});
  }
  const waiting = db.prepare("SELECT id FROM studio_builds WHERE state = 'queued' ORDER BY created_at").all() as { id: string }[];
  if (waiting.length) {
    const timer = setTimeout(() => {
      for (const { id } of waiting) if (!queue.includes(id)) queue.push(id);
      pump();
    }, deps.resumeDelayMs ?? 3000);
    timer.unref?.();
  }

  return {
    list(userId: number): StudioBuildRecord[] {
      const rows = db.prepare('SELECT * FROM studio_builds WHERE user_id = ? ORDER BY created_at, rowid').all(userId) as BuildRow[];
      // A deleted project takes its build off the home screen; its folder and session are left alone.
      return rows.filter(row => projectExists(userId, row.hub_project_id)).map(row => toRecord(reconcile(row)));
    },
    get(userId: number, id: string): StudioBuildRecord {
      return toRecord(reconcile(owned(userId, id)));
    },
    async create(userId: number, input: StudioBuildInput): Promise<{ build: StudioBuildRecord; project: StudioProjectRecord }> {
      const name = input.name.trim();
      const request = input.prompt.trim();
      if (!name || name.length > 80) fail('名称须为 1 到 80 个字符');
      if (!request) fail('请描述想做什么');
      if (request.length > MAX_REQUEST) fail(`描述最多 ${MAX_REQUEST} 个字符`);
      if (!path.isAbsolute(deps.root)) fail('STUDIO_BUILDS_ROOT 必须是绝对路径', 500);
      mkdirSync(deps.root, { recursive: true });
      const directory = uniqueDirectory(deps.root, slugFor(name));
      // The hub validates the name, tone and glyph before anything touches the disk.
      const project = deps.hub.create(userId, {
        name, description: `AI 开发 · ${request.split('\n')[0].slice(0, 120)}`, workspacePath: directory,
        modules: ['agents'], providers: ['claude', 'codex', 'deepseek'], tone: input.tone, glyph: input.glyph,
        links: [], remoteHost: '', remoteDir: '',
      });
      let createdDirectory = false;
      try {
        // Not recursive: a folder that appeared since the uniqueness check must never be reused.
        mkdirSync(directory);
        createdDirectory = true;
        await initRepository(directory);
        const workspace = await deps.resolveWorkspace(directory);
        // Session names keep only their first four words, so the marker is glued on with full-width brackets.
        const { sessionId } = deps.createSession(workspace.path, `${name}（AI 开发）`);
        const id = randomUUID();
        db.prepare(`INSERT INTO studio_builds (id, user_id, hub_project_id, ide_project_id, session_id, workspace_path, prompt, state, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`).run(id, userId, project.id, workspace.projectId, sessionId, workspace.path, initialPrompt(name, request, workspace.path), now());
        enqueue(id);
        return { build: current(id), project };
      } catch (error) {
        try { deps.hub.remove(userId, project.id); } catch { /* The icon is gone already or was never visible. */ }
        // Only a folder this call created, which holds nothing but the new .git.
        if (createdDirectory) rmSync(directory, { recursive: true, force: true });
        if (error instanceof AppError) throw error;
        throw new AppError(`创建项目失败：${error instanceof Error ? error.message.slice(0, 200) : '未知错误'}`, { statusCode: 500, code: 'STUDIO_BUILD_ERROR' });
      }
    },
    resume(userId: number, id: string, message: string): StudioBuildRecord {
      const row = reconcile(owned(userId, id));
      if (row.state === 'queued' || row.state === 'building') fail('正在开发中', 409);
      if (deps.runner.inspect(row.session_id)?.running) fail('这个会话正在运行，请等它结束', 409);
      const text = message.trim();
      if (text.length > MAX_REQUEST) fail(`描述最多 ${MAX_REQUEST} 个字符`);
      patch(id, { state: 'queued', prompt: continuePrompt(text), total: 0, completed: 0, current_task: null, error: null, started_at: null, finished_at: null });
      enqueue(id);
      return current(id);
    },
    async cancel(userId: number, id: string): Promise<StudioBuildRecord> {
      const row = owned(userId, id);
      if (row.state === 'queued') {
        const position = queue.indexOf(id);
        if (position >= 0) queue.splice(position, 1);
        patch(id, { state: 'failed', error: CANCELLED, finished_at: now(), current_task: null });
        return current(id);
      }
      if (row.state !== 'building') fail(row.state === 'done' ? '开发已经完成' : '开发已经结束', 409);
      const tracker = active.get(id);
      if (tracker) tracker.cancelled = true;
      await deps.runner.abort(row.session_id);
      if (read(id)?.state === 'building') patch(id, { state: 'failed', error: CANCELLED, finished_at: now(), current_task: null });
      return current(id);
    },
  };
}
