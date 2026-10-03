import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import { createWorkbenchActivityService } from '../workbench-activity.service.js';
import { createWorkbenchRouter } from '../workbench.routes.js';
import { createWorkbenchService } from '../workbench.service.js';

// Agent sessions and the IDE project each belongs to: e-du and SNR 3.0 run at the same time.
const SESSION_PROJECTS: Record<string, string> = {
  'edu-1': 'p-edu', 'edu-2': 'p-edu', 'snr-1': 'p-snr', 'notes-1': 'p-notes', 'notes-2': 'p-notes', 'prof-1': 'p-prof',
};

function fixture(overrides: Partial<Parameters<typeof createWorkbenchActivityService>[0]> = {}) {
  const state = {
    running: ['edu-1', 'snr-1'],
    approvals: new Set<string>(),
    unresolved: [] as { runId: string; sessionId: string; projectPath: string | null }[],
    replying: [] as { id: string; space: string }[],
    inView: new Set<string>(),
    broadcasts: 0,
  };
  const service = createWorkbenchActivityService({
    listRunningSessions: async () => state.running.map(sessionId => ({ sessionId })),
    hasPendingApproval: sessionId => state.approvals.has(sessionId),
    listUnresolvedRuns: () => state.unresolved,
    sessionProjectId: sessionId => SESSION_PROJECTS[sessionId] ?? null,
    projectIdOfPath: projectPath => (projectPath === '/home/me/projects/notes' ? 'p-notes' : null),
    replyingConversations: () => state.replying,
    hubProjectIds: () => new Map([['professor', 'p-prof']]),
    isSessionInView: sessionId => state.inView.has(sessionId),
    broadcast: () => { state.broadcasts += 1; },
    broadcastDelayMs: 0,
    ...overrides,
  });
  return { service, state };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('two projects running at once each count their running sessions; idle projects are left out', async () => {
  const { service, state } = fixture();
  state.running.push('edu-2', 'unknown-session');
  assert.deepEqual(await service.snapshot(1), {
    projects: {
      'p-edu': { running: 2, attention: 0, attentionSessionIds: [] },
      'p-snr': { running: 1, attention: 0, attentionSessionIds: [] },
    },
  });
});

test('approvals, unresolved failed or interrupted runs and unseen finished runs need the owner', async () => {
  const { service, state } = fixture();
  // A running session waiting for an approval is running and needs the owner.
  state.approvals.add('snr-1');
  // A failed run on record (with a session), and one that never got a session but has its project's directory.
  state.unresolved.push({ runId: 'r1', sessionId: 'notes-1', projectPath: '/home/me/projects/notes' });
  state.unresolved.push({ runId: 'r2', sessionId: '', projectPath: '/home/me/projects/notes' });
  // A run that ended while its session was open on a visible page was seen; one that ended off screen was not.
  state.inView.add('edu-2');
  service.handleRunActivity({ sessionId: 'edu-2', change: 'ended' });
  service.handleRunActivity({ sessionId: 'notes-2', change: 'ended' });
  assert.deepEqual((await service.snapshot(1)).projects, {
    'p-edu': { running: 1, attention: 0, attentionSessionIds: [] },
    'p-snr': { running: 1, attention: 1, attentionSessionIds: ['snr-1'] },
    'p-notes': { running: 0, attention: 3, attentionSessionIds: ['notes-1', 'notes-2'] },
  });

  // Viewing the session clears its unseen mark; running it again does too.
  service.handleSessionsViewed(['notes-2']);
  service.handleRunActivity({ sessionId: 'prof-1', change: 'ended' });
  service.handleRunActivity({ sessionId: 'prof-1', change: 'started' });
  const after = (await service.snapshot(1)).projects;
  assert.deepEqual(after['p-notes'], { running: 0, attention: 2, attentionSessionIds: ['notes-1'] });
  assert.equal(after['p-prof'], undefined);
});

test('a DeepSeek reply runs in its hub project and, finished off screen, needs a look', async () => {
  const { service, state } = fixture({ listRunningSessions: async () => [] });
  state.replying.push({ id: 'conversation-1', space: 'project:professor' }, { id: 'conversation-2', space: 'deepseek' });
  assert.deepEqual((await service.snapshot(1)).projects, { 'p-prof': { running: 1, attention: 0, attentionSessionIds: [] } });

  state.replying = [];
  service.handleReply({ userId: 1, conversationId: 'conversation-1', space: 'project:professor', phase: 'ended' });
  assert.deepEqual((await service.snapshot(1)).projects, { 'p-prof': { running: 0, attention: 1, attentionSessionIds: ['conversation-1'] } });
  // Another user's DeepSeek conversations are not theirs to see.
  assert.deepEqual((await service.snapshot(2)).projects, {});
});

test('changes are announced in one debounced broadcast', async () => {
  const { service, state } = fixture();
  service.handleRunActivity({ sessionId: 'edu-1', change: 'started' });
  service.handleRunActivity({ sessionId: 'edu-1', change: 'permission' });
  service.handleRunActivity({ sessionId: 'edu-1', change: 'ended' });
  await tick();
  assert.equal(state.broadcasts, 1);
  // Viewing a session with nothing unseen changes nothing and stays quiet.
  service.handleSessionsViewed(['snr-1']);
  await tick();
  assert.equal(state.broadcasts, 1);
  service.handleSessionsViewed(['edu-1']);
  await tick();
  assert.equal(state.broadcasts, 2);
});

test('the activity route answers only for a signed-in user', async () => {
  const { service: activity } = fixture();
  const hubLinks = createWorkbenchService({ listHubProjects: () => [], findProjectId: () => null });
  const app = express();
  app.use((req, _res, next) => {
    const id = Number(req.get('x-test-user'));
    if (id) (req as express.Request & { user?: { id: number } }).user = { id };
    next();
  });
  app.use('/workbench', createWorkbenchRouter(hubLinks, undefined, activity));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ error: error instanceof Error ? error.message : 'error' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/workbench/activity`;
    const anonymous = await fetch(url);
    assert.equal(anonymous.status, 401);
    const signedIn = await fetch(url, { headers: { 'x-test-user': '1' } });
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.headers.get('cache-control'), 'no-store');
    const body = await signedIn.json() as { projects: Record<string, { running: number }> };
    assert.deepEqual(Object.keys(body.projects).sort(), ['p-edu', 'p-snr']);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
