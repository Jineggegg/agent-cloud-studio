import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { ChatRecoveryBanner } from '@/modules/chat/composer/ChatRecoveryBanner';
import { useTaskRecovery } from '@/modules/chat/hooks/useTaskRecovery';
import { api } from '@/shared/api';
import type { ServerEvent, TaskRecoveryRun } from '@/shared/types';

const RUN: TaskRecoveryRun = {
  runId: 'interrupted-run',
  requestId: 'original-request',
  sessionId: 'session-one',
  projectPath: '/projects/one',
  provider: 'claude',
  state: 'interrupted',
  content: 'Review the repository and prepare a change',
  startedAt: '2026-10-02T10:00:00Z',
};

vi.mock('@/shared/api', () => ({
  api: { taskRecovery: { list: vi.fn(), resolve: vi.fn() } },
}));

const response = (runs: TaskRecoveryRun[]) => new Response(JSON.stringify({ runs }), { status: 200 });
const deferredResponse = () => {
  let resolve!: (value: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const renderRecovery = (initialSession: string | null = RUN.sessionId) => {
  const listeners = new Set<(event: ServerEvent) => void>();
  const subscribe = (listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const view = renderHook(
    ({ projectPath, sessionId }: { projectPath: string; sessionId: string | null }) => useTaskRecovery({
      projectPath, sessionId, subscribe,
    }),
    { initialProps: { projectPath: RUN.projectPath, sessionId: initialSession } },
  );
  return { view, listeners };
};

beforeEach(() => {
  vi.mocked(api.taskRecovery.list).mockReset();
  vi.mocked(api.taskRecovery.list).mockImplementation(async () => response([]));
  vi.mocked(api.taskRecovery.resolve).mockReset();
  vi.mocked(api.taskRecovery.resolve).mockImplementation(async () => new Response('{}'));
});

test('only interrupted or failed runs from the exact project and conversation enter the recovery list', async () => {
  vi.mocked(api.taskRecovery.list).mockImplementation(async () => response([
    RUN,
    { ...RUN, runId: 'other-project', projectPath: '/projects/two' },
    { ...RUN, runId: 'other-session', sessionId: 'session-two' },
    { ...RUN, runId: 'without-session', sessionId: null },
    { ...RUN, runId: 'failed', state: 'failed' },
    { ...RUN, runId: 'completed', state: 'completed' },
    { ...RUN, runId: 'running', state: 'running' },
  ]));
  const { view } = renderRecovery();
  await act(async () => undefined);

  assert.deepEqual(view.result.current.runs, [RUN, { ...RUN, runId: 'failed', state: 'failed' }]);
  assert.deepEqual(vi.mocked(api.taskRecovery.list).mock.calls[0], [RUN.projectPath, RUN.sessionId]);
  assert.equal(view.result.current.error, false);
});

test('a new conversation lists only unassigned interrupted runs in its own project', async () => {
  const unassigned = { ...RUN, runId: 'without-session', sessionId: null };
  vi.mocked(api.taskRecovery.list).mockImplementation(async () => response([
    RUN,
    unassigned,
    { ...unassigned, runId: 'different-project', projectPath: '/projects/two' },
  ]));
  const { view } = renderRecovery(null);
  await act(async () => undefined);

  assert.deepEqual(view.result.current.runs, [unassigned]);
  assert.deepEqual(vi.mocked(api.taskRecovery.list).mock.calls[0], [RUN.projectPath, null]);
});

test('a delayed result from the previous conversation cannot replace the currently open conversation', async () => {
  const firstRequest = deferredResponse();
  const secondRequest = deferredResponse();
  vi.mocked(api.taskRecovery.list)
    .mockReturnValueOnce(firstRequest.promise)
    .mockReturnValueOnce(secondRequest.promise);
  const { view } = renderRecovery();

  await act(async () => { view.rerender({ projectPath: '/projects/two', sessionId: 'session-two' }); });
  assert.deepEqual(view.result.current.runs, []);
  const currentRun = { ...RUN, runId: 'current-run', projectPath: '/projects/two', sessionId: 'session-two' };
  await act(async () => { secondRequest.resolve(response([currentRun])); });
  assert.deepEqual(view.result.current.runs, [currentRun]);

  await act(async () => { firstRequest.resolve(response([RUN])); });
  assert.deepEqual(view.result.current.runs, [currentRun]);
  assert.equal(view.result.current.error, false);
});

test('a stale failed lookup cannot turn the current conversation into an error', async () => {
  const firstRequest = deferredResponse();
  vi.mocked(api.taskRecovery.list).mockReturnValueOnce(firstRequest.promise);
  const { view } = renderRecovery();
  await act(async () => { view.rerender({ projectPath: '/projects/two', sessionId: 'session-two' }); });
  await act(async () => { firstRequest.reject(new Error('Old request lost its connection')); });

  assert.deepEqual(view.result.current.runs, []);
  assert.equal(view.result.current.error, false);
});

test('a newer refresh supersedes a slower response within the same conversation', async () => {
  const firstRequest = deferredResponse();
  vi.mocked(api.taskRecovery.list)
    .mockReturnValueOnce(firstRequest.promise)
    .mockResolvedValueOnce(response([RUN]));
  const { view } = renderRecovery();

  await act(async () => { await view.result.current.refresh(); });
  assert.deepEqual(view.result.current.runs, [RUN]);
  await act(async () => { firstRequest.resolve(response([])); });
  assert.deepEqual(view.result.current.runs, [RUN]);
});

test('a failed review preserves the record and reports rejection to the banner', async () => {
  vi.mocked(api.taskRecovery.list).mockImplementation(async () => response([RUN]));
  vi.mocked(api.taskRecovery.resolve).mockResolvedValueOnce(new Response('{}', { status: 503 }));
  const { view } = renderRecovery();
  await act(async () => undefined);

  await act(async () => {
    await assert.rejects(view.result.current.resolve(RUN.runId), /Recovery update failed/);
  });
  assert.deepEqual(view.result.current.runs, [RUN]);
  assert.equal(vi.mocked(api.taskRecovery.list).mock.calls.length, 1);
});

test('reconnect refreshes recovery records and unmount removes the subscription', async () => {
  const { view, listeners } = renderRecovery();
  await act(async () => undefined);
  assert.equal(listeners.size, 1);

  vi.mocked(api.taskRecovery.list).mockResolvedValueOnce(response([RUN]));
  await act(async () => {
    listeners.forEach((listener) => listener({ kind: 'websocket_reconnected' }));
  });
  assert.deepEqual(view.result.current.runs, [RUN]);
  view.unmount();
  assert.equal(listeners.size, 0);
});

test('finishing a review from the previous conversation does not invalidate the new conversation lookup', async () => {
  const reviewRequest = deferredResponse();
  const currentLookup = deferredResponse();
  vi.mocked(api.taskRecovery.list)
    .mockResolvedValueOnce(response([RUN]))
    .mockReturnValueOnce(currentLookup.promise);
  vi.mocked(api.taskRecovery.resolve).mockReturnValueOnce(reviewRequest.promise);
  const { view } = renderRecovery();
  await act(async () => undefined);

  let review: Promise<void>;
  await act(async () => { review = view.result.current.resolve(RUN.runId); });
  await act(async () => { view.rerender({ projectPath: '/projects/two', sessionId: 'session-two' }); });
  await act(async () => {
    reviewRequest.resolve(new Response('{}'));
    await review;
  });
  const currentRun = { ...RUN, runId: 'current-run', projectPath: '/projects/two', sessionId: 'session-two' };
  await act(async () => { currentLookup.resolve(response([currentRun])); });
  assert.deepEqual(view.result.current.runs, [currentRun]);
});

const emit = (listeners: Set<(event: ServerEvent) => void>, event: ServerEvent) => {
  listeners.forEach((listener) => listener(event));
};

test('a continuation receipt closes the claimed card at once and refetches the list', async () => {
  vi.mocked(api.taskRecovery.list).mockResolvedValueOnce(response([RUN]));
  const { view, listeners } = renderRecovery();
  await act(async () => undefined);
  assert.deepEqual(view.result.current.runs, [RUN]);

  // The refetch is still in flight: the card must not wait for it.
  const refetch = deferredResponse();
  vi.mocked(api.taskRecovery.list).mockReturnValueOnce(refetch.promise);
  await act(async () => {
    emit(listeners, { kind: 'run_accepted', sessionId: RUN.sessionId!, runId: 'continuation-run', recoveryOfRunId: RUN.runId });
  });
  assert.deepEqual(view.result.current.runs, []);
  assert.equal(vi.mocked(api.taskRecovery.list).mock.calls.length, 2);
  await act(async () => { refetch.resolve(response([])); });
  assert.deepEqual(view.result.current.runs, []);
  assert.equal(view.result.current.error, false);
});

test('a lookup that started before the claim cannot bring the claimed card back', async () => {
  vi.mocked(api.taskRecovery.list).mockResolvedValueOnce(response([RUN]));
  const { view, listeners } = renderRecovery();
  await act(async () => undefined);

  const staleLookup = deferredResponse();
  vi.mocked(api.taskRecovery.list).mockReturnValueOnce(staleLookup.promise).mockResolvedValueOnce(response([]));
  await act(async () => { void view.result.current.refresh(); });
  await act(async () => {
    emit(listeners, { kind: 'run_accepted', sessionId: RUN.sessionId!, runId: 'continuation-run', recoveryOfRunId: RUN.runId });
  });
  await act(async () => { staleLookup.resolve(response([RUN])); });
  assert.deepEqual(view.result.current.runs, []);
});

test('reviewing a record already claimed elsewhere closes the card without an error', async () => {
  vi.mocked(api.taskRecovery.list).mockResolvedValueOnce(response([RUN]));
  vi.mocked(api.taskRecovery.resolve).mockResolvedValueOnce(
    new Response(JSON.stringify({ resolved: true, alreadyHandled: true }), { status: 200 }),
  );
  const { view } = renderRecovery();
  await act(async () => undefined);

  await act(async () => { await view.result.current.resolve(RUN.runId); });
  assert.deepEqual(view.result.current.runs, []);
  assert.deepEqual(vi.mocked(api.taskRecovery.resolve).mock.calls[0], [RUN.runId]);
  assert.equal(vi.mocked(api.taskRecovery.list).mock.calls.length, 2);
  assert.equal(view.result.current.error, false);
});

test('reviewing a record the server no longer has closes the card without an error', async () => {
  vi.mocked(api.taskRecovery.list).mockResolvedValueOnce(response([RUN]));
  vi.mocked(api.taskRecovery.resolve).mockResolvedValueOnce(
    new Response(JSON.stringify({ error: 'Recoverable task not found', code: 'RECOVERY_NOT_FOUND' }), { status: 404 }),
  );
  const { view } = renderRecovery();
  await act(async () => undefined);

  await act(async () => { await view.result.current.resolve(RUN.runId); });
  assert.deepEqual(view.result.current.runs, []);
  assert.equal(vi.mocked(api.taskRecovery.list).mock.calls.length, 2);
});

test('the banner shows no update error when the record was already handled', async () => {
  vi.mocked(api.taskRecovery.list).mockResolvedValueOnce(response([RUN]));
  vi.mocked(api.taskRecovery.resolve).mockResolvedValueOnce(new Response('{}', { status: 404 }));
  const subscribe = () => () => undefined;
  function RecoveryCard() {
    const recovery = useTaskRecovery({ projectPath: RUN.projectPath, sessionId: RUN.sessionId, subscribe });
    return <ChatRecoveryBanner runs={recovery.runs} error={recovery.error} onRefresh={recovery.refresh}
      onViewRecords={() => undefined} onPrepare={() => undefined} onResolve={recovery.resolve} />;
  }
  render(<RecoveryCard />);
  await act(async () => undefined);
  assert.ok(screen.getByText(RUN.content));

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' })); });
  assert.equal(screen.queryByRole('alert'), null);
  assert.equal(screen.queryByText(RUN.content), null);
});

test('run start and finish events in the conversation refetch the list once per run', async () => {
  const { listeners } = renderRecovery();
  await act(async () => undefined);
  const lookups = () => vi.mocked(api.taskRecovery.list).mock.calls.length;
  assert.equal(lookups(), 1);

  // A continuation started on another device is first seen as a new run's stream.
  await act(async () => {
    emit(listeners, { kind: 'stream_delta', sessionId: RUN.sessionId!, runId: 'continuation-run', seq: 1 });
    emit(listeners, { kind: 'stream_delta', sessionId: RUN.sessionId!, runId: 'continuation-run', seq: 2 });
  });
  assert.equal(lookups(), 2);
  await act(async () => { emit(listeners, { kind: 'complete', sessionId: RUN.sessionId!, runId: 'continuation-run', success: true }); });
  assert.equal(lookups(), 3);
  await act(async () => { emit(listeners, { kind: 'chat_subscribed', sessionId: RUN.sessionId!, isProcessing: true }); });
  assert.equal(lookups(), 4);
  await act(async () => { emit(listeners, { kind: 'chat_subscribed', sessionId: RUN.sessionId!, isProcessing: false }); });
  assert.equal(lookups(), 4);
  await act(async () => { emit(listeners, { kind: 'run_accepted', sessionId: RUN.sessionId!, runId: 'next-run', requestId: 'next' }); });
  assert.equal(lookups(), 5);

  // Other conversations' runs do not affect this list.
  await act(async () => {
    emit(listeners, { kind: 'stream_delta', sessionId: 'session-two', runId: 'other-run', seq: 1 });
    emit(listeners, { kind: 'complete', sessionId: 'session-two', runId: 'other-run', success: true });
  });
  assert.equal(lookups(), 5);
});
