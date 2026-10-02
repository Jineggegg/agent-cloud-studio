import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import { createMemoryRouter } from '../memory/memory.routes.js';
import { createMemoryService } from '../memory/memory.service.js';

import { createFakeMemory } from './memory-fakes.js';

// Signs a request in as the user named by x-test-user, the way authenticateToken sets req.user.
function app(service: ReturnType<typeof createMemoryService>) {
  const target = express();
  target.use((req, _res, next) => {
    const id = Number(req.get('x-test-user'));
    if (id) (req as express.Request & { user?: { id: number } }).user = { id };
    next();
  });
  target.use('/api/studio/memory', createMemoryRouter(service));
  target.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error instanceof AppError ? error.statusCode : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : 'error', code: error instanceof AppError ? error.code : undefined });
  });
  return target;
}
async function withServer(target: express.Express, run: (base: string) => Promise<void>) {
  const server = target.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/studio/memory`); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

function fixture() {
  const fake = createFakeMemory([
    { permalink: 'studio/global/语言偏好', title: '语言偏好', content: '回答使用简体中文。', tags: ['deepseek'] },
    { permalink: 'studio/agent-cloud-studio/部署', title: '部署', content: '端口 3002。', tags: ['claude'] },
  ]);
  const service = createMemoryService({ client: fake.client, url: 'http://127.0.0.1:8770/mcp', deepseekEnabled: false, home: '/nowhere', readText: () => null });
  return { fake, service };
}

test('every memory route requires a signed-in user and is never cached', async () => {
  const { fake, service } = fixture();
  await withServer(app(service), async base => {
    for (const [method, url] of [['GET', '/status'], ['GET', '/notes'], ['GET', '/search?q=x'], ['GET', '/note?id=studio/global/x'], ['DELETE', '/note?id=studio/global/x']]) {
      const response = await fetch(`${base}${url}`, { method });
      assert.equal(response.status, 401, `${method} ${url}`);
    }
    const status = await fetch(`${base}/status`, { headers: { 'x-test-user': '1' } });
    assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.equal((await status.json() as { reachable: boolean }).reachable, true);
  });
  assert.equal(fake.calls.length, 1, 'anonymous requests never reach the memory server');
});

test('listing, search, reading and deleting go through the memory service', async () => {
  const { fake, service } = fixture();
  await withServer(app(service), async base => {
    const headers = { 'x-test-user': '1' };
    const recent = await (await fetch(`${base}/notes?folder=global`, { headers })).json() as { notes: { id: string }[]; folders: { name: string }[] };
    assert.deepEqual(recent.notes.map(note => note.id), ['studio/global/语言偏好']);
    assert.deepEqual(recent.folders.map(folder => folder.name), ['global', 'agent-cloud-studio']);

    const found = await (await fetch(`${base}/search?q=${encodeURIComponent('端口')}`, { headers })).json() as { notes: { id: string; source: string }[] };
    assert.deepEqual(found.notes.map(note => [note.id, note.source]), [['studio/agent-cloud-studio/部署', 'claude']]);
    const empty = await (await fetch(`${base}/search?q=%20`, { headers })).json() as { notes: unknown[] };
    assert.deepEqual(empty.notes, []);

    const id = encodeURIComponent('studio/agent-cloud-studio/部署');
    const note = await (await fetch(`${base}/note?id=${id}`, { headers })).json() as { content: string };
    assert.equal(note.content, '端口 3002。');
    const removed = await fetch(`${base}/note?id=${id}`, { method: 'DELETE', headers });
    assert.deepEqual(await removed.json(), { deleted: true });
    assert.equal((await fetch(`${base}/note?id=${id}`, { headers })).status, 404);
  });
  assert.equal(fake.store.size, 1);
});

test('malformed parameters are rejected before any memory call', async () => {
  const { fake, service } = fixture();
  await withServer(app(service), async base => {
    const headers = { 'x-test-user': '1' };
    const bad = [
      '/note?id=', '/note?id=%2Fetc%2Fpasswd', '/note?id=studio%2F..%2Fsecret', '/note?id=a%5Cb', '/note?id=a&id=b',
      `/search?q=${'x'.repeat(201)}`, '/search?q=a&q=b', '/notes?folder=..', '/notes?folder=a%2Fb',
    ];
    for (const url of bad) {
      const response = await fetch(`${base}${url}`, { headers });
      assert.equal(response.status, 400, url);
    }
  });
  assert.equal(fake.calls.length, 0);
});

test('a stopped memory server answers 503 with a readable message', async () => {
  const { fake, service } = fixture();
  fake.state.down = true;
  await withServer(app(service), async base => {
    const response = await fetch(`${base}/notes`, { headers: { 'x-test-user': '1' } });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: '共享记忆服务未运行或无法连接', code: 'MEMORY_UNAVAILABLE' });
    const status = await (await fetch(`${base}/status`, { headers: { 'x-test-user': '1' } })).json() as { reachable: boolean };
    assert.equal(status.reachable, false);
  });
});
