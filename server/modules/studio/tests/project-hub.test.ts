import assert from 'node:assert/strict';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import type { StudioProjectInput } from '@/shared/types.js';
import { createProjectHubService } from '../project-hub.service.js';

function fixture(pendingSchedules = 0) {
  const database = new Database(':memory:');
  const scheduled: unknown[] = [];
  const registered: string[] = [];
  const forgotten: string[] = [];
  const service = createProjectHubService({
    database, professorPath: '/projects/professor', snrPath: '/projects/snr3-lab',
    resolveWorkspace: async directory => { registered.push(directory); return { projectId: 'native-project', path: directory }; },
    listSessions: directory => directory === '/projects/professor' ? [{ id: 'claude-session', provider: 'claude', title: '真实会话' }, { id: 'codex-session', provider: 'codex', title: 'GPT 会话' }] : [],
    pendingSchedules: () => pendingSchedules,
    schedule: input => { scheduled.push(input); return { id: 'scheduled-id' }; },
    forget: (_userId, id) => { forgotten.push(id); },
    workbench: async () => '/home/me/studio-workbench',
  });
  const professor = (userId = 1) => service.list(userId).find(project => project.name === '超级教授')!;
  return { database, service, scheduled, registered, forgotten, professor };
}
const input: StudioProjectInput = { name: '新项目', description: '', workspacePath: '/projects/new', modules: ['agents'], providers: ['claude'], tone: 'slate', glyph: 'folder', links: [], remoteHost: '', remoteDir: '' };

test('built-in products are seeded once per user in home-screen order without touching the filesystem', () => {
  const f = fixture();
  try {
    const first = f.service.list(1);
    assert.deepEqual(first.map(project => project.name), ['SNR 3.0', '超级教授', 'Trading 212']);
    assert.deepEqual(first.map(project => project.modules), [['agents', 'snr-lab'], ['agents', 'automations'], ['agents', 'trading212']]);
    assert.equal(first[0].workspacePath, '/projects/snr3-lab');
    assert.deepEqual(f.service.list(1).map(project => project.id), first.map(project => project.id));
    assert.notEqual(first[0].id, f.service.list(2)[0].id);
    assert.throws(() => f.service.get(2, first[0].id), /不存在/);
    assert.throws(() => f.service.update(2, first[0].id, input), /不存在/);
    assert.deepEqual(f.registered, []);
    assert.deepEqual(f.scheduled, []);
  } finally { f.database.close(); }
});

test('editing a project keeps its home-screen position', () => {
  const f = fixture();
  try {
    const [snr] = f.service.list(1);
    f.service.update(1, snr.id, { ...snr, name: 'SNR 实验室' });
    assert.deepEqual(f.service.list(1).map(project => project.name), ['SNR 实验室', '超级教授', 'Trading 212']);
  } finally { f.database.close(); }
});

test('pending execution cannot be hidden by disabling modules, switching workspace/provider or deleting', () => {
  const f = fixture(1);
  try {
    const project = f.professor();
    assert.throws(() => f.service.update(1, project.id, { ...project, modules: ['mail'] }), /先取消/);
    assert.throws(() => f.service.update(1, project.id, { ...project, workspacePath: '/projects/other' }), /先取消/);
    assert.throws(() => f.service.update(1, project.id, { ...project, providers: ['codex'] }), /先取消/);
    assert.throws(() => f.service.remove(1, project.id), /先取消/);
    assert.equal(f.service.update(1, project.id, { ...project, name: '新名称' }).name, '新名称');
  } finally { f.database.close(); }
});

test('any project, including SNR, can enable every model; invalid models, icons and paths are rejected', async () => {
  const f = fixture();
  try {
    const snr = f.service.create(1, { ...input, name: 'SNR 3.0', workspacePath: '/projects/snr3-lab', providers: ['claude', 'codex', 'cursor', 'opencode', 'deepseek'] });
    assert.equal(snr.name, 'SNR 3.0');
    assert.throws(() => f.service.create(1, { ...input, workspacePath: 'relative' }), /绝对路径/);
    assert.throws(() => f.service.create(1, { ...input, providers: [] }), /至少/);
    assert.throws(() => f.service.create(1, { ...input, providers: ['gpt' as 'codex'] }), /模型无效/);
    assert.throws(() => f.service.create(1, { ...input, modules: ['agents', 'agents'] }), /模块/);
    assert.throws(() => f.service.create(1, { ...input, tone: 'neon' }), /图标/);
    assert.equal(f.service.create(1, { ...input, modules: ['mail'], providers: [] }).modules[0], 'mail');

    const project = f.service.create(1, input);
    assert.throws(() => f.service.saveTask(1, project.id, { title: '任务', prompt: '查询', provider: 'claude' }), /未启用/);
    await assert.rejects(f.service.launch(1, project.id, 'codex'), /未启用/);
    await assert.rejects(f.service.launch(1, snr.id, 'deepseek'), /不在开发工具/);
    assert.equal((await f.service.launch(1, project.id, 'claude')).url, '/workspace?projectId=native-project&provider=claude');
    assert.equal((await f.service.launch(1, snr.id, 'cursor')).url, '/workspace?projectId=native-project&provider=cursor');
    // Widgets open a new session in the workbench directory, outside any project.
    assert.equal((await f.service.launchWorkbench('codex')).url, '/workspace?projectId=native-project&provider=codex');
    await assert.rejects(f.service.launchWorkbench('deepseek'), /不在开发工具/);
    assert.deepEqual(f.registered, ['/projects/new', '/projects/snr3-lab', '/home/me/studio-workbench']);
  } finally { f.database.close(); }
});

