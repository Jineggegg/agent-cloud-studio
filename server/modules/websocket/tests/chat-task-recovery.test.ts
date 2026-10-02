import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb, taskRunsDb, sessionDraftsDb, scheduledMessagesDb, userDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { initializeTaskRecovery } from '@/modules/task-recovery/index.js';
import { dispatchDueScheduledMessages, dispatchQueuedMessages } from '@/modules/scheduled-messages/index.js';
import { handleChatConnection, type ProviderRuntimeGateway } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { ProviderRuntimeWriter } from '@/shared/types.js';

const SESSION = 'reliability-session';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function socket() {
  const ws = new EventEmitter() as EventEmitter & { readyState: number; frames: Record<string, unknown>[]; send(data: string): void };
  ws.readyState = 1;
  ws.frames = [];
  ws.send = (data) => { ws.frames.push(JSON.parse(data)); };
  return ws;
}

function gateway(run: ProviderRuntimeGateway['run']): ProviderRuntimeGateway {
  return {
    hasRuntime: () => true, run, abort: async () => true,
    stopBackgroundTask: async () => false,
    hasBackgroundWork: () => false,
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [],
  };
}

async function fixture(body: (context: { userId: number; projectPath: string }) => Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'task-recovery-gateway-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  const userId = Number(userDb.createUser('recovery-user', 'test-only').id);
  sessionsDb.createAppSession(SESSION, 'claude', directory);
  try { await body({ userId, projectPath: directory }); }
  finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function send(ws: ReturnType<typeof socket>, requestId: string, content = 'inspect current state', extra = {}) {
  ws.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION, requestId, content, ...extra }));
}

test('durable receipt precedes runtime work; retry confirms the same run without invoking it again', async () => {
  await fixture(async ({ userId }) => {
    const ws = socket();
    let finish!: () => void;
    let calls = 0;
    const runtime = gateway(async () => {
      calls++;
      assert.equal(taskRunsDb.getByRequestId(userId, 'retry-id')?.state, 'running');
      assert.ok(ws.frames.some((frame) => frame.kind === 'run_accepted'));
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    handleChatConnection(ws as never, { user: { id: userId } } as never, { runtime });
    send(ws, 'retry-id');
    await tick();
    send(ws, 'retry-id');
    send(ws, 'retry-id', 'different operation');
    await tick();
    assert.equal(calls, 1);
    const receipts = ws.frames.filter((frame) => frame.kind === 'run_accepted');
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0].runId, receipts[1].runId);
    assert.equal(receipts[1].duplicate, true);
    assert.equal(ws.frames.at(-1)?.errorCode, 'REQUEST_ID_CONFLICT');
    assert.equal(ws.frames.at(-1)?.requestId, 'retry-id');
    finish();
    await tick();
    assert.equal(taskRunsDb.getByRequestId(userId, 'retry-id')?.state, 'completed');
    send(ws, 'retry-id');
    await tick();
    assert.equal(calls, 1);
    assert.equal(ws.frames.at(-1)?.state, 'completed');
  });
});

test('busy admission rolls back its receipt and recovery claim', async () => {
  await fixture(async ({ userId, projectPath }) => {
    const old = taskRunsDb.accept({ userId, requestId: 'old', sessionId: SESSION, provider: 'claude', projectPath, content: 'old', options: {} });
    assert.notEqual(old.kind, 'rejected');
    if (old.kind === 'rejected') return;
    taskRunsDb.interrupt(old.run.runId);
    chatRunRegistry.startRun({ appSessionId: SESSION, provider: 'claude', providerSessionId: null, connection: null, userId });
    let calls = 0;
    const ws = socket();
    handleChatConnection(ws as never, { user: { id: userId } } as never, { runtime: gateway(async () => { calls++; }) });
    send(ws, 'busy-recovery', 'continue', { recoveryOfRunId: old.run.runId });
    await tick();
    assert.equal(calls, 0);
    assert.equal(ws.frames.at(-1)?.errorCode, 'RUN_IN_PROGRESS');
    assert.equal(taskRunsDb.getByRequestId(userId, 'busy-recovery'), null);
    assert.equal(taskRunsDb.getByRunId(old.run.runId)?.claimedByRunId, null);
  });
});

test('an early complete with held background work stays durably running even if a later turn starts', async () => {
  await fixture(async ({ userId }) => {
    const ws = socket();
    let finish!: () => void;
    let calls = 0;
    const runtime = gateway(async (_provider, _content, _options, writer) => {
      calls++;
      if (calls === 1) {
        writer.send({ kind: 'complete', exitCode: 0, sessionId: SESSION, provider: 'claude' });
        await new Promise<void>((resolve) => { finish = resolve; });
      }
    });
    handleChatConnection(ws as never, { user: { id: userId } } as never, { runtime });
    send(ws, 'background');
    await tick();
    assert.equal(chatRunRegistry.isProcessing(SESSION), false);
    assert.equal(taskRunsDb.getByRequestId(userId, 'background')?.state, 'running');
    send(ws, 'next-turn');
    await tick();
    assert.equal(calls, 2);
    assert.equal(taskRunsDb.getByRequestId(userId, 'next-turn')?.state, 'completed');
    assert.equal(taskRunsDb.getByRequestId(userId, 'background')?.state, 'running');
    finish();
    await tick();
    assert.equal(taskRunsDb.getByRequestId(userId, 'background')?.state, 'completed');
  });
});

