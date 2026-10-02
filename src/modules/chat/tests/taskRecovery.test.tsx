import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

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
