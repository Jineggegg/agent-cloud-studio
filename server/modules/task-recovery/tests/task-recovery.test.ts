import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, getConnection, initializeDatabase, taskRunsDb } from '@/modules/database/index.js';
import { initializeTaskRecovery, taskRecoveryRouter } from '@/modules/task-recovery/index.js';

function input(requestId: string, changes: Record<string, unknown> = {}) {
  return {
    userId: 1,
    requestId,
    sessionId: 'session-1',
    provider: 'claude',
    projectPath: '/work/project',
    content: 'Continue the reviewed task',
    options: { model: 'model-1', effort: 'high' },
    ...changes,
  };
}

function accepted(requestId: string, changes: Record<string, unknown> = {}) {
  const result = taskRunsDb.accept(input(requestId, changes));
  assert.equal(result.kind, 'accepted');
  return result.run;
}

test('durable task receipts and authenticated recovery', async (t) => {
  const oldDatabasePath = process.env.DATABASE_PATH;
  const workDirectory = path.resolve('work');
  await mkdir(workDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(workDirectory, 'task-recovery-test-'));
  const databasePath = path.join(temporaryDirectory, 'test.db');
  await writeFile(databasePath, '');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await t.test('same request deduplicates canonical allowed options without persisting secrets', () => {
      const first = accepted('dedupe', { options: {
        effort: 'high', model: 'model-1', env: { API_TOKEN: 'do-not-persist' }, token: 'secret',
        permissionMode: 'default', rememberedPermissions: ['all'],
        attachments: [{ name: 'a.png', size: 50, path: '/asset/a.png', mimeType: 'image/png', token: 'secret' }],
      } });
      const duplicate = taskRunsDb.accept(input('dedupe', { options: {
        model: 'model-1', effort: 'high', permissionMode: 'default', env: { API_TOKEN: 'do-not-persist' }, token: 'secret', rememberedPermissions: ['all'],
        attachments: [{ mimeType: 'image/png', path: '/asset/a.png', size: 50, name: 'a.png', token: 'secret' }],
      } }));
      assert.equal(duplicate.kind, 'duplicate');
      assert.equal(duplicate.run.runId, first.runId);
      assert.deepEqual(first.options, { model: 'model-1', effort: 'high', permissionMode: 'default',
        attachments: [{ path: '/asset/a.png', name: 'a.png', mimeType: 'image/png', size: 50 }] });
      assert.ok(!JSON.stringify(getConnection().prepare('SELECT * FROM task_runs').all()).includes('secret'));
    });

    await t.test('same request with different content, target, or edit anchor is rejected', () => {
      accepted('conflict', { options: { operation: 'chat.edit-send', editAnchorId: 'anchor-1' } });
      for (const change of [
        { content: 'Different' }, { sessionId: 'session-2' }, { provider: 'codex' },
        { projectPath: '/other' }, { options: { operation: 'chat.edit-send', editAnchorId: 'anchor-1', allowedTools: ['all'] } }, { options: { operation: 'chat.edit-send', editAnchorId: 'anchor-2' } },
      ]) {
        assert.deepEqual(taskRunsDb.accept(input('conflict', change)), {
          kind: 'rejected', errorCode: 'REQUEST_ID_CONFLICT',
        });
      }
    });

    await t.test('identity and queries remain isolated by user including null system work', () => {
      const first = accepted('user-scoped');
      const second = accepted('user-scoped', { userId: 2 });
      const system = accepted('user-scoped', { userId: null });
      assert.notEqual(first.runId, second.runId);
      assert.notEqual(first.runId, system.runId);
      assert.equal(taskRunsDb.getByRequestId('1', 'user-scoped')?.runId, first.runId);
      assert.equal(taskRunsDb.getByRequestId(3, 'user-scoped'), null);
      assert.equal(taskRunsDb.accept(input('user-scoped', { userId: null })).kind, 'duplicate');
    });

    await t.test('restart marks only unfinished accepted/running work interrupted and never replays', async () => {
      getConnection().prepare('DELETE FROM task_runs').run();
      const pending = accepted('pending');
      const running = accepted('running');
      const finished = accepted('finished');
      const failed = accepted('failed');
      const aborted = accepted('aborted');
      assert.equal(taskRunsDb.markRunning(running.runId), true);
      taskRunsDb.settle(finished.runId, { state: 'completed' });
      taskRunsDb.settle(failed.runId, { state: 'failed', error: 'provider failed' });
      taskRunsDb.settle(aborted.runId, { state: 'aborted' });
      closeConnection();
      await initializeDatabase();
      assert.equal(initializeTaskRecovery(), 2);
      assert.equal(initializeTaskRecovery(), 0);
      assert.equal(taskRunsDb.getByRunId(pending.runId)?.state, 'interrupted');
      assert.ok(taskRunsDb.getByRunId(running.runId)?.startedAt);
      assert.ok(taskRunsDb.getByRunId(running.runId)?.interruptedAt);
      assert.equal(taskRunsDb.getByRunId(finished.runId)?.state, 'completed');
      assert.ok(taskRunsDb.getByRunId(finished.runId)?.completedAt);
      assert.equal(taskRunsDb.getByRunId(pending.runId)?.completedAt, null);
      assert.equal(taskRunsDb.getByRunId(failed.runId)?.state, 'failed');
      assert.equal(taskRunsDb.getByRunId(aborted.runId)?.state, 'aborted');
      assert.equal(taskRunsDb.markRunning(pending.runId), false);
      assert.equal(taskRunsDb.accept(input('pending')).kind, 'duplicate');
    });

    await t.test('manual continuation can be claimed once and retries return the same receipt', async () => {
      const original = accepted('original');
      taskRunsDb.interrupt(original.runId);
      const attempts = await Promise.all(['resume-one', 'resume-two'].map(async (requestId) => (
        taskRunsDb.accept(input(requestId, { recoveryOfRunId: original.runId }))
      )));
      assert.equal(attempts.filter((result) => result.kind === 'accepted').length, 1);
      assert.deepEqual(attempts[1], { kind: 'rejected', errorCode: 'RECOVERY_NOT_AVAILABLE' });
      const winner = attempts[0];
      if (winner.kind === 'rejected') throw new Error(winner.errorCode);
      assert.equal(taskRunsDb.getByRunId(original.runId)?.claimedByRunId, winner.run.runId);
      assert.ok(taskRunsDb.getByRunId(original.runId)?.resolvedAt);
      assert.equal(taskRunsDb.accept(input('resume-one', { recoveryOfRunId: original.runId })).kind, 'duplicate');
      assert.ok(!taskRunsDb.listInterrupted(1).some((run) => run.runId === original.runId));
    });

    await t.test('failed queued turns remain visible and can be acknowledged without changing their state', () => {
      const queued = accepted('queued-preparation-failed', { source: 'queued', sessionId: 'failed-queue-session' });
      taskRunsDb.settle(queued.runId, { state: 'failed', error: 'Provider could not be prepared' });
      const visible = taskRunsDb.listInterrupted(1, { sessionId: 'failed-queue-session' });
      assert.equal(visible.length, 1);
      assert.equal(visible[0].state, 'failed');
      assert.equal(visible[0].source, 'queued');
      assert.equal(visible[0].startedAt, null);
      assert.equal(visible[0].interruptedAt, null);
      assert.ok(visible[0].completedAt);
      assert.equal(taskRunsDb.resolve(2, queued.runId), false);
      assert.equal(taskRunsDb.resolve(1, queued.runId), true);
      assert.equal(taskRunsDb.getByRunId(queued.runId)?.state, 'failed');
      assert.deepEqual(taskRunsDb.listInterrupted(1, { sessionId: 'failed-queue-session' }), []);
    });

    await t.test('failed continuations stay recoverable and allow only one further manual claim', async () => {
      const scope = { sessionId: 'failed-continuation-session' };
      const original = accepted('failed-chain-original', scope);
      taskRunsDb.interrupt(original.runId);
      const continued = accepted('failed-chain-first', { ...scope, recoveryOfRunId: original.runId });
      taskRunsDb.markRunning(continued.runId);
      taskRunsDb.settle(continued.runId, { state: 'failed', error: 'Provider disconnected' });
      assert.deepEqual(taskRunsDb.listInterrupted(1, scope).map((run) => [run.runId, run.state]), [
        [continued.runId, 'failed'],
      ]);
      assert.deepEqual(taskRunsDb.accept(input('failed-chain-other-user', {
        ...scope, userId: 2, recoveryOfRunId: continued.runId,
      })), { kind: 'rejected', errorCode: 'RECOVERY_NOT_AVAILABLE' });
      assert.throws(() => getConnection().transaction(() => {
        accepted('failed-chain-rollback', { ...scope, recoveryOfRunId: continued.runId });
        throw new Error('busy before restart');
      })(), /busy before restart/);
      assert.equal(taskRunsDb.getByRunId(continued.runId)?.resolvedAt, null);
      assert.equal(taskRunsDb.getByRunId(continued.runId)?.claimedByRunId, null);
      const attempts = await Promise.all(['failed-chain-second', 'failed-chain-competing'].map(async (requestId) => (
        taskRunsDb.accept(input(requestId, { ...scope, recoveryOfRunId: continued.runId }))
      )));
      assert.equal(attempts[0].kind, 'accepted');
      assert.deepEqual(attempts[1], { kind: 'rejected', errorCode: 'RECOVERY_NOT_AVAILABLE' });
      assert.equal(taskRunsDb.accept(input('failed-chain-second', {
        ...scope, recoveryOfRunId: continued.runId,
      })).kind, 'duplicate');
      assert.equal(taskRunsDb.getByRunId(continued.runId)?.state, 'failed');
      assert.deepEqual(taskRunsDb.listInterrupted(1, scope), []);
    });

    await t.test('invalid continuation never changes the original interrupted receipt', () => {
      const original = accepted('original-invalid');
      taskRunsDb.interrupt(original.runId);
      assert.deepEqual(taskRunsDb.accept(input('other-user', { userId: 2, recoveryOfRunId: original.runId })),
        { kind: 'rejected', errorCode: 'RECOVERY_NOT_AVAILABLE' });
      assert.deepEqual(taskRunsDb.accept(input('other-session', { sessionId: 'session-2', recoveryOfRunId: original.runId })),
        { kind: 'rejected', errorCode: 'RECOVERY_TARGET_MISMATCH' });
      assert.deepEqual(taskRunsDb.accept(input('conflicting-run', { runId: original.runId, recoveryOfRunId: original.runId })),
        { kind: 'rejected', errorCode: 'RUN_ID_CONFLICT' });
      assert.equal(taskRunsDb.getByRunId(original.runId)?.claimedByRunId, null);
      assert.equal(taskRunsDb.getByRunId(original.runId)?.resolvedAt, null);
    });

    await t.test('insert failures and enclosing transaction rollback restore the recovery claim', () => {
      const original = accepted('original-rollback');
      taskRunsDb.interrupt(original.runId);
      const db = getConnection();
      db.exec(`CREATE TEMP TRIGGER reject_test_receipt BEFORE INSERT ON task_runs
        WHEN NEW.request_id = 'insert-failure' BEGIN SELECT RAISE(ABORT, 'test insertion failure'); END`);
      assert.throws(() => taskRunsDb.accept(input('insert-failure', { recoveryOfRunId: original.runId })), /test insertion failure/);
      db.exec('DROP TRIGGER reject_test_receipt');
      assert.equal(taskRunsDb.getByRunId(original.runId)?.claimedByRunId, null);
      assert.throws(() => db.transaction(() => {
        accepted('outer-rollback', { recoveryOfRunId: original.runId });
        throw new Error('reservation busy');
      })(), /reservation busy/);
      assert.equal(taskRunsDb.getByRequestId(1, 'outer-rollback'), null);
      assert.equal(taskRunsDb.getByRunId(original.runId)?.claimedByRunId, null);
      assert.equal(taskRunsDb.getByRunId(original.runId)?.resolvedAt, null);
    });

    await t.test('resolve and filters operate on current user unresolved interrupted work only', () => {
      getConnection().prepare('DELETE FROM task_runs').run();
      const first = accepted('filter-one');
      const second = accepted('filter-two', { sessionId: 'session-2', projectPath: '/other' });
      const third = accepted('filter-three', { userId: 2 });
      for (const run of [first, second, third]) taskRunsDb.interrupt(run.runId);
      assert.deepEqual(taskRunsDb.listInterrupted(1, { projectPath: '/work/project' }).map((run) => run.runId), [first.runId]);
      assert.deepEqual(taskRunsDb.listInterrupted(1, { sessionId: 'session-2' }).map((run) => run.runId), [second.runId]);
      assert.equal(taskRunsDb.listInterrupted(1, { limit: 1 }).length, 1);
      assert.deepEqual(taskRunsDb.listInterrupted(1, { unassigned: true }), []);
      assert.equal(taskRunsDb.resolve(2, first.runId), false);
      assert.equal(taskRunsDb.resolve(1, first.runId), true);
      assert.equal(taskRunsDb.resolve(1, first.runId), false);
      assert.equal(taskRunsDb.getByRunId(first.runId)?.state, 'interrupted');
      assert.equal(taskRunsDb.listInterrupted(1).length, 1);
    });

    await t.test('REST validates filters and keeps request receipts and resolution user scoped', async () => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        const userId = req.get('x-test-user');
        if (userId) Object.assign(req, { user: { id: userId } });
        next();
      });
      app.use('/api/task-recovery', taskRecoveryRouter);
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/task-recovery`;
      const headers = { 'x-test-user': '1' };
      try {
        assert.equal((await fetch(origin)).status, 401);
        assert.equal((await fetch(`${origin}?limit=0`, { headers })).status, 400);
        assert.equal((await fetch(`${origin}?sessionId[]=a`, { headers })).status, 400);
        assert.equal((await fetch(`${origin}?unassigned=yes`, { headers })).status, 400);
        assert.deepEqual(await (await fetch(`${origin}?unassigned=true`, { headers })).json(), { runs: [] });
        const failedReceipt = accepted('failed-rest', { source: 'queued', sessionId: 'rest-failed' });
        taskRunsDb.settle(failedReceipt.runId, { state: 'failed', error: 'Preparation failed' });
        const failedList = await (await fetch(`${origin}?sessionId=rest-failed`, { headers })).json() as { runs: Array<{ state: string }> };
        assert.deepEqual(failedList.runs.map((run) => run.state), ['failed']);
        assert.deepEqual(await (await fetch(`${origin}/${failedReceipt.runId}/resolve`, { method: 'POST', headers })).json(), { resolved: true });
        const ownReceipt = await (await fetch(`${origin}/requests/filter-two`, { headers })).json() as { run: { userId: string; runId: string } };
        assert.equal(ownReceipt.run.userId, '1');
        assert.deepEqual(await (await fetch(`${origin}/requests/filter-three`, { headers })).json(), { run: null });
        assert.equal((await fetch(`${origin}/${ownReceipt.run.runId}/resolve`, { method: 'POST', headers: { 'x-test-user': '2' } })).status, 404);
        assert.deepEqual(await (await fetch(`${origin}/${ownReceipt.run.runId}/resolve`, { method: 'POST', headers })).json(), { resolved: true });
        assert.equal((await fetch(`${origin}/${ownReceipt.run.runId}/resolve`, { method: 'POST', headers })).status, 404);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    });
  } finally {
    closeConnection();
    if (oldDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = oldDatabasePath;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
