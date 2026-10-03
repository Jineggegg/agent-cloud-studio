import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import Database from 'better-sqlite3';
import express from 'express';

import type { StudioProjectRecord, StudioPushMessage } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createAutomationsRouter } from '../automations/automations.routes.js';
import { createAutomationsService } from '../automations/automations.service.js';

const PROJECT: StudioProjectRecord = {
  id: 'prof', name: '超级教授', description: '', workspacePath: '', modules: ['agents', 'automations'], providers: ['claude'], tone: 'clay', glyph: 'graduation',
  links: [], remoteHost: '', remoteDir: '', updatedAt: '', product: 'professor', automation: { notify: true, mailAccountId: 'gmail-1', morningTime: '08:00' },
};

test('automation routes plan, create, switch, run and delete for the signed-in owner only, with fake mail and push', async () => {
  const database = new Database(':memory:');
  const sent: StudioPushMessage[] = [];
  const mailReads: unknown[] = [];
  const service = createAutomationsService({
    database,
    project(userId, id) {
      if (userId !== 1 || id !== 'prof') throw new AppError('项目不存在', { statusCode: 404 });
      return PROJECT;
    },
    mail: {
      accounts: () => ({ accounts: [{ id: 'gmail-1', provider: 'gmail-imap', email: 'me@example.test' }] }),
      async messages(_userId, input) {
        mailReads.push(input);
        return { messages: [{ id: 'm1', subject: '期中考试', from: '王老师', fromAddress: 'wang@example.test', date: new Date(Date.now() - 60_000).toISOString(), snippet: '…', unread: true }], errors: [] };
      },
    },
    push: {
      status: () => ({ enabled: true, devices: 1 }),
      async send(_userId, message) { sent.push(message); return { enabled: true, devices: 1, delivered: 1 }; },
    },
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = Number(req.get('x-test-user'));
    if (id) (req as express.Request & { user?: { id: number } }).user = { id };
    next();
  });
  app.use('/automations', createAutomationsRouter(service));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ error: error instanceof Error ? error.message : 'error' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, route: string, body?: unknown, userId = '1') => fetch(`${origin}/automations${route}`, {
    method, headers: { 'x-test-user': userId, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    assert.equal((await call('GET', '/projects/prof', undefined, '')).status, 401);
    assert.equal((await call('GET', '/projects/prof', undefined, '2')).status, 404);
    assert.deepEqual(await (await call('GET', '/push')).json(), { enabled: true, devices: 1 });

    const planned = await call('POST', '/projects/prof/plan', { text: '每天早上读一下我邮箱里超级教授相关的邮件，有重要的就通知我', timeZone: 'Asia/Shanghai' });
    assert.equal(planned.status, 200);
    const plan = await planned.json() as { draft: Record<string, unknown>; needs: string[] };
    assert.deepEqual(plan.needs, []);
    assert.deepEqual(plan.draft.action, { kind: 'mail-digest', accountId: 'gmail-1', query: '超级教授', notifyWhen: 'important', useAi: false });
    const refused = await call('POST', '/projects/prof/plan', { text: '每天把超级教授的邮件转发给老板', timeZone: 'Asia/Shanghai' });
    assert.equal(refused.status, 422);
    assert.equal((await call('POST', '/projects/prof/plan', { text: 42, timeZone: 'Asia/Shanghai' })).status, 400);

    assert.equal((await call('POST', '/projects/prof', { ...plan.draft, action: { kind: 'mail-digest', accountId: 'gmail-1' } })).status, 400);
    const createdResponse = await call('POST', '/projects/prof', plan.draft);
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { id: string; enabled: boolean; nextRunAt: string };
    assert.equal(created.enabled, true);
    assert.ok(created.nextRunAt);
    // Nothing was read or pushed by planning and creating.
    assert.deepEqual(mailReads, []);
    assert.deepEqual(sent, []);

    assert.equal((await call('PATCH', `/${created.id}`, { enabled: 'no' })).status, 400);
    assert.equal((await call('PATCH', `/${created.id}`, { enabled: false }, '2')).status, 404);
    const off = await (await call('PATCH', `/${created.id}`, { enabled: false })).json() as { enabled: boolean; nextRunAt: string | null };
    assert.deepEqual([off.enabled, off.nextRunAt], [false, null]);

    const ran = await (await call('POST', `/${created.id}/run`)).json() as { lastRun: { status: string; summary: string } };
    assert.equal(ran.lastRun.status, 'notified');
    assert.equal(sent.length, 1);
    assert.equal(mailReads.length, 1);

    assert.equal((await call('DELETE', `/${created.id}`, undefined, '2')).status, 404);
    assert.deepEqual(await (await call('DELETE', `/${created.id}`)).json(), { deleted: true });
    assert.deepEqual(await (await call('GET', '/projects/prof')).json(), []);
  } finally {
    server.close();
    database.close();
  }
});
