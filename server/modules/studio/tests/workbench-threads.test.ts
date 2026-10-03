import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';

import Database from 'better-sqlite3';
import express from 'express';

import { AppError } from '@/shared/utils.js';

import { MAX_HANDOFF_SUMMARY_CHARS, buildHandoffSummary } from '../workbench-handoff-summary.service.js';
import type { HandoffTranscriptEntry } from '../workbench-handoff-summary.service.js';
import { createWorkbenchService } from '../workbench.service.js';
import { createWorkbenchRouter } from '../workbench.routes.js';
import { createWorkbenchThreadsService } from '../workbench-threads.service.js';

// ── the summary builder ──

const CONVERSATION: HandoffTranscriptEntry[] = [
  { type: 'user', text: '把侧栏改成可以折叠的，\n\n记住用户的选择' },
  { type: 'tool', name: 'Read', input: { file_path: 'src/Sidebar.tsx' } },
  { type: 'tool', name: 'Edit', input: { file_path: 'src/Sidebar.tsx' } },
  { type: 'tool', name: 'Bash', input: { command: 'npm test -- sidebar' } },
  { type: 'assistant', text: '我先看一下现有的侧栏。' },
  { type: 'assistant', text: '## 完成\n侧栏现在可以折叠，状态存在 **localStorage**：\n```ts\nlocalStorage.setItem("x", "1")\n```' },
  { type: 'user', text: '再加一个快捷键' },
  { type: 'tool', name: 'apply_patch', input: { input: '*** Begin Patch\n*** Update File: src/shortcuts.ts\n*** Add File: src/keys.ts\n*** End Patch' } },
  { type: 'tool', name: 'Edit', input: { file_path: 'src/Sidebar.tsx' } },
  { type: 'assistant', text: '已经加上 ⌘\\ 切换侧栏。要不要在手机上也显示这个按钮？另外，快捷键需要写进帮助页吗？' },
];

