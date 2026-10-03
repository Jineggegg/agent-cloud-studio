import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import { createGitHubRouter } from '../github/github.routes.js';
import type { createGitHubService } from '../github/github.service.js';
import type { createGitHubBranchService } from '../github/github-branch.service.js';

type Service = ReturnType<typeof createGitHubService>;

const HEAD = '6a86614f929c0d67be9d4124b066832715d7d698';

async function serve(service: Partial<Service>, userId: number | null = 7) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (userId) (req as express.Request & { user?: { id: number } }).user = { id: userId }; next(); });
  app.use('/github', createGitHubRouter(service as Service));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ error: error instanceof AppError ? { code: error.code, message: error.message } : 'error' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/github`;
  return { origin, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('github routes parse input, pass validated values and the signed-in user, and never cache', async () => {
  const seen: unknown[][] = [];
  const service: Partial<Service> = {
    status: async force => { seen.push(['status', force]); return { installed: true, authenticated: true, login: 'me', scopes: [], canMerge: true, message: null, checkedAt: '' }; },
    pulls: async force => { seen.push(['pulls', force]); return { login: 'me', pulls: [], fetchedAt: '', truncated: false }; },
    pull: async (ref, force) => { seen.push(['pull', ref, force]); return {} as Awaited<ReturnType<Service['pull']>>; },
    merge: async (userId, ref, request) => { seen.push(['merge', userId, ref, request]); return { outcome: 'merged', mergeCommitSha: null, message: 'ok' }; },
    merges: userId => { seen.push(['merges', userId]); return []; },
  };
  const server = await serve(service);
  try {
    const status = await fetch(`${server.origin}/status`);
    assert.equal(status.status, 200);
    assert.equal(status.headers.get('Cache-Control'), 'no-store');
    assert.equal((await fetch(`${server.origin}/status?refresh=1`)).status, 200);
    assert.equal((await fetch(`${server.origin}/prs?refresh=true`)).status, 200);
    assert.equal((await fetch(`${server.origin}/prs?refresh=yes`)).status, 400);
    assert.equal((await fetch(`${server.origin}/prs/Jineggegg/.github/12`)).status, 200);
    assert.equal((await post(`${server.origin}/prs/Jineggegg/super-professor/114/merge`, { method: 'squash', expectedHeadSha: HEAD, deleteBranch: true })).status, 200);
    assert.equal((await fetch(`${server.origin}/merges`)).status, 200);
    assert.deepEqual(seen, [
      ['status', false],
      ['status', true],
      ['pulls', true],
      ['pull', { owner: 'Jineggegg', repo: '.github', number: 12 }, false],
      ['merge', 7, { owner: 'Jineggegg', repo: 'super-professor', number: 114 }, { method: 'squash', expectedHeadSha: HEAD, deleteBranch: true, acknowledgeFailing: false }],
      ['merges', 7],
    ]);
  } finally {
    await server.close();
  }
});

test('github routes reject malformed paths and bodies before the service runs, and audit rejected merge bodies', async () => {
  let calls = 0;
  const invalid: unknown[][] = [];
  const service: Partial<Service> = {
    pull: async () => { calls += 1; return {} as Awaited<ReturnType<Service['pull']>>; },
    merge: async () => { calls += 1; return { outcome: 'merged', mergeCommitSha: null, message: '' }; },
    recordInvalidMerge: (userId, ref, error) => { invalid.push([userId, ref, error instanceof AppError ? error.code : null]); },
  };
  const server = await serve(service);
  try {
    for (const path of ['-oops/repo/1', 'owner/..%2F/1', 'owner/repo/0', 'owner/repo/1e3', 'owner/repo/99999999999', `${'a'.repeat(40)}/repo/1`]) {
      assert.equal((await fetch(`${server.origin}/prs/${path}`)).status, 400, path);
    }
    const url = `${server.origin}/prs/Jineggegg/super-professor/114/merge`;
    for (const body of [{}, { method: 'squash' }, { method: 'ff', expectedHeadSha: HEAD }, { method: 'squash', expectedHeadSha: 'HEAD' }, { method: 'squash', expectedHeadSha: HEAD, deleteBranch: 'true' }]) {
      const response = await post(url, body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    // A merge whose address does not parse cannot name a pull request, so only the bodies above are audited.
    assert.equal((await post(`${server.origin}/prs/-x/super-professor/114/merge`, { method: 'squash', expectedHeadSha: HEAD })).status, 400);
    assert.equal(calls, 0);
    const ref = { owner: 'Jineggegg', repo: 'super-professor', number: 114 };
    assert.deepEqual(invalid, [
      [7, ref, 'INVALID_METHOD'], [7, ref, 'INVALID_SHA'], [7, ref, 'INVALID_METHOD'], [7, ref, 'INVALID_SHA'], [7, ref, 'INVALID_FLAG'],
    ]);
  } finally {
    await server.close();
  }
  const anonymous = await serve({ merges: () => [] }, null);
  try {
    assert.equal((await fetch(`${anonymous.origin}/merges`)).status, 401);
  } finally {
    await anonymous.close();
  }
});

test('fix routes parse the PR address and body, pass the signed-in user, and audit rejected bodies', async () => {
  const seen: unknown[][] = [];
  const result = { message: 'ok', pull: null };
  const service: Partial<Service> = {
    updateBranch: async (userId, ref, request) => { seen.push(['update', userId, ref, request]); return result; },
    markReady: async (userId, ref) => { seen.push(['ready', userId, ref]); return result; },
    approveRuns: async (userId, ref, request) => { seen.push(['approve', userId, ref, request]); return result; },
    recordInvalidAction: (userId, ref, action, error) => { seen.push(['invalid', userId, action, error instanceof AppError ? error.code : null]); },
  };
  const server = await serve(service);
  const base = `${server.origin}/prs/Jineggegg/super-professor/114`;
  const ref = { owner: 'Jineggegg', repo: 'super-professor', number: 114 };
  try {
    assert.equal((await post(`${base}/update-branch`, { expectedHeadSha: HEAD })).status, 200);
    assert.equal((await post(`${base}/ready`, {})).status, 200);
    assert.equal((await post(`${base}/approve-runs`, { runIds: [7, 7, 8] })).status, 200);
    assert.equal((await post(`${base}/update-branch`, { expectedHeadSha: 'main' })).status, 400);
    assert.equal((await post(`${base}/approve-runs`, { runIds: ['7; rm'] })).status, 400);
    assert.equal((await post(`${server.origin}/prs/-x/super-professor/114/ready`, {})).status, 400);
    assert.deepEqual(seen, [
      ['update', 7, ref, { expectedHeadSha: HEAD }],
      ['ready', 7, ref],
      ['approve', 7, ref, { runIds: [7, 8] }],
      ['invalid', 7, 'update-branch', 'INVALID_SHA'],
      ['invalid', 7, 'approve-runs', 'INVALID_RUN_IDS'],
    ]);
  } finally {
    await server.close();
  }
});

test('the branch PR route validates the project id and needs a signed-in user', async () => {
  const asked: unknown[][] = [];
  const branches = {
    branchPull: async (projectId: string, force: boolean) => { asked.push([projectId, force]); return null; },
  } as unknown as ReturnType<typeof createGitHubBranchService>;
  const app = express();
  app.use((req, _res, next) => { if (req.headers['x-user']) (req as express.Request & { user?: { id: number } }).user = { id: 7 }; next(); });
  app.use('/github', createGitHubRouter({} as Service, branches));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({});
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/github`;
  try {
    const signedIn = { headers: { 'x-user': '1' } };
    const ok = await fetch(`${origin}/branch-pr?projectId=0f9b6c1e-1b0f&refresh=1`, signedIn);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'null');
    assert.equal((await fetch(`${origin}/branch-pr?projectId=..%2Fx`, signedIn)).status, 400);
    assert.equal((await fetch(`${origin}/branch-pr`, signedIn)).status, 400);
    assert.equal((await fetch(`${origin}/branch-pr?projectId=p-1`)).status, 401);
    assert.deepEqual(asked, [['0f9b6c1e-1b0f', true]]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
