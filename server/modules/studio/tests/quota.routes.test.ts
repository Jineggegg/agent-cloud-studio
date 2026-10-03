import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { AppError } from '@/shared/utils.js';
import type { StudioQuotaSnapshot } from '@/shared/types.js';

import { createQuotaService } from '../quota/quota.service.js';
import { createQuotaRouter } from '../quota/quota.routes.js';

const START = Date.parse('2026-10-02T12:00:00.000Z');
// No test may read this machine's real Claude login: every service gets a credentials path that does not exist.
const MISSING_CREDENTIALS = path.join(os.tmpdir(), `quota-test-no-login-${randomUUID()}`, '.credentials.json');

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'quota-service-test-'));
  const claudeSnapshot = path.join(directory, 'studio-rate-limits.json');
  writeFileSync(claudeSnapshot, JSON.stringify({
    observedAt: new Date(START).toISOString(), source: 'statusline',
    five_hour: { used_percentage: 12, resets_at: Math.round(START / 1000) + 3600 },
  }));
  let clock = START;
  const counts = { codex: 0, deepseek: 0 };
  const keys = new Map<number, string>([[1, 'first-key']]);
  let releaseCodex: () => void = () => {};
  const service = createQuotaService({
    now: () => clock,
    deepseekKey: userId => keys.get(userId) ?? null,
    request: (async () => {
      counts.deepseek++;
      return Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '5', granted_balance: '0', topped_up_balance: '5' }] });
    }) as unknown as typeof fetch,
    codexRateLimits: async () => {
      counts.codex++;
      await new Promise<void>(resolve => { releaseCodex = resolve; });
      return { rateLimits: { primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: null }, secondary: null } };
    },
    files: { claudeSnapshot, claudeCredentials: MISSING_CREDENTIALS, codexSessionDirectories: [path.join(directory, 'sessions')] },
  });
  return { directory, service, counts, keys, advance: (ms: number) => { clock += ms; }, release: () => releaseCodex() };
}

async function settle<T>(promise: Promise<T>, release: () => void) {
  // The fake app-server answers only when released, which lets concurrent callers pile up first.
  await new Promise(resolve => setImmediate(resolve));
  release();
  return promise;
}

test('quota service returns all providers, shares in-flight loads and caches for a minute', async () => {
  const { directory, service, counts, keys, advance, release } = fixture();
  try {
    const [first, second] = await settle(Promise.all([service.snapshots(1), service.snapshots(1)]), release);
    assert.deepEqual(first.map(item => item.provider), ['claude', 'codex', 'deepseek']);
    assert.deepEqual(second, first);
    assert.deepEqual(counts, { codex: 1, deepseek: 1 });
    const [claude, codex, deepseek] = first;
    assert.equal(claude.source, 'statusline');
    assert.equal(codex.source, 'official');
    assert.equal(codex.windows[0].label, '5 小时');
    assert.deepEqual(deepseek.balances, [{ currency: 'CNY', total: 5, granted: 0, toppedUp: 5 }]);

    advance(30_000);
    await service.snapshots(1);
    assert.deepEqual(counts, { codex: 1, deepseek: 1 }, 'served from cache within a minute');

    keys.set(1, 'replaced-key');
    await service.snapshots(1);
    assert.equal(counts.deepseek, 2, 'a replaced DeepSeek key is not served from the old cache');

    const other = await service.snapshots(2);
    assert.equal(other[2].available, false, 'a user without a key gets no balance');
    assert.equal(counts.deepseek, 2);

    advance(61_000);
    const refreshed = await settle(service.snapshots(1), release);
    assert.equal(refreshed.length, 3);
    assert.deepEqual(counts, { codex: 2, deepseek: 3 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a throwing key lookup degrades to an unavailable DeepSeek snapshot', async () => {
  const service = createQuotaService({
    deepseekKey: () => { throw new Error('bad master key'); },
    codexRateLimits: null,
    files: { claudeSnapshot: path.join(os.tmpdir(), 'quota-missing-snapshot.json'), claudeCredentials: MISSING_CREDENTIALS, codexSessionDirectories: [] },
  });
  const [claude, codex, deepseek] = await service.snapshots(1);
  assert.equal(claude.available, false);
  assert.equal(codex.available, false);
  assert.equal(deepseek.available, false);
  assert.match(deepseek.note ?? '', /DeepSeek 密钥/);
});

test('a load that never settles times out, is cached like a failure and is retried after a minute', async () => {
  let clock = START;
  let requests = 0;
  const service = createQuotaService({
    now: () => clock,
    loadTimeoutMs: 30,
    deepseekKey: () => 'stuck-key',
    // Ignores its abort signal and never answers, like a read blocked on a FIFO.
    request: (() => { requests++; return new Promise<Response>(() => {}); }) as unknown as typeof fetch,
    codexRateLimits: null,
    files: { claudeSnapshot: path.join(os.tmpdir(), 'quota-missing-snapshot.json'), claudeCredentials: MISSING_CREDENTIALS, codexSessionDirectories: [] },
  });
  const [claude, , first] = await service.snapshots(1);
  assert.equal(claude.available, false, 'the other providers are not held up');
  assert.equal(first.available, false);
  assert.match(first.note ?? '', /超时/);
  assert.equal(requests, 1);

  const [, , cachedFailure] = await service.snapshots(1);
  assert.match(cachedFailure.note ?? '', /超时/);
  assert.equal(requests, 1, 'the timed-out result is cached instead of re-requested at once');

  clock += 61_000;
  await service.snapshots(1);
  assert.equal(requests, 2, 'a stuck load does not occupy the cache forever');
});

// Signs a request in as the user named by x-test-user, the way authenticateToken sets req.user.
function appWithTestUser(mount: (app: express.Express) => void) {
  const app = express();
  app.use((req, _res, next) => {
    const id = Number(req.get('x-test-user'));
    if (id) (req as express.Request & { user?: { id: number } }).user = { id };
    next();
  });
  mount(app);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ error: error instanceof Error ? error.message : 'error' });
  });
  return app;
}

