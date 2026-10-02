import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import { createMailRouter } from '../mail/mail.routes.js';
import type { createMailService } from '../mail/mail.service.js';

type Service = ReturnType<typeof createMailService>;

async function serve(service: Partial<Service>, userId: number | null = 7) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (userId) (req as express.Request & { user?: { id: number } }).user = { id: userId }; next(); });
  app.use('/mail', createMailRouter(service as Service));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ error: error instanceof Error ? error.message : 'error' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mail`;
  return { origin, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test('mail routes parse input, pass the signed-in user and never cache responses', async () => {
  const seen: unknown[][] = [];
  const service: Partial<Service> = {
    accounts: userId => { seen.push(['accounts', userId]); return { accounts: [], outlookConfigured: false }; },
    addGmailImap: async (userId, input) => { seen.push(['imap', userId, input]); return { id: 'a1', provider: 'gmail-imap', email: input.email, displayName: '', status: 'ok', lastError: null, createdAt: '' }; },
    startOutlookDevice: async userId => { seen.push(['device', userId]); return { pollId: 'p1', userCode: 'CODE', verificationUri: 'https://microsoft.com/devicelogin', expiresAt: '', interval: 5 }; },
    pollOutlookDevice: async (userId, pollId) => { seen.push(['poll', userId, pollId]); return { status: 'pending' }; },
    removeAccount: (userId, id) => { seen.push(['remove', userId, id]); return { removed: true }; },
    messages: async (userId, input) => { seen.push(['messages', userId, input]); return { messages: [], errors: [] }; },
    message: async (userId, accountId, messageId) => {
      seen.push(['message', userId, accountId, messageId]);
      return { id: messageId, accountId, subject: '', from: '', fromAddress: '', date: '', snippet: '', unread: false, to: '', text: '', truncated: false };
    },
  };
  const server = await serve(service);
  try {
    const accounts = await fetch(`${server.origin}/accounts`);
    assert.equal(accounts.status, 200);
    assert.equal(accounts.headers.get('Cache-Control'), 'no-store');
    const added = await fetch(`${server.origin}/accounts/imap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'me@gmail.test', password: 'abcd efgh ijkl mnop' }) });
    assert.equal(added.status, 201);
    assert.ok(!(await added.text()).includes('abcd'));
    assert.equal((await fetch(`${server.origin}/accounts/imap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'me@gmail.test' }) })).status, 400);
    assert.equal((await fetch(`${server.origin}/accounts/outlook/device`, { method: 'POST' })).status, 201);
    assert.equal((await fetch(`${server.origin}/accounts/outlook/device/p1`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${server.origin}/accounts/a1`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${server.origin}/messages?accountId=a1&q=${encodeURIComponent('is:unread')}&limit=10`)).status, 200);
    assert.equal((await fetch(`${server.origin}/messages`)).status, 200);
    for (const limit of ['0', '51', '2.5', 'ten']) assert.equal((await fetch(`${server.origin}/messages?limit=${limit}`)).status, 400, limit);
    assert.equal((await fetch(`${server.origin}/messages?q=a&q=b`)).status, 400);
    assert.equal((await fetch(`${server.origin}/messages/a1/${encodeURIComponent('AAMk/+x=')}`)).status, 200);
    assert.deepEqual(seen, [
      ['accounts', 7],
      ['imap', 7, { email: 'me@gmail.test', password: 'abcd efgh ijkl mnop' }],
      ['device', 7],
      ['poll', 7, 'p1'],
      ['remove', 7, 'a1'],
      ['messages', 7, { accountId: 'a1', query: 'is:unread', limit: 10 }],
      ['messages', 7, { accountId: undefined, query: undefined, limit: undefined }],
      ['message', 7, 'a1', 'AAMk/+x='],
    ]);
  } finally { await server.close(); }
});

test('mail routes require a signed-in user', async () => {
  const server = await serve({ accounts: () => ({ accounts: [], outlookConfigured: false }) }, null);
  try {
    assert.equal((await fetch(`${server.origin}/accounts`)).status, 401);
  } finally { await server.close(); }
});
