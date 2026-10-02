import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import type * as SharedUtils from '@/shared/utils';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage, PendingPermissionRequest, Project, ProjectSession, ServerEvent } from '@/shared/types';

const SESSION: ProjectSession = { id: 'replay-session' };
const PROJECT: Project = { projectId: 'replay-project', displayName: 'Replay project', fullPath: '/projects/replay' };

vi.mock('@/shared/api', () => ({
  api: { providers: { sessionTokenUsage: async () => ({ ok: false, json: async () => ({}) }) } },
}));
vi.mock('@/shared/utils', async (importOriginal) => ({
  ...await importOriginal<typeof SharedUtils>(),
  playNotificationSound: vi.fn(),
  playChatCompletionSound: vi.fn(),
}));

const renderHandlers = () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  let permissions: PendingPermissionRequest[] = [];
  const stored: NormalizedMessage[] = [];
  const streamTimerRef = { current: null as number | null };
  const accumulatedStreamRef = { current: '' };
  const lastSeqRef = { current: new Map<string, number>() };
  const lastRunIdRef = { current: new Map<string, string>() };
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const updateStreaming = vi.fn();
  const finalizeStreaming = vi.fn();
  const onSessionProcessing = vi.fn();
  const onSessionIdle = vi.fn();
  const onSessionBackground = vi.fn();
  const setTokenBudget = vi.fn();
  const slot = { fetchedAt: 1, status: 'idle' as const, total: 0, hasMore: false, offset: 0 };
  const store = {
    appendRealtime: (_sessionId: string, message: NormalizedMessage) => { stored.push(message); },
    getMessages: () => stored,
    updateStreaming,
    finalizeStreaming,
    fetchFromServer: vi.fn(async () => slot),
    fetchMore: vi.fn(),
    refreshLatestFromServer: vi.fn(),
    setActiveSession: vi.fn(),
    isStale: vi.fn(() => false),
    getSessionSlot: vi.fn(() => slot),
  } as unknown as SessionStore;

  const view = renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (next) => { listener = next; return () => { listener = null; }; },
    provider: 'claude',
    selectedSession: SESSION,
    currentSessionId: SESSION.id,
    pendingPermissionRequests: [],
    setPendingPermissionRequests: (next) => { permissions = typeof next === 'function' ? next(permissions) : next; },
    setTokenBudget,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    lastRunIdRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onSessionBackground,
    requestLatestMessages: async () => undefined,
    sessionStore: store,
  }));
  const dispatch = (event: ServerEvent) => act(() => { listener?.(event); });
  return {
    view, dispatch, stored, store, updateStreaming, finalizeStreaming,
    onSessionProcessing, onSessionIdle, onSessionBackground, setTokenBudget,
    streamTimerRef, accumulatedStreamRef, lastSeqRef, lastRunIdRef, statusCheckSentAtRef,
    permissions: () => permissions,
  };
};

const event = (runId: string, fields: Record<string, unknown>): ServerEvent => ({
  id: `${runId}-${String(fields.kind)}-${String(fields.seq)}`,
  sessionId: SESSION.id,
  provider: 'claude',
  timestamp: '2026-10-02T10:00:00Z',
  runId,
  ...fields,
});

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('a new execution accepts sequence one after a prior execution reached sequence one hundred', () => {
  const handler = renderHandlers();
  handler.dispatch(event('run-one', { kind: 'text', role: 'assistant', content: 'Old turn', seq: 100 }));
  assert.equal(handler.lastSeqRef.current.get(SESSION.id), 100);
  handler.dispatch(event('run-two', { kind: 'run_accepted', requestId: 'second-request' }));
  assert.equal(handler.lastSeqRef.current.get(SESSION.id), 0);
  handler.dispatch(event('run-two', { kind: 'text', role: 'assistant', content: 'New turn', seq: 1 }));
  handler.dispatch(event('run-two', { kind: 'text', role: 'assistant', content: 'Duplicate replay', seq: 1 }));

  assert.equal(handler.lastRunIdRef.current.get(SESSION.id), 'run-two');
  assert.equal(handler.lastSeqRef.current.get(SESSION.id), 1);
  assert.deepEqual(handler.stored.filter((message) => message.kind === 'text').map((message) => message.content), ['Old turn', 'New turn']);
});

test('a subscribe acknowledgement switches the replay cursor to the current execution', () => {
  const handler = renderHandlers();
  handler.dispatch(event('run-one', { kind: 'text', role: 'assistant', content: 'Old turn', seq: 100 }));
  handler.dispatch(event('run-two', { kind: 'chat_subscribed', isProcessing: true, pendingPermissions: [] }));
  assert.equal(handler.lastRunIdRef.current.get(SESSION.id), 'run-two');
  assert.equal(handler.lastSeqRef.current.get(SESSION.id), 0);

  handler.dispatch(event('run-two', { kind: 'text', role: 'assistant', content: 'First replay in the new run', seq: 1 }));
  assert.equal(handler.lastSeqRef.current.get(SESSION.id), 1);
  assert.ok(handler.stored.some((message) => message.content === 'First replay in the new run'));
});

