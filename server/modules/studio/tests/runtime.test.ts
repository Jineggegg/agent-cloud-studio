import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import express from 'express';

import type { StudioBuildInfo, StudioRuntimeInfo } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createStudioRuntimeRouter } from '../runtime.routes.js';
import { createStudioRuntimeService } from '../runtime.service.js';

const BUILD: StudioBuildInfo = { schemaVersion: 1, version: '1.2.3', commit: 'a'.repeat(40), builtAt: '2026-10-02T12:00:00.000Z', dirty: false };
const CHECKOUT = 'b'.repeat(40);
const LATEST = 'c'.repeat(40);

function git(origin = 'git@github.com:owner/studio.git', dirty = true) {
  return async (args: string[]) => {
    if (args[0] === 'rev-parse') return CHECKOUT;
    if (args[0] === 'symbolic-ref') return 'feature/local';
    if (args[0] === 'status') return dirty ? ' M source.ts' : '';
    if (args.join(' ') === 'remote get-url origin') return origin;
    throw new Error('unexpected Git operation');
  };
}

function github(calls: Array<{ url: string; init: RequestInit | undefined }> = []): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return Response.json(url.endsWith('/commits/main') ? { sha: LATEST } : { default_branch: 'main' });
  };
}

test('build identities remain separate from checkout and the GitHub default branch', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const info = await createStudioRuntimeService({ backendBuild: BUILD, readFrontendManifest: () => BUILD, git: git(), fetch: github(calls) }).describe();
  assert.equal(info.backend.build?.commit, BUILD.commit);
  assert.equal(info.frontend.build?.commit, BUILD.commit);
  assert.deepEqual(info.checkout, { state: 'available', commit: CHECKOUT, branch: 'feature/local', dirty: true, reason: null });
  assert.equal(info.github.commit, LATEST);
  assert.equal(info.github.repository, 'owner/studio');
  assert.deepEqual(calls.map(item => item.url), ['https://api.github.com/repos/owner/studio', 'https://api.github.com/repos/owner/studio/commits/main']);
  assert.ok(calls.every(item => item.init?.redirect === 'error' && item.init.signal instanceof AbortSignal));
  assert.ok(calls.every(item => !JSON.stringify(item.init?.headers).toLowerCase().includes('authorization')));
  assert.ok(Date.parse(info.host.processStartedAt) <= Date.now());
  assert.ok(Date.parse(info.host.bootedAt) <= Date.parse(info.host.processStartedAt));
});

test('backend is frozen at service creation while a new frontend manifest is read on refresh', async () => {
  const startup = { ...BUILD };
  let disk = { ...BUILD };
  const service = createStudioRuntimeService({ backendBuild: startup, readFrontendManifest: () => disk, git: git(), fetch: github() });
  startup.commit = CHECKOUT;
  disk = { ...BUILD, commit: LATEST };
  const result = await service.describe();
  assert.equal(result.backend.build?.commit, BUILD.commit);
  assert.equal(result.frontend.build?.commit, LATEST);
  disk = { ...BUILD, commit: CHECKOUT };
  assert.equal((await service.describe()).frontend.build?.commit, CHECKOUT);
});

test('missing Git and missing manifests are honest unknown states, not invented running commits', async () => {
  let requests = 0;
  const service = createStudioRuntimeService({
    backendBuild: null, readFrontendManifest: () => null, git: async () => { throw new Error('not a git repository'); },
    fetch: async () => { requests++; throw new Error('must not fetch'); },
  });
  const info = await service.describe();
  assert.equal(info.backend.state, 'unknown');
  assert.equal(info.frontend.state, 'unknown');
  assert.equal(info.checkout.state, 'unavailable');
  assert.equal(info.checkout.dirty, null);
  assert.equal(info.github.state, 'unconfigured');
  assert.equal(requests, 0);
});

test('invalid manifests and short SHAs never become recorded build identities', async () => {
  for (const malformed of [{ ...BUILD, commit: 'abc123' }, { ...BUILD, builtAt: 'yesterday' }, { ...BUILD, dirty: 'false' }, { ...BUILD, schemaVersion: 2 }, 'invalid json']) {
    const info = await createStudioRuntimeService({ backendBuild: malformed, readFrontendManifest: () => malformed, git: git(''), fetch: github() }).describe();
    assert.equal(info.backend.build, null);
    assert.equal(info.frontend.build, null);
  }
});

