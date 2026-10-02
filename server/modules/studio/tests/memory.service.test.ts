import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMemoryService, memoryFolderName } from '../memory/memory.service.js';

import { createFakeMemory } from './memory-fakes.js';

const NOTES = [
  { permalink: 'studio/agent-cloud-studio/部署', title: '部署', content: '部署使用 systemd 用户服务，端口 3002。\n\n关键词：部署 端口 systemd', tags: ['claude'] },
  { permalink: 'studio/global/语言偏好', title: '语言偏好', content: '- 回答使用简体中文\n\n关键词：语言 中文 偏好', tags: ['deepseek'] },
  { permalink: 'studio/snr3-lab/回放', title: '回放', content: 'K 线回放只读，不交易。', tags: ['codex'] },
];

function fixture(files: Record<string, string> = {}, notes = NOTES) {
  const fake = createFakeMemory(notes);
  let clock = 1_000_000;
  const service = createMemoryService({
    client: fake.client,
    url: 'http://127.0.0.1:8770/mcp',
    deepseekEnabled: true,
    home: '/home/owner',
    readText: file => files[file] ?? null,
    now: () => clock,
    projects: userId => (userId === 1 ? [{ id: 'p1', name: 'Agent Cloud Studio', tone: 'slate', glyph: 'terminal', folder: 'agent-cloud-studio' }] : []),
  });
  return { fake, service, advance: (ms: number) => { clock += ms; } };
}

test('memory folders follow the workspace directory name, lowercased and slugged', () => {
  assert.equal(memoryFolderName(['/home/owner/projects/Agent-Cloud-Studio/', '', 'x'], 'id'), 'agent-cloud-studio');
  assert.equal(memoryFolderName(['', '~/projects/super-professor', '超级教授'], 'id'), 'super-professor');
  assert.equal(memoryFolderName(['', '', '超级 教授'], 'id'), '超级-教授');
  assert.equal(memoryFolderName(['', '', '!!!'], 'AB-12'), 'project-ab-12');
});

test('search sends the typed text and, for Chinese, prefix keywords; filters folders and adds the writer', async () => {
  const { fake, service } = fixture();
  const notes = await service.search('部署端口怎么改', { folders: ['agent-cloud-studio', 'global'] });
  const queries = fake.callsNamed('search_notes').filter(item => typeof item.args.query === 'string').map(item => item.args.query);
  assert.equal(queries[0], '部署端口怎么改');
  assert.ok(String(queries[1]).includes('部署*'), `keywords query: ${queries[1]}`);
  assert.ok(String(queries[1]).includes('端口*'), 'split single characters are joined back into one word');
  assert.ok(!String(queries[1]).includes('怎么'), 'stop words are dropped');
  assert.deepEqual(notes.map(note => note.id), ['studio/agent-cloud-studio/部署']);
  assert.equal(notes[0].folder, 'agent-cloud-studio');
  assert.equal(notes[0].source, 'claude');
  assert.ok(notes[0].snippet.startsWith('部署使用'));
  // Every search ran on notes only, never on observations or relations.
  assert.ok(fake.callsNamed('search_notes').every(item => JSON.stringify(item.args.entity_types) === '["entity"]'));
});

test('terms mode skips the raw text, and writer lookups are cached briefly', async () => {
  const { fake, service, advance } = fixture();
  await service.search('请帮我回忆一下语言偏好是什么', { mode: 'terms' });
  const textQueries = () => fake.callsNamed('search_notes').filter(item => typeof item.args.query === 'string');
  assert.equal(textQueries().length, 1);
  assert.match(String(textQueries()[0].args.query), /^\S+\*( OR \S+\*)*$/);
  const tagLookups = () => fake.callsNamed('search_notes').filter(item => Array.isArray(item.args.tags)).length;
  assert.equal(tagLookups(), 3);
  await service.search('回放');
  assert.equal(tagLookups(), 3, 'served from the cache');
  advance(16_000);
  await service.search('回放');
  assert.equal(tagLookups(), 6);
  assert.deepEqual(await service.search('   '), []);
});

