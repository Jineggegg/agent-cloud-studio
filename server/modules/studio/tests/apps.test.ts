import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import {
  STUDIO_APP_SANDBOX, adaptAppCss, adaptAppHtml, adaptAppLocation, adaptAppScript, createStudioAppGateway,
} from '../app-gateway.service.js';
import { createStudioAppRunner, detectAppEntry } from '../app-runner.service.js';
import { createStudioAppSiteRouter, createStudioAppsRouter } from '../apps.routes.js';
import { STUDIO_APP_GUIDE, STUDIO_APP_GUIDE_FILE } from '../app-template.js';

const PREFIX = '/api/studio/app-site/abc';

function tempDirectory(name: string) {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), name)));
}

// A child process stand-in: it never prints and exits only when told to.
function fakeChild() {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(child, { pid: undefined, exitCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
  return child;
}

test('app documents, stylesheets, scripts and redirects keep root-relative addresses inside the app prefix', () => {
  const html = adaptAppHtml('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head>'
    + '<body><img src="/a.png" srcset="/a.png 1x, /a@2x.png 2x"><a href="//cdn.example/x">x</a><a href="note.html">n</a>'
    + '<form action="/api/save"></form><script type="module" src="/app.js"></script></body></html>', PREFIX);
  assert.match(html, /href="\/api\/studio\/app-site\/abc\/style\.css"/);
  assert.match(html, /src="\/api\/studio\/app-site\/abc\/a\.png"/);
  assert.match(html, /srcset="\/api\/studio\/app-site\/abc\/a\.png 1x, \/api\/studio\/app-site\/abc\/a@2x\.png 2x"/);
  assert.match(html, /action="\/api\/studio\/app-site\/abc\/api\/save"/);
  assert.match(html, /src="\/api\/studio\/app-site\/abc\/app\.js"/);
  // Protocol-relative and relative addresses are left alone.
  assert.match(html, /href="\/\/cdn\.example\/x"/);
  assert.match(html, /href="note\.html"/);
  // The bridge runs first in <head>, before the app's own stylesheet and scripts.
  assert.ok(html.indexOf('<script>') < html.indexOf('style.css'));
  assert.match(html, /const prefix = "\/api\/studio\/app-site\/abc"/);

  assert.equal(adaptAppCss('a{background:url(/bg.png)} @import "/base.css"; b{background:url(//cdn/x.png)}', PREFIX),
    `a{background:url(${PREFIX}/bg.png)} @import "${PREFIX}/base.css"; b{background:url(//cdn/x.png)}`);
  assert.equal(adaptAppScript("import a from '/lib.js'; import './b.js'; const c = import('/c.js');", PREFIX),
    `import a from '${PREFIX}/lib.js'; import './b.js'; const c = import('${PREFIX}/c.js');`);
  assert.equal(adaptAppLocation('/login', PREFIX), `${PREFIX}/login`);
  assert.equal(adaptAppLocation(`${PREFIX}/x`, PREFIX), `${PREFIX}/x`);
  assert.equal(adaptAppLocation('https://example.com/', PREFIX), 'https://example.com/');
});

test('app addresses are random, bound to one user and project, expire when idle and are revoked on sign-out', () => {
  let now = 1_000;
  let valid = true;
  const gateway = createStudioAppGateway({ validUser: () => valid, now: () => now });
  const first = gateway.grant(7, 'p1');
  const second = gateway.grant(7, 'p2');
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.notEqual(first.token, second.token);
  assert.equal(first.url, `/api/studio/app-site/${first.token}/`);
  assert.deepEqual(gateway.resolve(first.token), { userId: 7, projectId: 'p1' });
  assert.equal(gateway.resolve('not-a-token'), null);
  // Each use restarts the idle clock; twelve idle hours end it.
  now += 11 * 3_600_000;
  assert.ok(gateway.resolve(first.token));
  now += 13 * 3_600_000;
  assert.equal(gateway.resolve(first.token), null);
  // A user who no longer exists opens nothing.
  const third = gateway.grant(7, 'p3');
  valid = false;
  assert.equal(gateway.resolve(third.token), null);
  valid = true;
  const fourth = gateway.grant(7, 'p4');
  // The first two expired meanwhile and the third was dropped; only the fourth was still valid.
  assert.equal(gateway.revoke(7), 1);
  assert.equal(gateway.resolve(fourth.token), null);
});

test('an app starts with npm start, node main, or as static files; nothing else is guessed', () => {
  const directory = tempDirectory('app-entry-');
  try {
    assert.equal(detectAppEntry(directory), null);
    mkdirSync(path.join(directory, 'public'));
    writeFileSync(path.join(directory, 'public', 'index.html'), '<p>hi</p>');
    assert.deepEqual(detectAppEntry(directory), { kind: 'static', root: path.join(directory, 'public') });
    writeFileSync(path.join(directory, 'server.js'), '');
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ main: 'server.js' }));
    assert.deepEqual(detectAppEntry(directory), { kind: 'node', file: path.join(directory, 'server.js') });
    // A main file outside the folder is never run.
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ main: '../elsewhere.js' }));
    assert.equal(detectAppEntry(directory)?.kind, 'static');
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js' }, main: 'server.js' }));
    assert.deepEqual(detectAppEntry(directory), { kind: 'npm' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the runner starts an app once, restarts it for a newer commit and reports a start that never answers', async () => {
  const directory = tempDirectory('app-runner-');
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js' } }));
  let head = 'c1';
  const spawned: { args: string[]; env: NodeJS.ProcessEnv; child: ChildProcess }[] = [];
  let ready = true;
  const runner = createStudioAppRunner({
    spawnProcess: (_command, args, options) => {
      const child = fakeChild();
      spawned.push({ args, env: options.env, child });
      return child;
    },
    freePort: async () => 40_001 + spawned.length,
    waitReady: async () => { if (!ready) throw new Error('timeout'); },
    readHead: async () => head,
  });
  try {
    const status = await runner.open('1:p', directory);
    assert.equal(status.state, 'running');
    assert.equal(status.kind, 'npm');
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].args, ['start', '--silent']);
    assert.equal(spawned[0].env.PORT, '40001');
    assert.equal(spawned[0].env.HOST, '127.0.0.1');
    // Studio's own settings never reach the app.
    assert.equal(spawned[0].env.DATABASE_PATH, undefined);
    assert.deepEqual(await runner.target('1:p', directory), { kind: 'proxy', port: 40001 });

    // Opening again on the same commit reuses the running app; a new commit restarts it.
    await runner.open('1:p', directory);
    assert.equal(spawned.length, 1);
    head = 'c2';
    await runner.open('1:p', directory);
    assert.equal(spawned.length, 2);

    ready = false;
    const failed = await runner.open('1:p', directory, { restart: true });
    assert.equal(failed.state, 'failed');
    assert.match(failed.error ?? '', /PORT/);
    await assert.rejects(runner.target('1:p', directory), (error: unknown) => error instanceof AppError && error.statusCode === 502);
    assert.equal(runner.stop('1:p').state, 'stopped');
  } finally {
    runner.stopAll();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the gateway serves a static app only through a valid token, sandboxed, and never outside its folder', async () => {
  const directory = tempDirectory('app-site-');
  writeFileSync(path.join(directory, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body>hi</body></html>');
  writeFileSync(path.join(directory, 'style.css'), 'body{background:url(/bg.png)}');
  writeFileSync(path.join(directory, '.env'), 'SECRET=1');
  const outside = tempDirectory('app-site-outside-');
  writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  symlinkSync(path.join(outside, 'secret.txt'), path.join(directory, 'link.txt'));
  const runner = createStudioAppRunner({ readHead: async () => null });
  const gateway = createStudioAppGateway({ validUser: () => true });
  const lookup = (userId: number, projectId: string) => {
    if (userId !== 1 || projectId !== 'p') throw new AppError('这个项目不是 AI 开发的应用', { statusCode: 404 });
    return { directory, name: 'App' };
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = Number(req.get('x-test-user'));
    if (id) (req as express.Request & { user?: { id: number } }).user = { id };
    next();
  });
  app.use('/api/studio/app-site', createStudioAppSiteRouter({ runner, gateway, lookup }));
  app.use('/apps', createStudioAppsRouter({ runner, gateway, lookup }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ error: error instanceof Error ? error.message : 'error' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${origin}/apps/p/open`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${origin}/apps/other/open`, { method: 'POST', headers: { 'x-test-user': '1' } })).status, 404);
    const opened = await fetch(`${origin}/apps/p/open`, { method: 'POST', headers: { 'x-test-user': '1' } }).then(response => response.json()) as { state: string; url: string };
    assert.equal(opened.state, 'running');
    assert.match(opened.url, /^\/api\/studio\/app-site\/[a-f0-9]{64}\/$/);

    const page = await fetch(`${origin}${opened.url}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-security-policy'), `sandbox ${STUDIO_APP_SANDBOX}; frame-ancestors 'self'`);
    assert.doesNotMatch(STUDIO_APP_SANDBOX, /allow-same-origin/);
    assert.match(await page.text(), new RegExp(`href="${opened.url}style\\.css"`));
    assert.equal(await fetch(`${origin}${opened.url}style.css`).then(response => response.text()), `body{background:url(${opened.url}bg.png)}`);
    // No trailing slash: redirected under it so relative addresses resolve inside the app.
    const bare = await fetch(`${origin}${opened.url.slice(0, -1)}`, { redirect: 'manual' });
    assert.equal(bare.status, 308);
    assert.equal(bare.headers.get('location'), opened.url);
    // Dotfiles, escapes and links out of the folder stay private; writes to a static app are refused.
    assert.equal((await fetch(`${origin}${opened.url}.env`)).status, 404);
    assert.equal((await fetch(`${origin}${opened.url}link.txt`)).status, 404);
    const escape = await new Promise<number>(resolve => {
      http.get(`${origin}${opened.url}..%2F..%2Fsecret.txt`, response => { response.resume(); resolve(response.statusCode ?? 0); });
    });
    assert.equal(escape, 404);
    assert.equal((await fetch(`${origin}${opened.url}`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${origin}/api/studio/app-site/${'0'.repeat(64)}/`)).status, 401);
    gateway.revoke(1);
    assert.equal((await fetch(`${origin}${opened.url}`)).status, 401);
  } finally {
    server.close();
    runner.stopAll();
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('the app template is what new builds read', () => {
  assert.equal(STUDIO_APP_GUIDE_FILE, 'STUDIO_DESIGN.md');
  assert.match(STUDIO_APP_GUIDE, /npm start/);
  assert.match(STUDIO_APP_GUIDE, /process\.env\.PORT/);
  assert.match(STUDIO_APP_GUIDE, /prefers-reduced-motion/);
});
