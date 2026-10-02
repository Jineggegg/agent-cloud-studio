import assert from 'node:assert/strict';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import { createProjectHubService } from '../project-hub.service.js';
import type { StudioProjectInput } from '@/shared/types.js';

function fixture(pendingSchedules = 0) {
  const database = new Database(':memory:');
  const scheduled: unknown[] = [];
  const registered: string[] = [];
  const service = createProjectHubService({
    database, professorPath: '/projects/professor',
    resolveWorkspace: async directory => { registered.push(directory); return { projectId: 'native-project', path: directory }; },
    listSessions: directory => directory === '/projects/professor' ? [{ id: 'claude-session', provider: 'claude', title: '真实会话' }, { id: 'codex-session', provider: 'codex', title: 'GPT 会话' }] : [],
    pendingSchedules: () => pendingSchedules,
    schedule: input => { scheduled.push(input); return { id: 'scheduled-id' }; },
  });
  return { database, service, scheduled, registered };
}
const input: StudioProjectInput = { name: '新项目', description: '', workspacePath: '/projects/new', modules: ['agents'], providers: ['claude'] };

test('default project is user-owned, persistent, and does not create directories or execute tasks', () => {
  const f = fixture();
  try {
    const first = f.service.list(1);
    assert.equal(first[0].name, '超级教授');
    assert.equal(first[0].id, f.service.list(1)[0].id);
    assert.notEqual(first[0].id, f.service.list(2)[0].id);
    assert.throws(() => f.service.get(2, first[0].id), /不存在/);
    assert.throws(() => f.service.update(2, first[0].id, input), /不存在/);
    assert.deepEqual(f.registered, []);
    assert.deepEqual(f.scheduled, []);
  } finally { f.database.close(); }
});

test('pending execution cannot be hidden by disabling modules or switching workspace/provider', () => {
  const f = fixture(1);
  try {
    const project = f.service.list(1)[0];
    assert.throws(() => f.service.update(1, project.id, { ...project, modules: ['mail'] }), /先取消/);
    assert.throws(() => f.service.update(1, project.id, { ...project, workspacePath: '/projects/other' }), /先取消/);
    assert.throws(() => f.service.update(1, project.id, { ...project, providers: ['codex'] }), /先取消/);
    assert.equal(f.service.update(1, project.id, { ...project, name: '新名称' }).name, '新名称');
  } finally { f.database.close(); }
});

test('custom modules persist; reserved SNR projects, invalid providers and relative paths are rejected', async () => {
  const f = fixture();
  try {
    const project = f.service.create(1, input);
    assert.deepEqual(f.service.get(1, project.id).modules, ['agents']);
    assert.throws(() => f.service.create(1, { ...input, name: 'SNR 3.0' }), /SNR/);
    assert.throws(() => f.service.create(1, { ...input, workspacePath: '/projects/snr3' }), /SNR/);
    assert.throws(() => f.service.create(1, { ...input, workspacePath: 'relative' }), /绝对路径/);
    assert.throws(() => f.service.create(1, { ...input, providers: [] }), /Claude/);
    assert.throws(() => f.service.create(1, { ...input, modules: ['agents', 'agents'] }), /模块/);
    assert.throws(() => f.service.saveTask(1, project.id, { title: '任务', prompt: '查询', provider: 'claude' }), /未启用/);
    await assert.rejects(f.service.launch(1, project.id, 'codex'), /未启用/);
    const link = await f.service.launch(1, project.id, 'claude');
    assert.equal(link.url, '/workspace?projectId=native-project&provider=claude');
    assert.deepEqual(f.registered, ['/projects/new']);
  } finally { f.database.close(); }
});

test('saving automation is draft-only and scheduling checks time, owner, project and provider', () => {
  const f = fixture();
  try {
    const project = f.service.list(1)[0];
    const task = f.service.saveTask(1, project.id, { title: '报告', prompt: '只整理项目状态', provider: 'claude' })!;
    const future = new Date(Date.now() + 3600000).toISOString();
    assert.equal(f.scheduled.length, 0);
    assert.throws(() => f.service.tasks(2, project.id), /不存在/);
    assert.throws(() => f.service.scheduleTask(1, project.id, task.id, 'foreign-session', future), /此项目/);
    assert.throws(() => f.service.scheduleTask(1, project.id, task.id, 'codex-session', future), /此项目/);
    assert.throws(() => f.service.scheduleTask(2, project.id, task.id, 'claude-session', future), /不存在/);
    assert.throws(() => f.service.scheduleTask(1, project.id, task.id, 'claude-session', '2000-01-01'), /未来/);
    assert.equal(f.service.scheduleTask(1, project.id, task.id, 'claude-session', future).id, 'scheduled-id');
    assert.equal(f.scheduled.length, 1);
    f.service.update(1, project.id, { ...project, modules: ['agents'] });
    assert.throws(() => f.service.scheduleTask(1, project.id, task.id, 'claude-session', future), /启用/);
  } finally { f.database.close(); }
});