test('deleting a project removes its drafts and asks other services to forget it', () => {
  const f = fixture();
  try {
    const project = f.professor();
    f.service.saveTask(1, project.id, { title: '报告', prompt: '只整理项目状态', provider: 'claude' });
    assert.throws(() => f.service.remove(2, project.id), /不存在/);
    assert.deepEqual(f.service.remove(1, project.id), { deleted: true });
    assert.throws(() => f.service.get(1, project.id), /不存在/);
    assert.equal((f.database.prepare('SELECT COUNT(*) AS n FROM studio_project_tasks').get() as { n: number }).n, 0);
    assert.deepEqual(f.forgotten, [project.id]);
    assert.equal(f.service.list(1).length, 2);
  } finally { f.database.close(); }
});

test('saving automation is draft-only and scheduling checks time, owner, project and provider', () => {
  const f = fixture();
  try {
    const project = f.professor();
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

test('links and remote hosts are validated; remote projects launch only server-built commands', async () => {
  const database = new Database(':memory:');
  const commands: unknown[] = [];
  const service = createProjectHubService({
    database,
    resolveWorkspace: async directory => ({ projectId: 'native', path: directory }),
    listSessions: () => [], pendingSchedules: () => 0, schedule: () => ({ id: 'x' }),
    professorLinks: [{ label: '网站', url: 'https://example.test/' }],
    remoteHosts: () => ['aj'],
    remoteSeeds: () => [{ host: 'aj', label: 'AJ 服务器', dir: '~/projects/app' }],
    remoteCommand: (host, dir, agent) => { commands.push([host, dir, agent]); return { command: `ssh ${host}`, title: agent }; },
  });
  try {
    const seeded = service.list(1);
    assert.deepEqual(seeded.map(project => project.name), ['SNR 3.0', '超级教授', 'Trading 212', 'AJ 服务器']);
    assert.deepEqual(seeded[1].links, [{ label: '网站', url: 'https://example.test/' }]);
    const aj = seeded[3];
    assert.equal(aj.remoteHost, 'aj');

    assert.throws(() => service.create(1, { ...input, links: [{ label: 'x', url: 'javascript:alert(1)' }] }), /链接/);
    assert.throws(() => service.create(1, { ...input, links: Array.from({ length: 9 }, (_, i) => ({ label: `l${i}`, url: 'https://a.test' })) }), /链接/);
    assert.throws(() => service.create(1, { ...input, remoteHost: 'elsewhere', remoteDir: '~/x' }), /未在服务器配置/);
    assert.throws(() => service.create(1, { ...input, remoteHost: 'aj', remoteDir: '~/x; rm -rf ~' }), /远程目录/);
    assert.throws(() => service.create(1, { ...input, remoteHost: 'aj', remoteDir: '~/../etc' }), /远程目录/);
    assert.throws(() => service.create(1, { ...input, remoteDir: '~/x' }), /未选择远程主机/);

    await assert.rejects(service.launch(1, aj.id, 'claude'), /远程会话/);
    assert.deepEqual(service.launchRemote(1, aj.id, 'claude'), { command: 'ssh aj', title: 'claude' });
    assert.deepEqual(service.launchRemote(1, aj.id, 'shell'), { command: 'ssh aj', title: 'shell' });
    assert.throws(() => service.launchRemote(1, aj.id, 'cursor'), /只支持/);
    assert.throws(() => service.launchRemote(2, aj.id, 'claude'), /不存在/);
    assert.throws(() => service.launchRemote(1, seeded[0].id, 'claude'), /没有配置远程主机/);
    assert.deepEqual(commands, [['aj', '~/projects/app', 'claude'], ['aj', '~/projects/app', 'shell']]);
  } finally { database.close(); }
});
