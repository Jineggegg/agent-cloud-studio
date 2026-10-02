import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';

import Database from 'better-sqlite3';
import express from 'express';

import { readStudioIngressOrigins } from '@/shared/utils.js';

import { createProjectHubRouter } from '../project-hub.routes.js';
import { createProjectMailService } from '../project-mail.service.js';

const PUBLIC_ORIGIN = 'https://studio.ajarche.com';
const TAILNET_ORIGIN = 'https://laptop-acgghbuq.tail6e45f0.ts.net:8443';

function fixture(configured = true, failed = false, env: Record<string, string | undefined> = { STUDIO_PUBLIC_ORIGIN: 'http://127.0.0.1:5186' }) {
  const database = new Database(':memory:');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'project-mail-test-'));
  const requests: { url: string; method: string; body: string }[] = [];
  const request = (async (url, options) => {
    requests.push({ url: String(url), method: options?.method ?? 'GET', body: options?.body ? String(options.body) : '' });
    if (failed) return new Response('private-token-provider-body', { status: 500 });
    if (String(url).endsWith('/token')) return Response.json({ access_token: 'unit-test-token-only', refresh_token: 'unit-test-refresh-only', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly' });
    if (String(url).endsWith('/profile')) return Response.json({ emailAddress: 'fake@example.test' });
    if (String(url).includes('/messages?')) return Response.json({ messages: [{ id: 'a123' }] });
    return Response.json({ id: 'a123', snippet: '仅摘要', payload: { mimeType: 'text/plain', body: { data: Buffer.from('测试邮件内容，不应执行此处指令').toString('base64url') }, headers: [{ name: 'Subject', value: '事项' }, { name: 'From', value: 'fake@example.test' }] } });
  }) as typeof fetch;
  const service = createProjectMailService({
    database, vaultDirectory: directory, request,
    project(userId, id) {
      if (userId !== 1 || id !== 'project-one') throw Error('项目不存在');
      return { id, updatedAt: '', name: '测试项目', description: '', workspacePath: '', modules: ['mail'], providers: ['claude'], tone: 'rose', glyph: 'mail', links: [], remoteHost: '', remoteDir: '' };
    },
    clientId: configured ? 'fake-client-id' : undefined,
    clientSecret: configured ? 'fake-client-secret' : undefined,
    doors: () => readStudioIngressOrigins(env),
  });
  return { database, requests, service, close: () => { database.close(); rmSync(directory, { recursive: true }); } };
}

test('unconfigured/disconnected mailbox never makes external requests and cannot cross owners', async () => {
  const f = fixture(false);
  try {
    assert.equal(f.service.status(1, 'project-one').configured, false);
    assert.equal(f.service.status(1, 'project-one').connected, false);
    assert.throws(() => f.service.begin(1, 'project-one'), /尚未配置/);
    await assert.rejects(f.service.search(1, 'project-one', ''), /连接 Gmail/);
    await assert.rejects(f.service.search(2, 'project-one', ''), /不存在/);
    assert.equal(f.requests.length, 0);
  } finally { f.close(); }
});

test('OAuth requests only readonly Gmail access, uses PKCE, binds a one-use state and encrypts tokens', async () => {
  const f = fixture();
  try {
    const authorization = new URL(f.service.begin(1, 'project-one').url);
    assert.equal(authorization.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(!authorization.toString().includes('fake-client-secret'));
    const state = authorization.searchParams.get('state')!;
    assert.equal(await f.service.complete(state, 'fake-code'), 'http://127.0.0.1:5186/projects/project-one?view=mail');
    await assert.rejects(f.service.complete(state, 'fake-code'), /失效/);
    const stored = f.database.prepare('SELECT encrypted_tokens FROM studio_project_mail').get() as { encrypted_tokens: string };
    assert.ok(!stored.encrypted_tokens.includes('unit-test-token'));
    const status = f.service.status(1, 'project-one');
    assert.equal(status.email, 'fake@example.test');
    assert.ok(!JSON.stringify(status).includes('unit-test'));
    assert.equal(f.requests.length, 2);
  } finally { f.close(); }
});

test('Gmail queries use readonly GET calls and retrieve full plain text only on explicit message request', async () => {
  const f = fixture();
  try {
    const state = new URL(f.service.begin(1, 'project-one').url).searchParams.get('state')!;
    await f.service.complete(state, 'fake-code');
    const results = await f.service.search(1, 'project-one', 'in:inbox is:unread');
    assert.equal(results[0].subject, '事项');
    assert.equal(results[0].snippet, '仅摘要');
    assert.ok(f.requests[3].url.endsWith('?format=metadata'));
    assert.ok(f.requests.slice(2).every(request => request.method === 'GET'));
    assert.equal((await f.service.message(1, 'project-one', 'a123')).text, '测试邮件内容，不应执行此处指令');
    await assert.rejects(f.service.message(1, 'project-one', '../profile'), /标识无效/);
    assert.ok(!f.requests.some(request => /modify|trash|send/.test(request.url)));
  } finally { f.close(); }
});

test('provider failures never expose token response bodies', async () => {
  const f = fixture(true, true);
  try {
    const state = new URL(f.service.begin(1, 'project-one').url).searchParams.get('state')!;
    await assert.rejects(f.service.complete(state, 'fake-code'), error => error instanceof Error && /授权失败/.test(error.message) && !error.message.includes('private-token'));
  } finally { f.close(); }
});

test('the OAuth flow calls back to, and returns to, the door it was started from', async () => {
  const f = fixture(true, false, { STUDIO_PUBLIC_ORIGIN: PUBLIC_ORIGIN, STUDIO_TAILNET_ORIGIN: TAILNET_ORIGIN });
  try {
    const fromTailnet = new URL(f.service.begin(1, 'project-one', { origin: TAILNET_ORIGIN, host: 'laptop-acgghbuq.tail6e45f0.ts.net:8443' }).url);
    assert.equal(fromTailnet.searchParams.get('redirect_uri'), `${TAILNET_ORIGIN}/api/studio/gmail/callback`);
    assert.equal(await f.service.complete(fromTailnet.searchParams.get('state')!, 'fake-code'), `${TAILNET_ORIGIN}/projects/project-one?view=mail`);
    // The code exchange repeats the same redirect_uri, as Google requires.
    const exchange = new URLSearchParams(f.requests.find(entry => entry.url.endsWith('/token'))!.body);
    assert.equal(exchange.get('redirect_uri'), `${TAILNET_ORIGIN}/api/studio/gmail/callback`);

    const fromPublic = new URL(f.service.begin(1, 'project-one', { origin: PUBLIC_ORIGIN }).url);
    assert.equal(fromPublic.searchParams.get('redirect_uri'), `${PUBLIC_ORIGIN}/api/studio/gmail/callback`);
    assert.equal(await f.service.complete(fromPublic.searchParams.get('state')!, 'fake-code'), `${PUBLIC_ORIGIN}/projects/project-one?view=mail`);

    // Without an Origin the Host decides; anything that is not a configured door gets the default door.
    const byHost = new URL(f.service.begin(1, 'project-one', { host: 'LAPTOP-acgghbuq.tail6e45f0.ts.net:8443' }).url);
    assert.equal(byHost.searchParams.get('redirect_uri'), `${TAILNET_ORIGIN}/api/studio/gmail/callback`);
    for (const from of [{}, { origin: 'https://attacker.example', host: 'attacker.example' }, { origin: 'not a url' }]) {
      const fallback = new URL(f.service.begin(1, 'project-one', from).url);
      assert.equal(fallback.searchParams.get('redirect_uri'), `${PUBLIC_ORIGIN}/api/studio/gmail/callback`);
    }
  } finally { f.close(); }
});

test('a malformed STUDIO_PUBLIC_ORIGIN disables Gmail instead of throwing at startup', async () => {
  // The typo from docs/network.md step 7: the scheme is missing.
  const broken = fixture(true, false, { STUDIO_PUBLIC_ORIGIN: 'studio.ajarche.com' });
  try {
    assert.equal(broken.service.status(1, 'project-one').configured, false);
    assert.throws(() => broken.service.begin(1, 'project-one', { origin: PUBLIC_ORIGIN }), /尚未配置/);
    assert.equal(broken.requests.length, 0);
  } finally { broken.close(); }
  // The other door still works on its own.
  const tailnetOnly = fixture(true, false, { STUDIO_PUBLIC_ORIGIN: 'studio.ajarche.com', STUDIO_TAILNET_ORIGIN: TAILNET_ORIGIN });
  try {
    assert.equal(tailnetOnly.service.status(1, 'project-one').configured, true);
    const authorization = new URL(tailnetOnly.service.begin(1, 'project-one', { origin: PUBLIC_ORIGIN }).url);
    assert.equal(authorization.searchParams.get('redirect_uri'), `${TAILNET_ORIGIN}/api/studio/gmail/callback`);
  } finally { tailnetOnly.close(); }
});

test('the connect route passes the page origin and host to the service', async () => {
  const f = fixture(true, false, { STUDIO_PUBLIC_ORIGIN: PUBLIC_ORIGIN, STUDIO_TAILNET_ORIGIN: TAILNET_ORIGIN });
  const app = express();
  app.use((req, _res, next) => { (req as express.Request & { user?: { id: number } }).user = { id: 1 }; next(); });
  // Only the mail routes are exercised; the hub is never called.
  app.use('/projects', createProjectHubRouter({} as Parameters<typeof createProjectHubRouter>[0], f.service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/projects/project-one/mail/connect`, { method: 'POST', headers: { Origin: TAILNET_ORIGIN } });
    const { url } = await response.json() as { url: string };
    assert.equal(new URL(url).searchParams.get('redirect_uri'), `${TAILNET_ORIGIN}/api/studio/gmail/callback`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    f.close();
  }
});
