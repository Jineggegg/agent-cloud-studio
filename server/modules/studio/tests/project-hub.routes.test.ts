import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';

import Database from 'better-sqlite3';
import express from 'express';

import { AppError } from '@/shared/utils.js';

import { createProjectHubService } from '../project-hub.service.js';
import { createProjectMailService } from '../project-mail.service.js';
import { createProjectHubRouter } from '../project-hub.routes.js';

test('project routes validate transport input, ownership and disabled modules before accessing external services', async () => {
  const database = new Database(':memory:');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'project-route-test-'));
  let externalCalls = 0;
  const hub = createProjectHubService({
    database,
    resolveWorkspace: async () => { externalCalls++; return { projectId: 'native', path: '/test' }; },
    listSessions: () => [],
    pendingSchedules: () => 0,
    schedule: () => { externalCalls++; return { id: 'scheduled' }; },
  });
  const mail = createProjectMailService({ database, vaultDirectory: directory, project: hub.get });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = Number(req.get('x-test-user'));
    if (id) (req as express.Request & { user?: { id: number } }).user = { id };
    next();
  });
  app.use('/projects', createProjectHubRouter(hub, mail));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ error: error instanceof Error ? error.message : 'error' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(route: string, user = '1', body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    return fetch(`${origin}/projects${route}`, {
      method, headers: { 'x-test-user': user, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  try {
    assert.equal((await request('', '')).status, 401);
    const list = await request('');
    assert.equal(list.headers.get('Cache-Control'), 'no-store');
    const [project] = await list.json() as { id: string }[];
    // None of the built-in projects enables mail, so a mail-only project is created for the mailbox checks.
    const created = await request('', '1', { name: '邮件', description: '', workspacePath: '', providers: [], modules: ['mail'], tone: 'rose', glyph: 'mail' });
    assert.equal(created.status, 201);
    const mailProject = await created.json() as { id: string };
    assert.equal((await request(`/${project.id}`, '2')).status, 404);
    assert.equal((await request('', '1', { name: 'bad', providers: 'claude', modules: [] })).status, 400);
    assert.equal((await request(`/${project.id}/launch`, '1', { provider: 42 })).status, 400);
    assert.equal((await request(`/${mailProject.id}/mail/messages?q=a&q=b`)).status, 400);
    assert.equal((await request(`/${mailProject.id}/mail/connect`, '1', {})).status, 503);
    assert.equal((await request(`/${mailProject.id}`, '2', undefined, 'DELETE')).status, 404);
    assert.equal((await request(`/${mailProject.id}`, '1', undefined, 'DELETE')).status, 200);
    const input = { name: '项目', description: '', workspacePath: '', providers: ['claude'], modules: ['agents'] };
    assert.equal((await request(`/${project.id}`, '1', input, 'PUT')).status, 200);
    assert.equal((await request(`/${project.id}/mail/messages`)).status, 400);
    assert.equal((await request(`/${project.id}/tasks`, '1', { title: '草稿', prompt: 'test', provider: 'claude' })).status, 400);
    assert.equal(externalCalls, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    database.close(); rmSync(directory, { recursive: true });
  }
});
