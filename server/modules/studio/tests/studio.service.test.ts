import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { createStudioService } from '../studio.service.js';

function fixture(request?: typeof fetch, snrAuthorization: () => string | null = () => null) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'studio-test-'));
  const database = new Database(':memory:');
  // User 1 owns project p1; nobody owns p2.
  const project = (userId: number, id: string) => userId === 1 && id === 'p1' ? { name: '超级教授', description: '教学网站' } : null;
  const service = createStudioService({ database, vaultDirectory: directory, request, project, snrAuthorization });
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

test('an owner key file supplies the DeepSeek key when none is saved, and a saved key wins', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'studio-keyfile-'));
  const keyFile = path.join(directory, '.env');
  writeFileSync(keyFile, 'OTHER=1\nDEEPSEEK_API_KEY="fake-file-key-0123456789"\n');
  const database = new Database(':memory:');
  const seen: string[] = [];
  const request = (async (_url: string, init?: RequestInit) => {
    seen.push(String((init?.headers as Record<string, string>).Authorization));
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;
  const service = createStudioService({ database, vaultDirectory: directory, request, deepseekKeyFile: keyFile });
  try {
    assert.deepEqual([service.status(1).deepseek.configured, service.status(1).deepseek.source], [true, 'file']);
    assert.ok(!JSON.stringify(service.status(1)).includes('fake-file-key'));
    await service.testKey(1);
    assert.equal(seen.at(-1), 'Bearer fake-file-key-0123456789');
    service.saveKey(1, 'fake-vault-key-0123456789');
    assert.equal(service.status(1).deepseek.source, 'vault');
    await service.testKey(1);
    assert.equal(seen.at(-1), 'Bearer fake-vault-key-0123456789');
    service.removeKey(1);
    assert.equal(service.status(1).deepseek.source, 'file');
    rmSync(keyFile);
    assert.deepEqual([service.status(1).deepseek.configured, service.status(1).deepseek.source], [false, null]);
  } finally { database.close(); rmSync(directory, { recursive: true }); }
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

test('each project keeps an isolated DeepSeek history; foreign and unknown spaces are rejected', () => {
  const f = fixture();
  try {
    const general = f.service.createConversation(1, 'deepseek-flash');
    const professor = f.service.createConversation(1, 'deepseek-v4-pro', 'project:p1');
    assert.equal(general.space, 'deepseek');
    assert.equal(professor.space, 'project:p1');
    assert.deepEqual(f.service.listConversations(1).map(row => (row as { id: string }).id), [general.id]);
    assert.deepEqual(f.service.listConversations(1, 'project:p1').map(row => (row as { id: string }).id), [professor.id]);
    assert.throws(() => f.service.listConversations(2, 'project:p1'), /未知的对话空间/);
    assert.throws(() => f.service.createConversation(1, 'deepseek-flash', 'project:p2'), /未知的对话空间/);
    assert.throws(() => f.service.listConversations(1, 'snr-trading'), /未知的对话空间/);
    assert.throws(() => f.service.createConversation(1, 'deepseek-flash', '__proto__'), /未知的对话空间/);
    f.service.removeSpace(1, 'project:p1');
    assert.equal(f.service.listConversations(1, 'project:p1').length, 0);
    assert.equal(f.service.listConversations(1).length, 1);
  } finally { f.close(); }
});

test('project conversations tell DeepSeek which project they belong to, framed as background data', async () => {
  let body = '';
  const f = fixture((async (_url, init) => {
    body = String(init?.body);
    return Response.json({ choices: [{ message: { content: '好的' } }] });
  }) as typeof fetch);
  try {
    f.service.saveKey(1, 'fake-unit-test-key-not-valid');
    const row = f.service.createConversation(1, 'deepseek-flash', 'project:p1');
    await f.service.send(1, row.id, '下一步？', false, new AbortController().signal);
    const system = (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages[0].content;
    assert.ok(system.includes('「超级教授」'));
    assert.ok(system.includes('仅作背景资料'));
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
    assert.equal(service.listConversations(1, 'deepseek').length, 1);
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

test('explicit SNR context only reads health, dataset and manifest endpoints', async () => {
  const urls: string[] = [];
  let sent = '';
  const f = fixture((async (url, init) => {
    urls.push(String(url));
    if (String(url).endsWith('/api/health')) return Response.json({ status: 'ok', phase: 5, trading_enabled: false, rules_approved: false });
    if (String(url).endsWith('/api/datasets')) return Response.json([{ id: 1 }]);
    if (String(url).endsWith('/api/integration/v1/manifest')) return Response.json({ name: 'SNR3.0', api: { version: 1, health: '/api/health' } });
    sent = String(init?.body);
    return Response.json({ choices: [{ message: { content: '测试回复' } }] });
  }) as typeof fetch);
  try {
    f.service.saveKey(1, 'fake-unit-test-key-not-valid');
    const row = f.service.createConversation(1, 'deepseek-v4-pro');
    await f.service.send(1, row.id, '看研究状态', true, new AbortController().signal);
    assert.deepEqual(urls, [
      'http://127.0.0.1:8768/api/health', 'http://127.0.0.1:8768/api/datasets',
      'http://127.0.0.1:8768/api/integration/v1/manifest', 'https://api.deepseek.com/chat/completions',
    ]);
    assert.ok(sent.includes('datasetCount'));
    assert.ok(sent.includes('SNR3.0'));
    assert.ok(!sent.includes('"id":1'));
    assert.ok(!sent.includes('/api/health'));
  } finally { f.close(); }
});

// A fake SNR whose manifest endpoint answers with `manifest`; health and datasets are healthy.
function snrFixture(manifest: () => Response | Promise<Response>, snrAuthorization?: () => string | null) {
  const calls: { url: string; authorization?: string }[] = [];
  const f = fixture((async (url, init) => {
    calls.push({ url: String(url), authorization: (init?.headers as Record<string, string> | undefined)?.Authorization });
    if (String(url).endsWith('/api/health')) return Response.json({ status: 'ok', phase: 5, trading_enabled: false, rules_approved: false });
    if (String(url).endsWith('/api/datasets')) return Response.json({ datasets: [{ id: 'a' }, { id: 'b' }] });
    return manifest();
  }) as typeof fetch, snrAuthorization);
  return { ...f, calls };
}

test('SNR status carries a short manifest derived from the lab integration endpoint', async () => {
  // Trimmed copy of what snr3-lab's app/integration.py publishes.
  const f = snrFixture(() => Response.json({
    schema_version: 1, application_id: 'snr3-lab', name: 'SNR3.0',
    icon: { path: '/static/app-icon.svg', media_type: 'image/svg+xml' },
    api: {
      version: 1, manifest: '/api/integration/v1/manifest', health: '/api/health', datasets: '/api/datasets',
      session: '/api/sessions/{session_id}', context: '/api/integration/v1/sessions/{session_id}/context',
      context_required_query: ['expected_as_of', 'expected_timeframe'],
      exports: { drawings: '/api/sessions/{session_id}/levels/export' },
    },
    security: { authentication: 'local_only' },
  }));
  try {
    assert.deepEqual(await f.service.snrStatus(), {
      connected: true, phase: 5, tradingEnabled: false, rulesApproved: false, datasetCount: 2,
      manifest: { name: 'SNR3.0', version: '1', capabilities: ['manifest', 'health', 'datasets', 'session', 'context', 'exports'] },
    });
  } finally { f.close(); }
});

test('an untrusted manifest is reduced to capped, plain strings', async () => {
  const f = snrFixture(() => Response.json({
    name: `Lab\u0000‮<script>alert(1)</script>${'x'.repeat(500)}`,
    version: { nested: true },
    api: { version: '9.9.9-rc+1' },
    capabilities: [
      'replay', 'replay', 'session:read', 'export/drawings', 'ok-1', 42, null, { a: 1 },
      '<img src=x>', 'tab\there', 'a'.repeat(81), ' padded ',
      ...Array.from({ length: 40 }, (_, index) => `cap.${index}`),
    ],
  }));
  try {
    const status = await f.service.snrStatus() as { manifest?: { name?: string; version?: string; capabilities?: string[] } };
    const manifest = status.manifest!;
    assert.ok(manifest.name!.length <= 80);
    assert.ok(manifest.name!.startsWith('Lab script alert(1) /script xxx'));
    assert.match(manifest.name!, /^[\p{L}\p{N} ._:/()+#-]+$/u);
    assert.equal(manifest.version, '9.9.9-rc+1');
    assert.equal(manifest.capabilities!.length, 20);
    assert.deepEqual(manifest.capabilities!.slice(0, 6), ['replay', 'session:read', 'export/drawings', 'ok-1', 'padded', 'cap.0']);
    for (const capability of manifest.capabilities!) assert.match(capability, /^[A-Za-z0-9 ._:/-]{1,80}$/);
  } finally { f.close(); }
});

test('manifest failures leave SNR connected and simply omit the manifest', async () => {
  const cases: [string, () => Response | Promise<Response>][] = [
    ['missing endpoint', () => new Response('not found', { status: 404 })],
    ['network error', () => Promise.reject(new Error('offline'))],
    ['invalid JSON', () => new Response('{"name":', { headers: { 'Content-Type': 'application/json' } })],
    ['oversized body', () => new Response(JSON.stringify({ name: 'SNR3.0', padding: 'x'.repeat(70 * 1024) }))],
    ['not an object', () => Response.json(['SNR3.0'])],
    ['nothing usable', () => Response.json({ name: '\u0000\u0001', capabilities: ['<b>'] })],
  ];
  for (const [label, manifest] of cases) {
    const f = snrFixture(manifest);
    try {
      const status = await f.service.snrStatus();
      assert.equal(status.connected, true, label);
      assert.equal('manifest' in status, false, label);
      assert.equal((status as { datasetCount?: number }).datasetCount, 2, label);
    } finally { f.close(); }
  }
});

test('a configured SNR credential goes to every status read; a broken one makes no request', async () => {
  const credential = 'Basic dW5pdC10ZXN0OmZha2UtcGFzc3dvcmQ=';
  const f = snrFixture(() => Response.json({ name: 'SNR3.0' }), () => credential);
  try {
    await f.service.snrStatus();
    assert.deepEqual(f.calls.map(call => call.authorization), [credential, credential, credential]);
  } finally { f.close(); }
  const rejected = fixture((async () => new Response('{"detail":"Authentication required"}', { status: 401 })) as typeof fetch, () => credential);
  try {
    assert.deepEqual(await rejected.service.snrStatus(), { connected: false, reason: 'SNR 拒绝了配置的认证' });
  } finally { rejected.close(); }
  const broken = snrFixture(() => Response.json({}), () => { throw new Error('unreadable password file'); });
  try {
    assert.deepEqual(await broken.service.snrStatus(), { connected: false, reason: 'SNR 认证配置不可用' });
    assert.equal(broken.calls.length, 0);
  } finally { broken.close(); }
  const open = snrFixture(() => Response.json({}));
  try {
    await open.service.snrStatus();
    assert.ok(open.calls.every(call => call.authorization === undefined));
  } finally { open.close(); }
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