test('default frontend reader survives malformed JSON and dev mode cannot adopt the disk backend build', async () => {
  const parent = path.resolve('work/runtime-tests');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'manifest-'));
  mkdirSync(path.join(directory, 'dist'));
  mkdirSync(path.join(directory, 'dist-server'));
  writeFileSync(path.join(directory, 'dist', 'build-info.json'), '{broken');
  writeFileSync(path.join(directory, 'dist-server', 'build-info.json'), JSON.stringify(BUILD));
  const result = await createStudioRuntimeService({ appRoot: directory, git: git(''), fetch: github() }).describe();
  assert.equal(result.frontend.build, null);
  assert.equal(result.backend.build, null);
});

test('an exported folder nested in this checkout does not inherit its parent repository', async () => {
  const parent = path.resolve('work/runtime-tests');
  mkdirSync(parent, { recursive: true });
  const appRoot = mkdtempSync(path.join(parent, 'export-'));
  let fetched = false;
  const result = await createStudioRuntimeService({ appRoot, fetch: async () => { fetched = true; throw new Error('must not fetch'); } }).describe();
  assert.equal(result.checkout.state, 'unavailable');
  assert.equal(result.checkout.commit, null);
  assert.equal(result.github.state, 'unconfigured');
  assert.equal(fetched, false);
});

test('GitHub only accepts origin on the fixed host and never returns a credential-bearing origin', async () => {
  for (const origin of ['https://secret:password@github.com/owner/studio.git', 'https://github.com.evil.test/owner/studio', 'https://github.com/owner/studio?token=secret', 'ssh://git@evil.test/owner/studio', 'file:///etc/passwd', 'https://github.com/../studio']) {
    let requests = 0;
    const result = await createStudioRuntimeService({ backendBuild: null, readFrontendManifest: () => null, git: git(origin), fetch: async () => { requests++; throw new Error('unexpected'); } }).describe();
    assert.equal(result.github.state, 'unconfigured');
    assert.equal(result.github.repository, null);
    assert.equal(requests, 0);
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});

test('GitHub fetches coalesce and cache for one minute, including failures', async () => {
  let time = Date.parse(BUILD.builtAt);
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const service = createStudioRuntimeService({ backendBuild: BUILD, readFrontendManifest: () => BUILD, git: git(), fetch: github(calls), now: () => time });
  await Promise.all([service.describe(), service.describe(), service.describe()]);
  assert.equal(calls.length, 2);
  time += 59_000;
  await service.describe();
  assert.equal(calls.length, 2);
  time += 1_001;
  await service.describe();
  assert.equal(calls.length, 4);

  let failures = 0;
  const unavailable = createStudioRuntimeService({ git: git(), fetch: async () => { failures++; return new Response('', { status: 403 }); } });
  const info = await unavailable.describe();
  assert.equal(info.github.state, 'unavailable');
  assert.match(info.github.reason ?? '', /限流/);
  await unavailable.describe();
  assert.equal(failures, 1);
});

test('private repositories, invalid responses, network failure and timeout remain unknown', async () => {
  const answers: Array<typeof fetch> = [
    async () => new Response('', { status: 404 }),
    async () => Response.json({ default_branch: 'main', sha: 'short' }),
    async () => { throw new Error('private internal failure with secret'); },
    async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('abort')), { once: true })),
  ];
  for (const fetcher of answers) {
    const result = await createStudioRuntimeService({ git: git(), fetch: fetcher }).describe();
    assert.equal(result.github.state, 'unavailable');
    assert.equal(result.github.commit, null);
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});

test('runtime route rejects missing identity and returns a no-store authenticated snapshot', async () => {
  const service = createStudioRuntimeService({ backendBuild: BUILD, readFrontendManifest: () => BUILD, git: git(), fetch: github() });
  const app = express();
  app.use((req, _res, next) => { if (req.headers.authorization === 'test-user') Object.assign(req, { user: { id: 1 } }); next(); });
  app.use('/api/studio/runtime', createStudioRuntimeRouter(service));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ error: 'authentication failed' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/studio/runtime`;
  try {
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { Authorization: 'test-user' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json() as StudioRuntimeInfo).backend.build?.commit, BUILD.commit);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