test('switching executions flushes and closes the previous stream without mixing its text into the next stream', async () => {
  vi.useFakeTimers();
  const handler = renderHandlers();
  handler.dispatch(event('run-one', { kind: 'stream_delta', content: 'Old stream', seq: 100 }));
  handler.dispatch(event('run-two', { kind: 'run_accepted', requestId: 'second-request' }));
  assert.equal(handler.accumulatedStreamRef.current, '');
  assert.equal(handler.streamTimerRef.current, null);
  assert.deepEqual(handler.finalizeStreaming.mock.calls, [[SESSION.id]]);

  handler.dispatch(event('run-two', { kind: 'stream_delta', content: 'New stream', seq: 1 }));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  assert.deepEqual(handler.updateStreaming.mock.calls.map((call) => call[1]), ['Old stream', 'New stream']);
  assert.equal(handler.accumulatedStreamRef.current, 'New stream');
});

test('late records from a retired execution are retained without changing the active execution or replaying approvals', () => {
  const handler = renderHandlers();
  handler.dispatch(event('run-one', { kind: 'text', role: 'assistant', content: 'Old turn', seq: 100 }));
  handler.dispatch(event('run-two', { kind: 'run_accepted', requestId: 'second-request' }));
  handler.dispatch(event('run-two', { kind: 'text', role: 'assistant', content: 'New turn', seq: 1 }));
  handler.onSessionProcessing.mockClear();
  handler.onSessionIdle.mockClear();
  handler.onSessionBackground.mockClear();
  handler.setTokenBudget.mockClear();

  handler.dispatch(event('run-one', { kind: 'text', role: 'assistant', content: 'Late old text', seq: 101 }));
  handler.dispatch(event('run-one', { kind: 'tool_result', toolId: 'old-tool', content: 'Late old tool result', seq: 102 }));
  handler.dispatch(event('run-one', { kind: 'task_notification', status: 'completed', summary: 'Late old task', seq: 103 }));
  handler.dispatch(event('run-one', { kind: 'permission_request', requestId: 'old-approval', toolName: 'Bash', input: { command: 'deploy' }, seq: 104 }));
  handler.dispatch(event('run-one', { kind: 'status', text: 'token_budget', tokenBudget: { used: 999, total: 1000 }, seq: 105 }));
  handler.dispatch(event('run-one', { kind: 'complete', success: true, seq: 106 }));
  handler.dispatch(event('run-one', { kind: 'text', role: 'assistant', content: 'Duplicate late text', seq: 101 }));

  assert.ok(handler.stored.some((message) => message.content === 'Late old text'));
  assert.ok(handler.stored.some((message) => message.content === 'Late old tool result'));
  assert.ok(handler.stored.some((message) => message.kind === 'task_notification' && message.summary === 'Late old task'));
  assert.equal(handler.stored.filter((message) => message.content === 'Duplicate late text').length, 0);
  assert.equal(handler.lastRunIdRef.current.get(SESSION.id), 'run-two');
  assert.equal(handler.lastSeqRef.current.get(SESSION.id), 1);
  assert.deepEqual(handler.permissions(), []);
  assert.equal(handler.onSessionProcessing.mock.calls.length, 0);
  assert.equal(handler.onSessionIdle.mock.calls.length, 0);
  assert.equal(handler.onSessionBackground.mock.calls.length, 0);
  assert.equal(handler.setTokenBudget.mock.calls.length, 0);
});

test('a new subscription sends the current execution id with its own sequence cursor', async () => {
  const handler = renderHandlers();
  handler.dispatch(event('run-one', { kind: 'text', role: 'assistant', content: 'Old turn', seq: 100 }));
  handler.dispatch(event('run-two', { kind: 'run_accepted', requestId: 'second-request' }));
  handler.dispatch(event('run-two', { kind: 'text', role: 'assistant', content: 'New turn', seq: 1 }));
  const sendMessage = vi.fn();
  renderHook(() => useChatSessionState({
    isActive: true,
    selectedProject: PROJECT,
    selectedSession: SESSION,
    ws: { readyState: WebSocket.OPEN } as WebSocket,
    sendMessage,
    resetStreamingState: () => undefined,
    statusCheckSentAtRef: handler.statusCheckSentAtRef,
    lastSeqRef: handler.lastSeqRef,
    lastRunIdRef: handler.lastRunIdRef,
    sessionStore: handler.store,
  }));
  await act(async () => undefined);

  const subscription = sendMessage.mock.calls.map(([message]) => message).find((message) => message.type === 'chat.subscribe');
  assert.deepEqual(subscription?.sessions, [{ sessionId: SESSION.id, lastSeq: 1, runId: 'run-two' }]);
});
