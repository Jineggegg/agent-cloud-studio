import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, getConnection, initializeDatabase, sessionDraftsDb, taskRunsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/index.js';

import { createUserRouter } from '../user.routes.js';
import { createUserService } from '../user.service.js';

function createService() {
  return createUserService({
    users: {
      getGitConfig: () => undefined, updateGitConfig: () => undefined,
      completeOnboarding: () => undefined, hasCompletedOnboarding: () => false,
    },
    preferences: { getPreferences: () => ({}), savePreferences: () => undefined },
    drafts: sessionDraftsDb,
    readSystemGitConfig: async () => ({ git_name: null, git_email: null }),
    applyGlobalGitConfig: async () => undefined, logInfo: () => undefined, logError: () => undefined,
  });
}

function createRun(requestId: string, changes: Record<string, unknown> = {}) {
  const result = taskRunsDb.accept({
    userId: 1, requestId, sessionId: 'session-1', provider: 'claude', projectPath: '/project',
    content: 'original task', options: {}, ...changes,
  });
  assert.equal(result.kind, 'accepted');
  return result.run;
}

function assertInvalidRecovery(callback: () => unknown) {
  assert.throws(callback, (error: unknown) => error instanceof AppError
    && error.statusCode === 400 && error.code === 'INVALID_DRAFT_RECOVERY');
}