test('recent lists the newest notes first with decorated folders', async () => {
  const { service } = fixture();
  const all = await service.recent({ userId: 1 });
  assert.deepEqual(all.notes.map(note => note.title), ['回放', '语言偏好', '部署']);
  assert.deepEqual(all.notes.map(note => note.source), ['codex', 'deepseek', 'claude']);
  assert.equal(all.total, 3);
  assert.deepEqual(all.folders.map(folder => folder.name), ['global', 'agent-cloud-studio', 'snr3-lab']);
  assert.deepEqual(all.folders[1].project, { id: 'p1', name: 'Agent Cloud Studio', tone: 'slate', glyph: 'terminal' });
  assert.equal(all.folders[0].project, null);
  const scoped = await service.recent({ userId: 2, folder: 'global' });
  assert.deepEqual(scoped.notes.map(note => note.id), ['studio/global/语言偏好']);
  assert.equal(scoped.folders[1].project, null, 'another user sees no project icons');
});

test('read returns the body without frontmatter and refuses title fallbacks', async () => {
  const { service } = fixture();
  const note = await service.read('studio/global/语言偏好');
  assert.equal(note.title, '语言偏好');
  assert.equal(note.folder, 'global');
  assert.equal(note.source, 'deepseek');
  assert.deepEqual(note.tags, ['deepseek']);
  assert.ok(note.content.startsWith('- 回答使用简体中文'));
  assert.equal(note.truncated, false);
  // basic-memory would resolve a bare title to some note; Studio only accepts the exact permalink.
  await assert.rejects(service.read('语言偏好'), (error: { statusCode?: number }) => error.statusCode === 404);
  await assert.rejects(service.read('studio/global/missing'), /不存在/);
});

test('remove deletes only a verified note', async () => {
  const { fake, service } = fixture();
  await assert.rejects(service.remove('部署'), /不存在/);
  assert.equal(fake.callsNamed('delete_note').length, 0, 'a title is never passed to delete_note');
  assert.deepEqual(await service.remove('studio/agent-cloud-studio/部署'), { deleted: true });
  assert.equal(fake.store.has('studio/agent-cloud-studio/部署'), false);
});

test('writes are validated, tagged with the writer and keep keywords searchable', async () => {
  const { fake, service } = fixture();
  const saved = await service.write({
    title: '  部署  端口 ', content: '服务改到 3003 端口。', folder: 'agent-cloud-studio', tags: ['ops', 'bad tag!', 'deepseek'],
    keywords: ['部署', '端口', '部署', 'x'.repeat(40)], overwrite: false, source: 'deepseek',
  });
  assert.equal(saved.action, 'created');
  const write = fake.callsNamed('write_note')[0].args;
  assert.equal(write.title, '部署 端口');
  assert.equal(write.directory, 'agent-cloud-studio');
  assert.deepEqual(write.tags, ['deepseek', 'ops'], 'the writer comes first; invalid and repeated tags are dropped');
  assert.equal(write.content, '服务改到 3003 端口。\n\n关键词：部署 端口');
  assert.equal(write.overwrite, false);

  const input = { title: '部署 端口', content: '新内容', folder: 'agent-cloud-studio', tags: [], keywords: [], overwrite: false, source: 'deepseek' as const };
  await assert.rejects(service.write(input), (error: { statusCode?: number; message: string }) => error.statusCode === 409 && /overwrite/.test(error.message));
  assert.equal((await service.write({ ...input, overwrite: true })).action, 'updated');

  await assert.rejects(service.write({ ...input, title: 'a/b' }), /斜杠/);
  await assert.rejects(service.write({ ...input, title: '' }), /标题/);
  await assert.rejects(service.write({ ...input, content: '  ' }), /不能为空/);
  await assert.rejects(service.write({ ...input, content: 'x'.repeat(8001) }), /8000/);
  await assert.rejects(service.write({ ...input, folder: '../etc' }), /文件夹/);
});

