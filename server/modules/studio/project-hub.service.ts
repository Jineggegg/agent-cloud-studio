import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type Database from 'better-sqlite3';

import type { StudioProjectInput, StudioProjectRecord, StudioTaskInput } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type Dependencies = {
  database: Database.Database;
  professorPath?: string;
  resolveWorkspace: (directory: string) => Promise<{ projectId: string; path: string }>;
  listSessions: (directory: string) => { id: string; provider: string; title: string }[];
  pendingSchedules: (userId: number, directory: string) => number;
  schedule: (input: { userId: number; sessionId: string; content: string; scheduledFor: string }) => { id: string };
};

const MODULES = ['agents', 'mail', 'automations'];
const PROVIDERS = ['claude', 'codex'];

function fail(message: string, statusCode = 400): never {
  throw new AppError(message, { statusCode, code: 'PROJECT_HUB_ERROR' });
}

function validate(input: StudioProjectInput) {
  if (!input.name.trim() || input.name.length > 80) fail('项目名称须为 1 到 80 个字符');
  if (/snr/i.test(input.name) || /snr/i.test(input.workspacePath)) fail('SNR 保留在独立实验室，不可加入自定义项目');
  if (input.description.length > 1000 || input.workspacePath.length > 1000) fail('项目说明或路径过长');
  if (input.workspacePath && !path.isAbsolute(input.workspacePath)) fail('工作目录必须为绝对路径');
  if (input.modules.some(value => !MODULES.includes(value)) || new Set(input.modules).size !== input.modules.length) fail('项目模块无效');
  if (!input.providers.length || input.providers.some(value => !PROVIDERS.includes(value)) || new Set(input.providers).size !== input.providers.length) fail('请选择 Claude 或 GPT / Codex');
}

/** Used by studio.module and tests for per-user modular projects, drafts and explicit scheduling; never accesses SNR. */
export function createProjectHubService(deps: Dependencies) {
  const db = deps.database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_projects (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, config TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS studio_project_tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, config TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  function owned(userId: number, id: string): StudioProjectRecord {
    const row = db.prepare('SELECT config, updated_at FROM studio_projects WHERE id = ? AND user_id = ?').get(id, userId) as { config: string; updated_at: string } | undefined;
    if (!row) fail('项目不存在', 404);
    return { id, ...JSON.parse(row.config), updatedAt: row.updated_at };
  }
  function save(userId: number, id: string, input: StudioProjectInput) {
    validate(input);
    db.prepare('INSERT INTO studio_projects VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at')
      .run(id, userId, JSON.stringify({ ...input, name: input.name.trim(), workspacePath: input.workspacePath.trim() }), new Date().toISOString());
    return owned(userId, id);
  }
  function tasks(userId: number, id: string) {
    owned(userId, id);
    return (db.prepare('SELECT id, config, updated_at FROM studio_project_tasks WHERE project_id = ? ORDER BY updated_at DESC').all(id) as { id: string; config: string; updated_at: string }[])
      .map(row => ({ id: row.id, ...JSON.parse(row.config), updatedAt: row.updated_at }));
  }
  function sessions(userId: number, id: string) {
    const project = owned(userId, id);
    return project.workspacePath ? deps.listSessions(project.workspacePath).filter(item => project.providers.includes(item.provider as 'claude' | 'codex')) : [];
  }
  return {
    list(userId: number) {
      const ids = db.prepare('SELECT id FROM studio_projects WHERE user_id = ? ORDER BY updated_at DESC').all(userId) as { id: string }[];
      if (!ids.length) {
        return [save(userId, randomUUID(), {
          name: '超级教授', description: '', workspacePath: deps.professorPath ?? '',
          modules: ['agents', 'mail', 'automations'], providers: ['claude', 'codex'],
        })];
      }
      return ids.map(({ id }) => owned(userId, id));
    },
    get: owned,
    create(userId: number, input: StudioProjectInput) { return save(userId, randomUUID(), input); },
    update(userId: number, id: string, input: StudioProjectInput) {
      const previous = owned(userId, id);
      validate(input);
      const executionChanged = previous.workspacePath !== input.workspacePath.trim() ||
        previous.providers.some(provider => !input.providers.includes(provider)) ||
        (previous.modules.includes('automations') && !input.modules.includes('automations')) ||
        (previous.modules.includes('agents') && !input.modules.includes('agents'));
      if (executionChanged && previous.workspacePath && deps.pendingSchedules(userId, previous.workspacePath)) {
        fail('请先取消此项目的待执行任务，再更改工作目录、助手或执行模块', 409);
      }
      return save(userId, id, input);
    },
    async launch(userId: number, id: string, provider: string) {
      const project = owned(userId, id);
      if (!project.modules.includes('agents') || !project.providers.includes(provider as 'claude' | 'codex')) fail('该项目未启用此助手');
      if (!project.workspacePath) fail('请先设置项目工作目录');
      const workspace = await deps.resolveWorkspace(project.workspacePath);
      return { url: `/workspace?projectId=${encodeURIComponent(workspace.projectId)}&provider=${encodeURIComponent(provider)}` };
    },
    sessions,
    tasks,
    saveTask(userId: number, id: string, input: StudioTaskInput, taskId?: string) {
      const project = owned(userId, id);
      if (!project.modules.includes('automations')) fail('自动化模块未启用');
      if (!input.title.trim() || input.title.length > 120 || !input.prompt.trim() || input.prompt.length > 16000) fail('任务名称或指令无效');
      if (!project.providers.includes(input.provider)) fail('任务助手未在此项目启用');
      if (taskId && !db.prepare('SELECT 1 FROM studio_project_tasks WHERE id = ? AND project_id = ?').get(taskId, id)) fail('任务不存在', 404);
      const target = taskId ?? randomUUID();
      db.prepare('INSERT INTO studio_project_tasks VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at')
        .run(target, id, JSON.stringify({ ...input, title: input.title.trim() }), new Date().toISOString());
      return tasks(userId, id).find(item => item.id === target);
    },
    scheduleTask(userId: number, id: string, taskId: string, sessionId: string, scheduledFor: string) {
      const project = owned(userId, id);
      if (!project.modules.includes('automations') || !project.modules.includes('agents')) fail('请先启用助手与自动化模块');
      const task = tasks(userId, id).find(item => item.id === taskId);
      if (!task) fail('任务不存在', 404);
      if (!project.providers.includes(task.provider)) fail('任务助手未在此项目启用');
      if (!sessions(userId, id).some(item => item.id === sessionId && item.provider === task.provider)) fail('请选择此项目下匹配助手的会话');
      const instant = new Date(scheduledFor);
      if (!Number.isFinite(instant.getTime()) || instant.getTime() <= Date.now()) fail('执行时间必须在未来');
      return deps.schedule({
        userId, sessionId, content: task.prompt,
        scheduledFor: instant.toISOString(),
      });
    },
  };
}
