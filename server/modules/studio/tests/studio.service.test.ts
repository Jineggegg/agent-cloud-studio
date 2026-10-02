import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { createStudioService } from '../studio.service.js';

function fixture(request?: typeof fetch) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'studio-test-'));
  const database = new Database(':memory:');
  const service = createStudioService({ database, vaultDirectory: directory, request });
  return { service, database, directory, close: () => { database.close(); rmSync(directory, { recursive: true }); } };
}

test('credentials are encrypted locally, never returned and scoped to the owner', () => {
  const f = fixture();
  try {
    f.service.saveKey(1, 'fake-unit-test-key-not-valid');
    const stored = f.database.prepare('SELECT encrypted_key FROM studio_secrets').get() as { encrypted_key: string };
    assert.ok(!stored.encrypted_key.includes('fake-unit-test'));
    assert.equal(readFileSync(path.join(f.directory, 'master.key')).length, 32);
    assert.equal(f.service.status(1).deepseek.configured, true);
    assert.equal(f.service.status(2).deepseek.configured, false);
    assert.ok(!JSON.stringify(f.service.status(1)).includes('fake-unit-test'));
    f.service.removeKey(1);
    assert.equal(f.service.status(1).deepseek.configured, false);
  } finally { f.close(); }
});

test('conversation access and deletion cannot cross users', () => {
  const f = fixture();
  try {
    const row = f.service.createConversation(1, 'deepseek-flash');
    assert.throws(() => f.service.conversation(2, row.id), /对话不存在/);
    assert.throws(() => f.service.removeConversation(2, row.id), /对话不存在/);
    assert.equal(f.service.listConversations(2).length, 0);
    assert.throws(() => f.service.createConversation(1, 'invented-model'), /受支持/);
    f.service.removeConversation(1, row.id);
    assert.equal(f.service.listConversations(1).length, 0);
  } finally { f.close(); }
});

test('each home-screen chat app keeps an isolated history and rejects unknown spaces', () => {
  const f = fixture();
  try {
    const general = f.service.createConversation(1, 'deepseek-flash');
    const professor = f.service.createConversation(1, 'deepseek-v4-pro', 'super-professor');
    assert.equal(general.space, 'deepseek');
    assert.equal(professor.space, 'super-professor');
    assert.deepEqual(f.service.listConversations(1).map(row => (row as { id: string }).id), [general.id]);
    assert.deepEqual(f.service.listConversations(1, 'super-professor').map(row => (row as { id: string }).id), [professor.id]);
    assert.throws(() => f.service.listConversations(1, 'snr-trading'), /未知的对话空间/);
    assert.throws(() => f.service.createConversation(1, 'deepseek-flash', '__proto__'), /未知的对话空间/);
  } finally { f.close(); }
});

test('conversations created before spaces existed migrate into the DeepSeek app', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'studio-test-'));
  const database = new Database(':memory:');
  try {
    database.exec('CREATE TABLE studio_conversations (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL, model TEXT NOT NULL, updated_at TEXT NOT NULL)');
    database.prepare('INSERT INTO studio_conversations VALUES (?, ?, ?, ?, ?)').run('old', 1, '旧对话', 'deepseek-flash', new Date().toISOString());
    const service = createStudioService({ database, vaultDirectory: directory });
    assert.equal(service.conversation(1, 'old').space, 'deepseek');
    assert.equal(service.listConversations(1, 'super-professor').length, 0);
    createStudioService({ database, vaultDirectory: directory });
  } finally { database.close(); rmSync(directory, { recursive: true }); }
});

test('an unconfigured provider never calls a model or stores a submitted message', async () => {
  let calls = 0;
  const f = fixture((async () => { calls++; throw Error('must not run'); }) as typeof fetch);
  try {
    const row = f.service.createConversation(1, 'deepseek-flash');
    await assert.rejects(f.service.send(1, row.id, '你好', false, new AbortController().signal), /API 密钥/);
    assert.equal(calls, 0);
    assert.equal(f.service.conversation(1, row.id).messages.length, 0);
  } finally { f.close(); }
});

test('a reply persists and no SNR data is fetched without explicit opt-in', async () => {
  const requests: { url: string; body: string }[] = [];
  const f = fixture((async (url, init) => {
    requests.push({ url: String(url), body: String(init?.body) });
    return Response.json({ choices: [{ message: { content: '测试回复' } }] });
  }) as typeof fetch);
  try {
    f.service.saveKey(1, 'fake-unit-test-key-not-valid');
    const row = f.service.createConversation(1, 'deepseek-flash');
    await f.service.send(1, row.id, '测试问题', false, new AbortController().signal);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.deepseek.com/chat/completions');
    assert.ok(!requests[0].body.includes('datasetCount'));
    assert.equal(f.service.conversation(1, row.id).messages.length, 2);
  } finally { f.close(); }
});

test('API errors do not leak provider response bodies or stored secrets', async () => {
  const f = fixture((async () => new Response('sensitive-provider-body', { status: 401 })) as typeof fetch);
  try {
    f.service.saveKey(1, 'fake-unit-test-key-not-valid');
    const row = f.service.createConversation(1, 'deepseek-flash');
    await assert.rejects(f.service.send(1, row.id, '测试', false, new AbortController().signal), /401/);
    const messages = JSON.stringify(f.service.conversation(1, row.id).messages);
    assert.ok(!messages.includes('sensitive-provider-body'));
    assert.ok(!messages.includes('fake-unit-test'));
    assert.ok(messages.includes('"status":"error"'));
  } finally { f.close(); }
});

test('explicit SNR context only reads health and dataset endpoints', async () => {
  const urls: string[] = [];
  let sent = '';
  const f = fixture((async (url, init) => {
    urls.push(String(url));
    if (String(url).endsWith('/api/health')) return Response.json({ status: 'ok', phase: 5, trading_enabled: false, rules_approved: false });
    if (String(url).endsWith('/api/datasets')) return Response.json([{ id: 1 }]);
    sent = String(init?.body);
    return Response.json({ choices: [{ message: { content: '测试回复' } }] });
  }) as typeof fetch);
  try {
    f.service.saveKey(1, 'fake-unit-test-key-not-valid');
    const row = f.service.createConversation(1, 'deepseek-v4-pro');
    await f.service.send(1, row.id, '看研究状态', true, new AbortController().signal);
    assert.deepEqual(urls, ['http://127.0.0.1:8768/api/health', 'http://127.0.0.1:8768/api/datasets', 'https://api.deepseek.com/chat/completions']);
    assert.ok(sent.includes('datasetCount'));
    assert.ok(!sent.includes('"id":1'));
  } finally { f.close(); }
});

test('concurrent sends and deletion are rejected while a reply is pending', async () => {
  let complete: (response: Response) => void = () => {};
  const pending = new Promise<Response>(resolve => { complete = resolve; });
  const f = fixture((async () => pending) as typeof fetch);
  try {
    f.service.saveKey(1, 'fake-unit-test-key-not-valid');
    const row = f.service.createConversation(1, 'deepseek-flash');
    const first = f.service.send(1, row.id, '第一条', false, new AbortController().signal);
    await assert.rejects(f.service.send(1, row.id, '第二条', false, new AbortController().signal), /正在回复/);
    assert.throws(() => f.service.removeConversation(1, row.id), /停止/);
    complete(Response.json({ choices: [{ message: { content: '回复完成' } }] }));
    await first;
    assert.equal(f.service.conversation(1, row.id).messages.length, 2);
  } finally { f.close(); }
});