test('subscribe replays a new run from its beginning when the supplied cursor belongs to an older run', async () => {
  await fixture(async ({ userId }) => {
    const ws = socket();
    let finish!: () => void;
    const runtime = gateway(async (_provider, _content, _options, writer) => {
      writer.send({ kind: 'text_delta', content: 'new response', sessionId: SESSION, provider: 'claude' });
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    handleChatConnection(ws as never, { user: { id: userId } } as never, { runtime });
    send(ws, 'new-run');
    await tick();
    const reconnect = socket();
    handleChatConnection(reconnect as never, { user: { id: userId } } as never, { runtime });
    reconnect.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION, runId: 'old-run', lastSeq: 999 }] }));
    await tick();
    assert.equal(reconnect.frames[0].kind, 'chat_subscribed');
    assert.equal(reconnect.frames[1].seq, 1);
    assert.equal(reconnect.frames[1].runId, taskRunsDb.getByRequestId(userId, 'new-run')?.runId);
    finish();
    await tick();
  });
});

test('a crash after queue and schedule claims keeps both inputs, and startup never invokes their runtimes', async () => {
  await fixture(async ({ userId }) => {
    sessionDraftsDb.saveDraft(userId, SESSION, { text: '', queuedMessage: { content: 'queued operation', options: {} } });
    const candidate = sessionDraftsDb.listQueuedMessages()[0];
    assert.equal(sessionDraftsDb.claimQueuedMessage(candidate), true);
    assert.equal(candidate.execution?.state, 'accepted');
    scheduledMessagesDb.create({ userId, sessionId: SESSION, content: 'scheduled operation', options: {}, scheduledFor: new Date(0) });
    const claimed = scheduledMessagesDb.claimDue(new Date());
    assert.equal(claimed.length, 1);
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION)[0].status, 'claimed');
    // Simulate a new process after the two committed claims, before either provider call.
    closeConnection();
    await initializeDatabase();
    initializeTaskRecovery();
    let calls = 0;
    const runtime = gateway(async () => { calls++; });
    assert.equal(await dispatchQueuedMessages(runtime), 0);
    assert.equal(await dispatchDueScheduledMessages(runtime), 0);
    assert.equal(calls, 0);
    assert.deepEqual(taskRunsDb.listInterrupted(userId).map((run) => run.content).sort(), ['queued operation', 'scheduled operation']);
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION)[0].status, 'failed');
  });
});

test('abort and provider error frames are reflected in durable results', async () => {
  await fixture(async ({ userId }) => {
    const ws = socket();
    let finish!: () => void;
    let writer: ProviderRuntimeWriter | null = null;
    const runtime = gateway(async (_provider, _content, _options, current) => {
      writer = current;
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    handleChatConnection(ws as never, { user: { id: userId } } as never, { runtime });
    send(ws, 'abort-me');
    await tick();
    ws.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION }));
    await tick();
    finish();
    await tick();
    assert.equal(taskRunsDb.getByRequestId(userId, 'abort-me')?.state, 'aborted');
    send(ws, 'error-frame');
    await tick();
    assert.ok(writer);
    (writer as ProviderRuntimeWriter).send({ kind: 'error', error: 'runtime error', sessionId: SESSION, provider: 'claude' });
    finish();
    await tick();
    assert.equal(taskRunsDb.getByRequestId(userId, 'error-frame')?.state, 'failed');
  });
});


test('an error after early completion is durably failed with its provider reason', async () => {
  await fixture(async ({ userId }) => {
    const ws = socket();
    const runtime = gateway(async (_provider, _content, _options, writer) => {
      writer.send({ kind: 'complete', exitCode: 0, sessionId: SESSION, provider: 'claude' });
      writer.send({ kind: 'error', content: 'background process failed', sessionId: SESSION, provider: 'claude' });
    });
    handleChatConnection(ws as never, { user: { id: userId } } as never, { runtime });
    send(ws, 'background-error');
    await tick();
    assert.equal(taskRunsDb.getByRequestId(userId, 'background-error')?.state, 'failed');
    assert.equal(taskRunsDb.getByRequestId(userId, 'background-error')?.error, 'background process failed');
  });
});