test('recovery draft persistence and ownership', async (t) => {
  const previousPath = process.env.DATABASE_PATH;
  await mkdir(path.resolve('work'), { recursive: true });
  const directory = await mkdtemp(path.resolve('work', 'recovery-drafts-'));
  const databasePath = path.join(directory, 'test.db');
  await writeFile(databasePath, '');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  const db = getConnection();
  db.exec(`INSERT INTO users (id, username, password_hash) VALUES (1, 'one', 'hash'), (2, 'two', 'hash');
    INSERT INTO projects (project_id, project_path) VALUES ('project', '/project'), ('other', '/other');
    INSERT INTO sessions (session_id, provider, project_path)
      VALUES ('session-1', 'claude', '/project'), ('session-2', 'claude', '/project');`);
  const service = createService();

  try {
    await t.test('migration upgrades an existing draft table and preserves old text/queue', async () => {
      db.exec(`DROP TABLE session_drafts;
        CREATE TABLE session_drafts (
          user_id INTEGER NOT NULL, draft_scope TEXT NOT NULL, draft_text TEXT NOT NULL DEFAULT '',
          queued_message TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY(user_id, draft_scope), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        INSERT INTO session_drafts (user_id, draft_scope, draft_text, queued_message)
          VALUES (1, 'legacy-session', 'older draft', '{"content":"later"}');`);
      await initializeDatabase();
      await initializeDatabase();
      const legacy = service.getDrafts(1).drafts.find((draft) => draft.scope === 'legacy-session');
      assert.equal(legacy?.text, 'older draft');
      assert.deepEqual(legacy?.queuedMessage, { content: 'later' });
      assert.equal(legacy?.recoveryOfRunId, null);
      const columns = db.prepare('PRAGMA table_info(session_drafts)').all() as Array<{ name: string }>;
      assert.equal(columns.filter((column) => column.name === 'recovery_of_run_id').length, 1);
    });

    await t.test('saving/restoring/editing keeps recovery identity without claiming a task', () => {
      const run = createRun('draft-roundtrip');
      taskRunsDb.interrupt(run.runId);
      service.saveDraft(1, 'session-1', { text: 'Continue carefully', recoveryOfRunId: run.runId });
      assert.equal(service.getDrafts(1).drafts.find((draft) => draft.scope === 'session-1')?.recoveryOfRunId, run.runId);
      assert.equal(taskRunsDb.getByRunId(run.runId)?.claimedByRunId, null);
      assert.equal(taskRunsDb.getByRunId(run.runId)?.resolvedAt, null);
      createService().saveDraft(1, 'session-1', { text: 'Continue with an extra instruction' });
      assert.equal(service.getDrafts(1).drafts.find((draft) => draft.scope === 'session-1')?.recoveryOfRunId, run.runId);
      service.saveDraft(1, 'session-1', { text: 'An independent new task', recoveryOfRunId: null });
      assert.equal(service.getDrafts(1).drafts.find((draft) => draft.scope === 'session-1')?.recoveryOfRunId, null);
      service.saveDraft(1, 'session-1', { text: 'Continue again', recoveryOfRunId: run.runId });
      service.saveDraft(1, 'session-1', { text: '', queuedMessage: null });
      assert.equal(service.getDrafts(1).drafts.some((draft) => draft.scope === 'session-1'), false);
    });

    await t.test('queue cleanup preserves a prepared recovery until an explicit empty draft save', () => {
      const run = createRun('draft-queue-cleanup');
      taskRunsDb.interrupt(run.runId);
      service.saveDraft(1, 'session-1', {
        text: '', queuedMessage: { content: 'Unrelated queued turn' }, recoveryOfRunId: run.runId,
      });
      db.prepare('UPDATE session_drafts SET queued_message = NULL WHERE user_id = 1 AND draft_scope = ?').run('session-1');
      sessionDraftsDb.deleteEmptyDraft(1, 'session-1');
      assert.equal(service.getDrafts(1).drafts.find((draft) => draft.scope === 'session-1')?.recoveryOfRunId, run.runId);
      service.saveDraft(1, 'session-1', { text: '', queuedMessage: null });
    });

    await t.test('missing, cross-user/session/project/provider, resolved and claimed links are rejected', () => {
      const run = createRun('draft-guard');
      taskRunsDb.interrupt(run.runId);
      service.saveDraft(1, 'session-1', { text: 'Keep this draft' });
      assertInvalidRecovery(() => service.saveDraft(1, 'session-1', { text: 'x', recoveryOfRunId: 'missing' }));
      assertInvalidRecovery(() => service.saveDraft(2, 'session-1', { text: 'x', recoveryOfRunId: run.runId }));
      assertInvalidRecovery(() => service.saveDraft(1, 'session-2', { text: 'x', recoveryOfRunId: run.runId }));
      const wrongProject = createRun('draft-wrong-project', { projectPath: '/other' });
      const wrongProvider = createRun('draft-wrong-provider', { provider: 'codex' });
      for (const target of [wrongProject, wrongProvider]) {
        taskRunsDb.interrupt(target.runId);
        assertInvalidRecovery(() => service.saveDraft(1, 'session-1', { text: 'x', recoveryOfRunId: target.runId }));
      }
      const completed = createRun('draft-completed');
      taskRunsDb.settle(completed.runId, { state: 'completed' });
      assertInvalidRecovery(() => service.saveDraft(1, 'session-1', { text: 'x', recoveryOfRunId: completed.runId }));
      taskRunsDb.resolve(1, run.runId);
      assertInvalidRecovery(() => service.saveDraft(1, 'session-1', { text: 'x', recoveryOfRunId: run.runId }));
      const failed = createRun('draft-failed');
      taskRunsDb.settle(failed.runId, { state: 'failed', error: 'failed' });
      service.saveDraft(1, 'session-1', { text: 'Continue failed task', recoveryOfRunId: failed.runId });
      createRun('draft-claimed', { recoveryOfRunId: failed.runId });
      assertInvalidRecovery(() => service.saveDraft(1, 'session-1', { text: 'x', recoveryOfRunId: failed.runId }));
      assert.equal(service.getDrafts(1).drafts.find((draft) => draft.scope === 'session-1')?.text, 'Continue failed task');
    });

    await t.test('PUT and GET return a recovery link and invalid ownership gets a 400 response', async () => {
      const run = createRun('draft-http');
      taskRunsDb.interrupt(run.runId);
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { Object.assign(req, { user: { id: Number(req.get('x-test-user') || 1) } }); next(); });
      app.use('/api/user', createUserRouter(service));
      app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(error instanceof AppError ? error.statusCode : 500)
          .json({ error: error instanceof AppError ? error.code : 'UNKNOWN_ERROR' });
      });
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/user/drafts`;
      const headers = { 'content-type': 'application/json' };
      try {
        const body = JSON.stringify({ scope: 'session-1', text: 'Continue', recoveryOfRunId: run.runId });
        assert.equal((await fetch(origin, { method: 'PUT', headers, body })).status, 200);
        const result = await (await fetch(origin)).json() as { drafts: Array<{ scope: string; recoveryOfRunId: string | null }> };
        assert.equal(result.drafts.find((draft) => draft.scope === 'session-1')?.recoveryOfRunId, run.runId);
        assert.equal((await fetch(origin, { method: 'PUT', headers: { ...headers, 'x-test-user': '2' }, body })).status, 400);
        assert.equal((await fetch(origin, { method: 'PUT', headers,
          body: JSON.stringify({ scope: 'session-2', text: 'Continue', recoveryOfRunId: run.runId }),
        })).status, 400);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    });
  } finally {
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