test('the summary keeps the goal, the last request, the state, files, commands and open questions', () => {
  const summary = buildHandoffSummary({ sourceLabel: 'Claude Code', entries: CONVERSATION });
  assert.match(summary, /Claude Code 这段对话的交接摘要，共 2 条主人消息/);
  assert.match(summary, /## 目标\n把侧栏改成可以折叠的， 记住用户的选择/);
  assert.match(summary, /## 主人最后的请求\n再加一个快捷键/);
  assert.match(summary, /## 当前状态（Claude Code 最后的回答）\n已经加上 ⌘\\ 切换侧栏/);
  // The earlier turn's final answer, condensed: no heading marks, bold or code, only the prose and [代码], its lines
  // run on with ；.
  assert.match(summary, /## 之前的结论与决定\n- 完成；侧栏现在可以折叠，状态存在 localStorage： \[代码\]/);
  assert.doesNotMatch(summary, /我先看一下现有的侧栏/, 'only a turn’s final answer is kept');
  assert.match(summary, /## 改动过的文件\n- src\/Sidebar\.tsx（2 次）\n- src\/shortcuts\.ts\n- src\/keys\.ts/);
  assert.doesNotMatch(summary, /## 改动过的文件[\s\S]*Read/);
  assert.match(summary, /## 运行过的命令（最近 1 条）\n- npm test -- sidebar/);
  assert.match(summary, /## 待确认的问题\n- 要不要在手机上也显示这个按钮？\n- 另外，快捷键需要写进帮助页吗？/);
  assert.match(summary, /## 主人说过的话（按时间）\n1\. 把侧栏改成可以折叠的， 记住用户的选择\n2\. 再加一个快捷键/);
});

test('a long conversation is capped, dropping the oldest messages first and keeping the newest', () => {
  const entries: HandoffTranscriptEntry[] = [];
  for (let index = 1; index <= 120; index += 1) {
    entries.push({ type: 'user', text: `第 ${index} 个请求：${'细节'.repeat(200)}` });
    entries.push({ type: 'assistant', text: `第 ${index} 个回答：${'说明'.repeat(400)}` });
  }
  const summary = buildHandoffSummary({ sourceLabel: 'Codex', entries });
  assert.ok(summary.length <= MAX_HANDOFF_SUMMARY_CHARS, `capped (${summary.length})`);
  assert.match(summary, /## 目标\n第 1 个请求/);
  assert.match(summary, /## 主人最后的请求\n第 120 个请求/);
  assert.match(summary, /## 当前状态（Codex 最后的回答）\n第 120 个回答/);
  // Each owner message is truncated, and the oldest ones are left out with a note.
  assert.match(summary, /（更早的 \d+ 条已省略）\n\d+\. 第 \d+ 个请求/);
  assert.match(summary, /120\. 第 120 个请求：(细节)+细?…/);
  assert.doesNotMatch(summary, /\n1\. 第 1 个请求/);
});

test('a conversation handed over before carries its earlier summary, not the block as the owner’s words', () => {
  const summary = buildHandoffSummary({
    sourceLabel: 'Codex',
    entries: [
      { type: 'user', text: '继续做导出功能\n\n<handoff>\n这段对话之前由 Claude Code 进行…\n\n## 目标\n做一个导出按钮\n</handoff>' },
      { type: 'assistant', text: '导出已完成。' },
    ],
  });
  assert.match(summary, /## 目标\n继续做导出功能$/m);
  assert.match(summary, /## 更早的摘要\n这段对话之前由 Claude Code 进行…\n\n## 目标\n做一个导出按钮/);
  assert.doesNotMatch(summary, /1\. 继续做导出功能 <handoff>/);
});

test('an empty conversation still says so', () => {
  const summary = buildHandoffSummary({ sourceLabel: 'DeepSeek', entries: [] });
  assert.match(summary, /## 目标\n（主人还没有说明）/);
  assert.match(summary, /（还没有回答）/);
});

// ── the threads service, with fake providers ──

type FakeSession = { provider: string; projectId: string | null; transcript: unknown[] };

function fixture() {
  const database = new Database(':memory:');
  const sessions = new Map<string, FakeSession>([
    ['claude-1', { provider: 'claude', projectId: 'p1', transcript: [
      { kind: 'text', role: 'user', content: '把侧栏改成可以折叠的' },
      { kind: 'tool_use', toolName: 'Edit', toolInput: { file_path: 'src/Sidebar.tsx' } },
      { kind: 'thinking', content: '内部思考不进摘要' },
      { kind: 'text', role: 'assistant', content: '侧栏已经可以折叠。' },
    ] }],
    ['codex-2', { provider: 'codex', projectId: 'p1', transcript: [{ kind: 'text', role: 'user', content: '再加快捷键' }] }],
    ['claude-3', { provider: 'claude', projectId: 'p1', transcript: [] }],
    ['claude-other', { provider: 'claude', projectId: 'p2', transcript: [] }],
  ]);
  const conversations = new Map([['ds-1', { owner: 1, messages: [
    { role: 'user', content: '帮我想个名字', status: 'complete' },
    { role: 'assistant', content: '叫「折叠侧栏」如何？', status: 'complete' },
    { role: 'assistant', content: '超时', status: 'error' },
  ] }]]);
  let clock = Date.parse('2026-10-03T08:00:00Z');
  const service = createWorkbenchThreadsService({
    database,
    agentSession: id => (sessions.has(id) ? { provider: sessions.get(id)!.provider, projectId: sessions.get(id)!.projectId } : null),
    agentTranscript: async id => sessions.get(id)?.transcript as never,
    deepseekConversation(userId, id) {
      const found = conversations.get(id);
      if (!found || found.owner !== userId) throw new AppError('对话不存在', { statusCode: 404 });
      return found;
    },
    now: () => clock,
  });
  return { database, service, tick: () => { clock += 60_000; } };
}

test('a handoff summarises the outgoing session and the link records the chain in order', async () => {
  const f = fixture();
  try {
    const handoff = await f.service.handoff(1, { projectId: 'p1', from: { kind: 'agent', id: 'claude-1' }, toProvider: 'codex', fromModelLabel: 'Opus' });
    assert.match(handoff.summary, /## 目标\n把侧栏改成可以折叠的/);
    assert.match(handoff.summary, /- src\/Sidebar\.tsx/);
    assert.doesNotMatch(handoff.summary, /内部思考/);
    assert.match(handoff.context, /^<handoff>\n这段对话之前由 Claude Code（Opus）进行，现在交给你（Codex）接着做。/);
    assert.ok(handoff.context.endsWith(`${handoff.summary}\n</handoff>`));

    f.tick();
    const thread = f.service.link(1, {
      projectId: 'p1', title: '折叠侧栏',
      from: { kind: 'agent', id: 'claude-1', modelLabel: 'Opus' },
      to: { kind: 'agent', id: 'codex-2', modelLabel: 'GPT-6.1 Sol' },
    });
    assert.equal(thread.title, '折叠侧栏');
    assert.deepEqual(thread.segments, [
      { kind: 'agent', provider: 'claude', sessionId: 'claude-1', modelLabel: 'Opus', handoffAt: null },
      { kind: 'agent', provider: 'codex', sessionId: 'codex-2', modelLabel: 'GPT-6.1 Sol', handoffAt: '2026-10-03T08:01:00.000Z' },
    ]);

    // The chain grows from its latest stretch: Codex hands on to DeepSeek.
    const toDeepSeek = await f.service.handoff(1, { projectId: 'p1', from: { kind: 'agent', id: 'codex-2' }, toProvider: 'deepseek', fromModelLabel: null });
    assert.match(toDeepSeek.context, /由 Codex 进行，现在交给你（DeepSeek）接着做。.*你看不到项目文件/);
    f.tick();
    const longer = f.service.link(1, { projectId: 'p1', title: 'ignored', from: { kind: 'agent', id: 'codex-2', modelLabel: null }, to: { kind: 'deepseek', id: 'ds-1', modelLabel: 'deepseek-v4-pro' } });
    assert.equal(longer.id, thread.id);
    assert.equal(longer.title, '折叠侧栏', 'the title is the conversation’s, set by its first handoff');
    assert.deepEqual(longer.segments.map(segment => `${segment.provider}:${segment.sessionId}`), ['claude:claude-1', 'codex:codex-2', 'deepseek:ds-1']);

    // An older stretch cannot be handed on again, and a session belongs to one chain only.
    await assert.rejects(() => f.service.handoff(1, { projectId: 'p1', from: { kind: 'agent', id: 'claude-1' }, toProvider: 'deepseek', fromModelLabel: null }), /已经交给其他模型了/);
    assert.throws(() => f.service.link(1, { projectId: 'p1', title: '', from: { kind: 'agent', id: 'claude-3', modelLabel: null }, to: { kind: 'deepseek', id: 'ds-1', modelLabel: null } }), /已经在另一段对话里/);

    assert.deepEqual(f.service.list(1, 'p1').map(item => item.id), [thread.id]);
    assert.deepEqual(f.service.list(1, 'p2'), []);
    assert.deepEqual(f.service.list(2, 'p1'), [], 'threads are the owner’s');
  } finally { f.database.close(); }
});

test('a DeepSeek conversation hands over its completed messages only', async () => {
  const f = fixture();
  try {
    const handoff = await f.service.handoff(1, { projectId: 'p1', from: { kind: 'deepseek', id: 'ds-1' }, toProvider: 'claude', fromModelLabel: 'deepseek-flash' });
    assert.match(handoff.summary, /## 目标\n帮我想个名字/);
    assert.match(handoff.summary, /叫「折叠侧栏」如何？/);
    assert.doesNotMatch(handoff.summary, /超时/);
    assert.match(handoff.context, /由 DeepSeek（deepseek-flash）进行，现在交给你（Claude Code）接着做。.*git 状态/);
    await assert.rejects(() => f.service.handoff(2, { projectId: 'p1', from: { kind: 'deepseek', id: 'ds-1' }, toProvider: 'claude', fromModelLabel: null }), /对话不存在/);
  } finally { f.database.close(); }
});

test('a same-provider switch needs no handoff, and sessions must be in the project', async () => {
  const f = fixture();
  try {
    await assert.rejects(() => f.service.handoff(1, { projectId: 'p1', from: { kind: 'agent', id: 'claude-1' }, toProvider: 'claude', fromModelLabel: null }), /不需要交接/);
    await assert.rejects(() => f.service.handoff(1, { projectId: 'p1', from: { kind: 'agent', id: 'claude-other' }, toProvider: 'codex', fromModelLabel: null }), /不在这个项目里/);
    await assert.rejects(() => f.service.handoff(1, { projectId: 'p1', from: { kind: 'agent', id: 'missing' }, toProvider: 'codex', fromModelLabel: null }), /不在这个项目里/);
    assert.throws(() => f.service.link(1, { projectId: 'p1', title: 't', from: { kind: 'agent', id: 'claude-1', modelLabel: null }, to: { kind: 'agent', id: 'claude-3', modelLabel: null } }), /不需要交接/);
    assert.throws(() => f.service.link(1, { projectId: 'p1', title: 't', from: { kind: 'agent', id: 'claude-1', modelLabel: null }, to: { kind: 'agent', id: 'claude-other', modelLabel: null } }), /不在这个项目里/);
    assert.deepEqual(f.service.list(1, 'p1'), []);
  } finally { f.database.close(); }
});

test('a chain can be renamed and forgotten', () => {
  const f = fixture();
  try {
    const thread = f.service.link(1, { projectId: 'p1', title: '', from: { kind: 'agent', id: 'claude-1', modelLabel: null }, to: { kind: 'agent', id: 'codex-2', modelLabel: null } });
    assert.equal(thread.title, '新会话');
    assert.equal(f.service.rename(1, thread.id, '  侧栏折叠  ').title, '侧栏折叠');
    assert.throws(() => f.service.rename(2, thread.id, 'x'), /找不到这段对话/);
    assert.throws(() => f.service.rename(1, thread.id, '   '), /名称不能为空/);
    f.service.remove(1, thread.id);
    assert.deepEqual(f.service.list(1, 'p1'), []);
    // Its sessions are plain sessions again and can start a new chain.
    assert.equal(f.service.link(1, { projectId: 'p1', title: 'again', from: { kind: 'agent', id: 'claude-1', modelLabel: null }, to: { kind: 'agent', id: 'codex-2', modelLabel: null } }).segments.length, 2);
  } finally { f.database.close(); }
});

// ── the routes ──

test('the thread routes parse their input and answer only a signed-in user', async () => {
  const f = fixture();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = Number(req.get('x-test-user'));
    if (id) (req as express.Request & { user?: { id: number } }).user = { id };
    next();
  });
  app.use('/workbench', createWorkbenchRouter(createWorkbenchService({ listHubProjects: () => [], findProjectId: () => null }), f.service));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ error: error instanceof Error ? error.message : 'error' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/workbench`;
  const call = (path: string, init: { method?: string; body?: unknown; user?: number } = {}) => fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.user === 0 ? {} : { 'x-test-user': String(init.user ?? 1) }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  try {
    assert.equal((await call('/threads?projectId=p1', { user: 0 })).status, 401);
    assert.equal((await call('/threads')).status, 400);

    const handoff = await call('/handoffs', { method: 'POST', body: { projectId: 'p1', from: { kind: 'agent', id: 'claude-1', modelLabel: 'Opus' }, toProvider: 'codex' } });
    assert.equal(handoff.status, 200);
    assert.match(((await handoff.json()) as { context: string }).context, /Claude Code（Opus）/);
    assert.equal((await call('/handoffs', { method: 'POST', body: { projectId: 'p1', from: { kind: 'agent', id: 'claude-1' }, toProvider: 'cursor' } })).status, 400);
    assert.equal((await call('/handoffs', { method: 'POST', body: { projectId: 'p1', from: { kind: 'file', id: 'x' }, toProvider: 'codex' } })).status, 400);

    const linked = await call('/threads', { method: 'POST', body: { projectId: 'p1', title: '折叠侧栏', from: { kind: 'agent', id: 'claude-1' }, to: { kind: 'agent', id: 'codex-2', modelLabel: 'GPT-6.1 Sol' } } });
    assert.equal(linked.status, 201);
    const thread = (await linked.json()) as { id: string };
    const listed = (await (await call('/threads?projectId=p1')).json()) as { id: string; segments: unknown[] }[];
    assert.deepEqual(listed.map(item => [item.id, item.segments.length]), [[thread.id, 2]]);

    const renamed = await call(`/threads/${thread.id}`, { method: 'PATCH', body: { title: '侧栏' } });
    assert.equal(((await renamed.json()) as { title: string }).title, '侧栏');
    assert.equal((await call(`/threads/${thread.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await call(`/threads/${thread.id}`, { method: 'DELETE' })).status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
    f.database.close();
  }
});