test('a queued turn whose provider fails before sending remains available for manual recovery', async () => {
  await fixture(async ({ userId }) => {
    sessionDraftsDb.saveDraft(userId, SESSION, { text: '', queuedMessage: { content: 'never submitted input', options: {} } });
    const runtime = gateway(async () => { throw new Error('provider unavailable before sending'); });
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    const recoverable = taskRunsDb.listInterrupted(userId);
    assert.equal(recoverable.length, 1);
    assert.equal(recoverable[0].content, 'never submitted input');
    assert.equal(recoverable[0].state, 'failed');
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
    assert.equal(await dispatchQueuedMessages(runtime), 0);
  });
});


test('an explicit successful complete supersedes earlier nonterminal stderr warnings', async () => {
  await fixture(async ({ userId }) => {
    const ws = socket();
    const runtime = gateway(async (_provider, _content, _options, writer) => {
      writer.send({ kind: 'error', content: 'nonterminal provider warning', sessionId: SESSION, provider: 'claude' });
      writer.send({ kind: 'complete', exitCode: 0, sessionId: SESSION, provider: 'claude' });
    });
    handleChatConnection(ws as never, { user: { id: userId } } as never, { runtime });
    send(ws, 'warning-success');
    await tick();
    assert.equal(taskRunsDb.getByRequestId(userId, 'warning-success')?.state, 'completed');
    assert.equal(taskRunsDb.getByRequestId(userId, 'warning-success')?.error, null);
  });
});


test('an edit retry returns its receipt before rereading or rewinding its old anchor', async () => {
  await fixture(async ({ userId }) => {
    const ws = socket();
    let calls = 0;
    let anchorReads = 0;
    let rewinds = 0;
    const originalResolve = sessionsService.resolveEditAnchor;
    const originalRewinds = sessionsService.providerRewindsForEdit;
    const originalRewind = sessionsService.rewindSessionForEdit;
    sessionsService.resolveEditAnchor = async () => {
      anchorReads++;
      if (anchorReads > 1) throw new Error('The original anchor is no longer live.');
      return { found: true, resumeThroughId: 'previous-turn' };
    };
    sessionsService.providerRewindsForEdit = () => true;
    sessionsService.rewindSessionForEdit = async () => { rewinds++; };
    try {
      handleChatConnection(ws as never, { user: { id: userId } } as never, { runtime: gateway(async () => { calls++; }) });
      const frame = { type: 'chat.edit-send', sessionId: SESSION, requestId: 'same-edit', content: 'replacement', anchorId: 'old-anchor' };
      ws.emit('message', JSON.stringify(frame));
      await tick();
      ws.emit('message', JSON.stringify(frame));
      await tick();
      assert.equal(calls, 1);
      assert.equal(rewinds, 1);
      assert.equal(anchorReads, 1);
      assert.equal(ws.frames.at(-1)?.duplicate, true);
      ws.emit('message', JSON.stringify({ ...frame, anchorId: 'different-anchor' }));
      await tick();
      assert.equal(ws.frames.at(-1)?.errorCode, 'REQUEST_ID_CONFLICT');
      assert.equal(anchorReads, 1);
    } finally {
      sessionsService.resolveEditAnchor = originalResolve;
      sessionsService.providerRewindsForEdit = originalRewinds;
      sessionsService.rewindSessionForEdit = originalRewind;
    }
  });
});

test('a delivery retry after restart returns interrupted status without replaying provider work', async () => {
  await fixture(async ({ userId }) => {
    const ws = socket();
    let finish!: () => void;
    let calls = 0;
    const runtime = gateway(async () => {
      calls++;
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    handleChatConnection(ws as never, { user: { id: userId } } as never, { runtime });
    send(ws, 'restart-retry');
    await tick();
    const oldRunId = taskRunsDb.getByRequestId(userId, 'restart-retry')?.runId;
    chatRunRegistry.clearAll();
    initializeTaskRecovery();
    send(ws, 'restart-retry');
    await tick();
    assert.equal(calls, 1);
    assert.equal(ws.frames.at(-1)?.runId, oldRunId);
    assert.equal(ws.frames.at(-1)?.state, 'interrupted');
    finish();
    await tick();
    assert.equal(taskRunsDb.getByRequestId(userId, 'restart-retry')?.state, 'interrupted');
  });
});


test('a schedule never starts a second provider run when aborting the active run fails', async () => {
  await fixture(async ({ userId }) => {
    const active = chatRunRegistry.startRun({ appSessionId: SESSION, provider: 'claude', providerSessionId: null, connection: null, userId });
    scheduledMessagesDb.create({ userId, sessionId: SESSION, content: 'must wait for manual recovery', options: {}, scheduledFor: new Date(0) });
    let calls = 0;
    const runtime = gateway(async () => { calls++; });
    runtime.abort = async () => false;
    assert.equal(await dispatchDueScheduledMessages(runtime), 1);
    assert.equal(calls, 0);
    assert.equal(chatRunRegistry.getRun(SESSION), active);
    assert.equal(chatRunRegistry.isProcessing(SESSION), true);
    assert.equal(taskRunsDb.listInterrupted(userId)[0]?.content, 'must wait for manual recovery');
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION)[0].status, 'failed');
  });
});