async function withServer(app: express.Express, run: (base: string) => Promise<void>) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('quota router requires a signed-in user and returns uncached snapshots', async () => {
  const snapshots: StudioQuotaSnapshot[] = [
    { provider: 'claude', available: false, windows: [], balances: [], source: 'unavailable', observedAt: null, stale: false, note: 'n' },
  ];
  const users: number[] = [];
  const app = appWithTestUser(target => {
    target.use('/quota', createQuotaRouter({ snapshots: async (userId: number) => { users.push(userId); return snapshots; } }));
  });
  await withServer(app, async base => {
    const anonymous = await fetch(`${base}/quota`);
    assert.equal(anonymous.status, 401);
    const signedIn = await fetch(`${base}/quota`, { headers: { 'x-test-user': '7' } });
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await signedIn.json(), snapshots);
    assert.deepEqual(users, [7]);
  });
});

test('GET /api/studio/quota serves all three providers through the real service as studio.module wires it', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'quota-wiring-test-'));
  const claudeSnapshot = path.join(directory, 'studio-rate-limits.json');
  writeFileSync(claudeSnapshot, JSON.stringify({
    observedAt: new Date().toISOString(), source: 'sdk-event',
    five_hour: { used_percentage: 100, resets_at: Math.round(Date.now() / 1000) + 3600 },
  }));
  const signals: unknown[] = [];
  const keyRequests: number[] = [];
  // Mirrors the wiring studio.module needs: a sub-router at /quota under the /api/studio routes.
  const routes = express.Router();
  routes.use('/quota', createQuotaRouter(createQuotaService({
    deepseekKey: userId => { keyRequests.push(userId); return userId === 3 ? 'user-three-key' : null; },
    codexRateLimits: async ({ signal }) => {
      signals.push(signal);
      return { rateLimits: { primary: { usedPercent: 9, windowDurationMins: 300, resetsAt: null }, secondary: null } };
    },
    request: (async () => Response.json({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '2.50' }] })) as unknown as typeof fetch,
    files: { claudeSnapshot, claudeCredentials: MISSING_CREDENTIALS, codexSessionDirectories: [path.join(directory, 'sessions')] },
  })));
  const app = appWithTestUser(target => { target.use('/api/studio', routes); });
  try {
    await withServer(app, async base => {
      assert.equal((await fetch(`${base}/api/studio/quota`)).status, 401);
      const response = await fetch(`${base}/api/studio/quota`, { headers: { 'x-test-user': '3' } });
      assert.equal(response.status, 200);
      const [claude, codex, deepseek] = await response.json() as StudioQuotaSnapshot[];
      assert.deepEqual([claude.provider, codex.provider, deepseek.provider], ['claude', 'codex', 'deepseek']);
      assert.equal(claude.windows[0].usedPercent, 100);
      assert.equal(codex.source, 'official');
      assert.equal(signals.length, 1);
      assert.ok(signals[0] instanceof AbortSignal, 'the official Codex reader gets a signal it can stop its child with');
      assert.deepEqual(deepseek.balances, [{ currency: 'USD', total: 2.5, granted: 0, toppedUp: 0 }]);
      assert.deepEqual(keyRequests, [3]);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the service reads Claude from the usage API first, through its own fetch, and falls back when it is off', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'quota-usage-wiring-test-'));
  const claudeSnapshot = path.join(directory, 'studio-rate-limits.json');
  const claudeCredentials = path.join(directory, '.credentials.json');
  writeFileSync(claudeSnapshot, JSON.stringify({
    observedAt: new Date(START).toISOString(), source: 'statusline',
    five_hour: { used_percentage: 12, resets_at: Math.round(START / 1000) + 3600 },
  }));
  writeFileSync(claudeCredentials, JSON.stringify({ claudeAiOauth: { accessToken: 'wiring-test-token', expiresAt: START + 3_600_000 } }));
  let clock = START;
  const usageCalls: string[] = [];
  const request = (async (url: string | URL) => {
    if (String(url).includes('api.anthropic.com')) {
      usageCalls.push(String(url));
      return Response.json({ five_hour: { utilization: 33, resets_at: new Date(START + 3_600_000).toISOString() }, seven_day: null });
    }
    return Response.json({ is_available: true, balance_infos: [] });
  }) as unknown as typeof fetch;
  const create = (claudeUsageApi?: boolean) => createQuotaService({
    now: () => clock, deepseekKey: () => null, codexRateLimits: null, request, claudeUsageApi,
    files: { claudeSnapshot, claudeCredentials, codexSessionDirectories: [] },
  });
  try {
    const service = create();
    const [claude] = await service.snapshots(1);
    assert.equal(claude.source, 'usage-api');
    assert.deepEqual(claude.windows.map(window => [window.id, window.usedPercent]), [['five_hour', 33]]);
    assert.deepEqual(usageCalls, ['https://api.anthropic.com/api/oauth/usage']);
    clock += 61_000;
    await service.snapshots(1);
    assert.equal(usageCalls.length, 2, 'refreshed once the service cache and the reader cache have both expired');

    const off = await create(false).snapshots(1);
    assert.equal(off[0].source, 'statusline', 'STUDIO_CLAUDE_USAGE_API=off keeps the snapshot path');
    assert.equal(usageCalls.length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