test('secret-looking content is rejected without echoing the value', async () => {
  const { fake, service } = fixture();
  const base = { title: '凭据', folder: 'global', tags: [], keywords: [], overwrite: false, source: 'deepseek' as const };
  const secrets = [
    'DeepSeek key sk-0123456789abcdefABCDEF',
    'token ghp_0123456789abcdefghijABCDEFGHIJ0123456789',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
    'password = hunter2-hunter2',
    'API_KEY: "a1b2c3d4e5f6"',
    '数据库密码：Zx9!pass',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'postgres://owner:s3cretpass@localhost:5432/db',
    'AKIAIOSFODNN7EXAMPLE',
    'x9F2kQ7pL0vB3nM8zR4tY6wE1aS5dG7hJ2kL9',
  ];
  for (const content of secrets) {
    await assert.rejects(service.write({ ...base, content }), (error: { statusCode?: number; message: string }) => {
      assert.equal(error.statusCode, 422, content);
      assert.ok(!error.message.includes(content.slice(-8)), 'the refusal never repeats the value');
      return true;
    });
  }
  assert.equal(fake.callsNamed('write_note').length, 0);
  // Ordinary technical notes still pass: hex hashes, paths, the word password in prose.
  const harmless = 'commit 0baef82c4f9e1a2b3c4d5e6f7a8b9c0d1e2f3a4b；文件 server/modules/studio/memory/memory-chat.service.ts；'
    + '密码由 1Password 管理，不写在这里。端口 8770。';
  assert.equal((await service.write({ ...base, title: '约定', content: harmless })).action, 'created');
});

test('status reports reachability, the notes path and each client', async () => {
  const files = {
    '/home/owner/.claude.json': JSON.stringify({ oauthAccount: { secret: 'x' }, mcpServers: { 'studio-memory': { type: 'http', url: 'http://127.0.0.1:8770/mcp' } } }),
    '/home/owner/.codex/config.toml': '[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.studio-memory]\nurl = "http://127.0.0.1:8770/mcp"\n',
    '/home/owner/.claude/CLAUDE.md': '# 语言\n\n<!-- studio-memory:begin -->\n...\n<!-- studio-memory:end -->\n',
  };
  const { fake, service } = fixture(files);
  const status = await service.status();
  assert.deepEqual(status, {
    reachable: true, url: 'http://127.0.0.1:8770/mcp', project: 'studio', notesPath: '~/studio-memory',
    clients: {
      claude: { registered: true, transport: 'http', conventions: true },
      codex: { registered: true, transport: 'http', conventions: false },
      deepseek: { enabled: true },
    },
  });
  assert.ok(!JSON.stringify(status).includes('oauthAccount'));

  fake.state.down = true;
  const offline = await fixture({}).service.status();
  assert.equal(offline.clients.claude.registered, false);
  assert.equal(offline.clients.codex.registered, false);
  const down = await service.status();
  assert.equal(down.reachable, false);
  assert.equal(down.notesPath, null);
  assert.equal(down.clients.claude.registered, true, 'client checks do not need the server');
});

test('a server that answers the ping but is slow with its tools is still reported as running', async () => {
  const { fake, service } = fixture();
  fake.state.slowTools = ['list_memory_projects'];
  const status = await service.status();
  assert.equal(status.reachable, true);
  assert.equal(status.project, null);
  assert.equal(status.notesPath, null);
});

test('a stdio registration in Codex is reported as such', async () => {
  const { service } = fixture({ '/home/owner/.codex/config.toml': '[mcp_servers."studio-memory"]\ncommand = "basic-memory"\nargs = ["mcp"]\n[mcp_servers.next]\nurl = "x"\n' });
  const status = await service.status();
  assert.deepEqual(status.clients.codex, { registered: true, transport: 'stdio', conventions: false });
});
