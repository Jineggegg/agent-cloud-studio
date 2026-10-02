import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';

import Database from 'better-sqlite3';
import express from 'express';

import type { StudioBuildRunner } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createProjectHubService } from '../project-hub.service.js';
import { createStudioBuildsService } from '../builds.service.js';
import { createStudioBuildsRouter } from '../builds.routes.js';

test('build routes validate transport input and ownership and return the build with its project', async () => {
  const database = new Database(':memory:');
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'build-route-test-')));
  let turns = 0;
  const runner: StudioBuildRunner = {
    start: () => { turns += 1; return new Promise(() => {}); },
    abort: async () => true,
    inspect: () => null,
    readChecklist: async () => null,
    environment: () => ({ mode: 'restricted', missing: ['bubblewrap', 'socat'], available: false }),
  };
  const hub = createProjectHubService({
    database, resolveWorkspace: async () => ({ projectId: 'unused', path: '/' }), listSessions: () => [], pendingSchedules: () => 0, schedule: () => ({ id: 'x' }),
  });
  const builds = createStudioBuildsService({
    database, root: directory, hub, runner, resumeDelayMs: 0,
    initRepository: async () => {},
    resolveWorkspace: async folder => ({ projectId: 'ide-project', path: folder }),
    createSession: () => ({ sessionId: 'app-session' }),
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = Number(req.get('x-test-user'));
    if (id) (req as express.Request & { user?: { id: number } }).user = { id };
    next();
  });
  app.use('/builds', createStudioBuildsRouter(builds));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ error: error instanceof Error ? error.message : 'error' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (route: string, user = '1', body?: unknown) => fetch(`${origin}/builds${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'x-test-user': user, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    assert.equal((await request('', '')).status, 401);
    const empty = await request('');
    assert.equal(empty.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await empty.json(), []);
    assert.equal((await request('/environment', '')).status, 401);
    assert.deepEqual(await (await request('/environment')).json(), { mode: 'restricted', missing: ['bubblewrap', 'socat'], available: false });
    assert.equal((await request('', '1', { name: 'Notes', tone: 'sage', glyph: 'book', prompt: 42 })).status, 400);
    assert.equal((await request('', '1', { name: 'Notes', tone: 'sage', prompt: '记事本' })).status, 400);
    assert.equal(turns, 0);

    const created = await request('', '1', { name: 'Notes', tone: 'sage', glyph: 'book', prompt: '一个支持 Markdown 的记事本' });
    assert.equal(created.status, 201);
    const { build, project } = await created.json() as { build: { id: string; state: string; sessionId: string; ideProjectId: string }; project: { id: string; name: string } };
    assert.deepEqual([build.state, build.sessionId, build.ideProjectId, project.name], ['building', 'app-session', 'ide-project', 'Notes']);
    assert.equal(turns, 1);

    assert.equal((await request(`/${build.id}`, '2')).status, 404);
    assert.equal((await request(`/${build.id}`)).status, 200);
    assert.equal((await request(`/${build.id}/continue`, '1', { message: 7 })).status, 400);
    assert.equal((await request(`/${build.id}/continue`, '1', {})).status, 409);
    assert.equal((await request(`/${build.id}/cancel`, '2', {})).status, 404);
    const cancelled = await request(`/${build.id}/cancel`, '1', {});
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json() as { error: string }).error, '已取消');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
