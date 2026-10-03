import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { api } from '@/shared/api';
import { readInputHistory } from '@/modules/chat/hooks/useInputHistory';
import { readDraftRecovery, readDraftText, resetChatDrafts, writeDraftRecovery } from '@/shared/chatDrafts';
import type { ChatMessage, PermissionMode, Project, ProjectSession, ServerEvent, TaskRecoveryRun } from '@/shared/types';

const PROJECT: Project = {
  projectId: 'delivery-project',
  displayName: 'Delivery Project',
  fullPath: '/tmp/delivery-project',
};
const SESSION: ProjectSession = { id: 'delivery-session' };
const ATTACHMENT = { name: 'notes.txt', path: '/uploads/notes.txt', mimeType: 'text/plain', size: 5 };

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      user: {
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      assets: {
        uploadFiles: () => okJson({ attachments: [ATTACHMENT] }),
      },
      taskRecovery: { requestStatus: vi.fn() },
      commands: { list: () => okJson({ success: true, commands: [] }) },
      getFiles: () => okJson([]),
      providers: { skills: () => okJson({ data: { skills: [] } }) },
    },
  };
});

const renderComposer = (options: { connected?: boolean; transportResult?: boolean } = {}) => {
  const listeners = new Set<(event: ServerEvent) => void>();
  const subscribe = (listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const sendMessage = vi.fn<(message: unknown) => boolean>(() => options.transportResult ?? true);
  const addMessage = vi.fn<(message: ChatMessage) => void>();
  const onSessionProcessing = vi.fn();
  const onDeliveryReconciled = vi.fn();
  const view = renderHook(
    ({ connected, session }: { connected: boolean; session: ProjectSession }) => useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: session,
      currentSessionId: session.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      isConnected: connected,
      subscribe,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage,
      onSessionProcessing,
      onDeliveryReconciled,
      scrollToBottom: () => undefined,
      addMessage,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
    { initialProps: { connected: options.connected ?? true, session: SESSION } },
  );

  const send = async () => {
    await act(async () => {
      await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
    });
  };
  const emit = async (event: ServerEvent) => {
    await act(async () => { listeners.forEach((listener) => listener(event)); });
  };
  const lastRequest = () => {
    const request = sendMessage.mock.calls.at(-1)?.[0] as { type: string; requestId: string; sessionId: string; recoveryOfRunId?: string };
    assert.equal(request.type, 'chat.send');
    assert.equal(typeof request.requestId, 'string');
    assert.ok(request.requestId.length > 0);
    return request;
  };
  const accept = async (requestId: string) => emit({
    kind: 'run_accepted',
    sessionId: SESSION.id,
    requestId,
    runId: `run-${requestId}`,
  });
  return { view, sendMessage, addMessage, onSessionProcessing, onDeliveryReconciled, listeners, send, emit, lastRequest, accept };
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetChatDrafts();
  vi.mocked(api.taskRecovery.requestStatus).mockReset();
  vi.mocked(api.taskRecovery.requestStatus).mockImplementation(async () => new Response(JSON.stringify({ run: null })));
});

afterEach(() => {
  vi.useRealTimers();
  resetChatDrafts();
});

test('keeps the draft and attachment until the server accepts the exact request', async () => {
  const composer = renderComposer();
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  await act(async () => {
    composer.view.result.current.setInput('Review these notes');
    composer.view.result.current.setAttachedFiles([file]);
  });

  await composer.send();
  const request = composer.lastRequest();
  assert.equal(composer.view.result.current.delivery?.state, 'sending');
  assert.equal(composer.view.result.current.delivery?.requestId, request.requestId);
  assert.equal(composer.view.result.current.input, 'Review these notes');
  assert.deepEqual(composer.view.result.current.attachedFiles, [file]);
  assert.equal(readDraftText(SESSION.id), 'Review these notes');
  assert.deepEqual(readInputHistory(SESSION.id), []);
  assert.equal(composer.addMessage.mock.calls.length, 0);
  assert.equal(composer.onSessionProcessing.mock.calls.length, 0);

  await composer.accept('someone-elses-request');
  assert.equal(composer.view.result.current.delivery?.state, 'sending');
  assert.equal(composer.addMessage.mock.calls.length, 0);

  await composer.accept(request.requestId);
  assert.equal(composer.view.result.current.delivery, null);
  assert.equal(composer.view.result.current.input, '');
  assert.deepEqual(composer.view.result.current.attachedFiles, []);
  assert.equal(readDraftText(SESSION.id), '');
  assert.deepEqual(readInputHistory(SESSION.id), ['Review these notes']);
  assert.equal(composer.addMessage.mock.calls.length, 1);
  assert.equal(composer.addMessage.mock.calls[0]?.[0].content, 'Review these notes');
  assert.deepEqual(composer.addMessage.mock.calls[0]?.[0].files, [ATTACHMENT]);
  assert.equal(composer.onSessionProcessing.mock.calls.length, 1);

  await composer.accept(request.requestId);
  assert.equal(composer.addMessage.mock.calls.length, 1, 'a replayed receipt must not create a second echo');
  assert.equal(composer.onSessionProcessing.mock.calls.length, 1);
});

test('a failed transport keeps the draft and attachment without showing a sent message', async () => {
  const composer = renderComposer({ transportResult: false });
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  await act(async () => {
    composer.view.result.current.setInput('Keep this while offline');
    composer.view.result.current.setAttachedFiles([file]);
  });

  await composer.send();
  assert.equal(composer.view.result.current.delivery?.state, 'failed');
  assert.equal(composer.view.result.current.input, 'Keep this while offline');
  assert.deepEqual(composer.view.result.current.attachedFiles, [file]);
  assert.equal(readDraftText(SESSION.id), 'Keep this while offline');
  assert.equal(composer.addMessage.mock.calls.filter(([message]) => message.type === 'user').length, 0);
  assert.equal(composer.onSessionProcessing.mock.calls.length, 0);
});

test('sending while disconnected preserves the draft without attempting a send', async () => {
  const composer = renderComposer({ connected: false });
  await act(async () => { composer.view.result.current.setInput('From the train'); });

  await composer.send();
  assert.equal(composer.sendMessage.mock.calls.length, 0);
  assert.equal(composer.view.result.current.input, 'From the train');
  assert.equal(readDraftText(SESSION.id), 'From the train');
  assert.equal(composer.addMessage.mock.calls.filter(([message]) => message.type === 'user').length, 0);
});

test('a late acceptance preserves text and attachments edited after sending', async () => {
  const composer = renderComposer();
  const firstFile = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  const nextFile = new File(['next'], 'next.txt', { type: 'text/plain' });
  await act(async () => {
    composer.view.result.current.setInput('First message');
    composer.view.result.current.setAttachedFiles([firstFile]);
  });
  await composer.send();
  const firstRequest = composer.lastRequest();

  await act(async () => {
    composer.view.result.current.setInput('Next message');
    composer.view.result.current.setAttachedFiles([nextFile]);
  });
  await composer.send();
  assert.equal(composer.sendMessage.mock.calls.length, 1, 'do not supersede an unconfirmed turn');

  await composer.accept(firstRequest.requestId);
  assert.equal(composer.view.result.current.input, 'Next message');
  assert.deepEqual(composer.view.result.current.attachedFiles, [nextFile]);
  assert.equal(readDraftText(SESSION.id), 'Next message');
  assert.equal(composer.addMessage.mock.calls[0]?.[0].content, 'First message');

  await composer.send();
  assert.equal(composer.sendMessage.mock.calls.length, 2);
  assert.notEqual(composer.lastRequest().requestId, firstRequest.requestId);
});

test('an unconfirmed send becomes unknown after 20 seconds and cannot be sent twice', async () => {
  vi.useFakeTimers();
  const composer = renderComposer();
  await act(async () => { composer.view.result.current.setInput('Possibly received on the server'); });
  await composer.send();
  const request = composer.lastRequest();

  await act(async () => { await vi.advanceTimersByTimeAsync(19_999); });
  assert.equal(composer.view.result.current.delivery?.state, 'sending');
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  assert.equal(composer.view.result.current.delivery?.state, 'unknown');
  assert.equal(composer.view.result.current.delivery?.requestId, request.requestId);
  assert.equal(readDraftText(SESSION.id), 'Possibly received on the server');
  assert.equal(composer.addMessage.mock.calls.length, 0);

  await composer.send();
  await act(async () => { composer.view.result.current.setInput('A new draft while waiting'); });
  await composer.send();
  assert.equal(composer.sendMessage.mock.calls.length, 1);

  await composer.accept(request.requestId);
  assert.equal(composer.view.result.current.delivery, null);
  assert.equal(composer.view.result.current.input, 'A new draft while waiting');
  assert.equal(composer.addMessage.mock.calls.length, 1);
});

test('only a matching protocol rejection fails a pending delivery and keeps its draft', async () => {
  const composer = renderComposer();
  await act(async () => { composer.view.result.current.setInput('Keep the rejected request'); });
  await composer.send();
  const request = composer.lastRequest();

  await composer.emit({ kind: 'protocol_error', requestId: 'unrelated', error: 'Unrelated failure' });
  assert.equal(composer.view.result.current.delivery?.state, 'sending');
  await composer.emit({
    kind: 'protocol_error',
    requestId: request.requestId,
    sessionId: SESSION.id,
    error: 'The execution host is offline',
  });
  assert.equal(composer.view.result.current.delivery?.state, 'failed');
  assert.equal(composer.view.result.current.input, 'Keep the rejected request');
  assert.equal(readDraftText(SESSION.id), 'Keep the rejected request');
  assert.equal(composer.addMessage.mock.calls.filter(([message]) => message.type === 'user').length, 0);
});

test('the transport subscription is removed when the composer unmounts', () => {
  const composer = renderComposer();
  assert.equal(composer.listeners.size, 1);
  composer.view.unmount();
  assert.equal(composer.listeners.size, 0);
});

test('two taps during attachment upload produce one request', async () => {
  const composer = renderComposer();
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  await act(async () => {
    composer.view.result.current.setInput('Only run this once');
    composer.view.result.current.setAttachedFiles([file]);
  });

  await act(async () => {
    const submitEvent = { preventDefault: () => undefined } as never;
    await Promise.all([
      composer.view.result.current.handleSubmit(submitEvent),
      composer.view.result.current.handleSubmit(submitEvent),
    ]);
  });
  assert.equal(composer.sendMessage.mock.calls.length, 1);
  assert.equal(composer.view.result.current.input, 'Only run this once');
  assert.equal(composer.addMessage.mock.calls.length, 0);
});

test('reload restores an unknown delivery without resending and preserves newly attached files', async () => {
  const first = renderComposer();
  await act(async () => { first.view.result.current.setInput('Survive a page reload'); });
  await first.send();
  const request = first.lastRequest();
  first.view.unmount();

  const restored = renderComposer();
  await act(async () => undefined);
  assert.equal(restored.view.result.current.input, 'Survive a page reload');
  assert.equal(restored.view.result.current.delivery?.state, 'unknown');
  assert.equal(restored.view.result.current.delivery?.requestId, request.requestId);
  assert.equal(restored.sendMessage.mock.calls.length, 0);
  assert.equal(vi.mocked(api.taskRecovery.requestStatus).mock.calls.at(-1)?.[0], request.requestId);

  const nextFile = new File(['after reload'], 'after-reload.txt', { type: 'text/plain' });
  await act(async () => { restored.view.result.current.setAttachedFiles([nextFile]); });
  await restored.send();
  assert.equal(restored.sendMessage.mock.calls.length, 0, 'reload must not release an ambiguous request');
  await restored.accept(request.requestId);
  assert.equal(restored.view.result.current.input, '');
  assert.deepEqual(restored.view.result.current.attachedFiles, [nextFile]);
  assert.equal(restored.addMessage.mock.calls.length, 1);
  assert.equal(sessionStorage.getItem(`chat-pending-delivery:${SESSION.id}`), null);
});

test('an explicit retry reuses the original request id and payload after the draft has changed', async () => {
  vi.useFakeTimers();
  const composer = renderComposer();
  await act(async () => { composer.view.result.current.setInput('Original request'); });
  await composer.send();
  const original = composer.lastRequest();
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  await act(async () => { composer.view.result.current.setInput('Edited while waiting'); });

  await act(async () => { await composer.view.result.current.retryDelivery(); });
  assert.deepEqual(vi.mocked(api.taskRecovery.requestStatus).mock.calls, [[original.requestId]]);
  assert.equal(composer.sendMessage.mock.calls.length, 2);
  assert.deepEqual(composer.lastRequest(), original);
  assert.equal(composer.view.result.current.delivery?.state, 'sending');
  assert.equal(composer.view.result.current.input, 'Edited while waiting');
  assert.equal(composer.addMessage.mock.calls.length, 0);

  await composer.accept(original.requestId);
  assert.equal(composer.addMessage.mock.calls.length, 1);
  assert.equal(composer.addMessage.mock.calls[0]?.[0].content, 'Original request');
  assert.equal(composer.view.result.current.input, 'Edited while waiting');
});

const renderUnknownComposer = async () => {
  vi.useFakeTimers();
  const composer = renderComposer();
  await act(async () => { composer.view.result.current.setInput('Do not execute this twice'); });
  await composer.send();
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  assert.equal(composer.view.result.current.delivery?.state, 'unknown');
  return composer;
};

test.each([
  ['an older backend returning 404', () => new Response(JSON.stringify({ run: null }), { status: 404 })],
  ['a server error', () => new Response(JSON.stringify({ run: null }), { status: 500 })],
  ['an empty 204 response', () => new Response(null, { status: 204 })],
  ['invalid JSON', () => new Response('not json')],
  ['a null body', () => new Response('null')],
  ['an array body', () => new Response('[]')],
  ['a missing run field', () => new Response('{}')],
  ['an array run field', () => new Response(JSON.stringify({ run: [] }))],
  ['a network failure', () => { throw new TypeError('Failed to fetch'); }],
] as const)('retry keeps the request unknown after %s', async (_name, response) => {
  const composer = await renderUnknownComposer();
  const original = composer.lastRequest();
  vi.mocked(api.taskRecovery.requestStatus).mockImplementationOnce(async () => response());

  await act(async () => { await composer.view.result.current.retryDelivery(); });

  assert.deepEqual(vi.mocked(api.taskRecovery.requestStatus).mock.calls, [[original.requestId]]);
  assert.deepEqual(composer.view.result.current.delivery, {
    requestId: original.requestId, state: 'unknown', errorCode: 'DELIVERY_CHECK_UNAVAILABLE',
  });
  assert.equal(composer.sendMessage.mock.calls.length, 1, 'an unavailable deduplication check must never resend');
  assert.equal(composer.view.result.current.input, 'Do not execute this twice');
  assert.equal(readDraftText(SESSION.id), 'Do not execute this twice');
  assert.equal(composer.addMessage.mock.calls.length, 0);
  assert.equal(composer.onDeliveryReconciled.mock.calls.length, 0);
});

test.each([
  ['a different request', { requestId: 'another-request' }],
  ['a different session', { sessionId: 'another-session' }],
  ['an empty run id', { runId: '' }],
  ['a missing state', { state: undefined }],
  ['an unknown state', { state: 'unrecognized-state' }],
] as const)('retry does not consume or resend a lookup record with %s', async (_name, invalidFields) => {
  const composer = await renderUnknownComposer();
  const original = composer.lastRequest();
  vi.mocked(api.taskRecovery.requestStatus).mockResolvedValueOnce(new Response(JSON.stringify({
    run: { requestId: original.requestId, sessionId: SESSION.id, runId: 'existing-run', state: 'completed', ...invalidFields },
  })));

  await act(async () => { await composer.view.result.current.retryDelivery(); });

  assert.deepEqual(composer.view.result.current.delivery, {
    requestId: original.requestId, state: 'unknown', errorCode: 'DELIVERY_CHECK_UNAVAILABLE',
  });
  assert.equal(composer.sendMessage.mock.calls.length, 1);
  assert.equal(composer.view.result.current.input, 'Do not execute this twice');
  assert.equal(composer.onDeliveryReconciled.mock.calls.length, 0);
});

test.each(['accepted', 'running', 'completed', 'failed', 'interrupted', 'aborted'])('retry reconciles an existing %s run without resending', async (state) => {
  const composer = await renderUnknownComposer();
  const original = composer.lastRequest();
  vi.mocked(api.taskRecovery.requestStatus).mockResolvedValueOnce(new Response(JSON.stringify({
    run: { requestId: original.requestId, sessionId: SESSION.id, runId: 'existing-run', state },
  })));

  await act(async () => { await composer.view.result.current.retryDelivery(); });

  assert.deepEqual(vi.mocked(api.taskRecovery.requestStatus).mock.calls, [[original.requestId]]);
  assert.equal(composer.sendMessage.mock.calls.length, 1);
  assert.equal(composer.view.result.current.delivery, null);
  assert.equal(composer.view.result.current.input, '');
  assert.equal(composer.addMessage.mock.calls.length, 0, 'history reconciliation must not append a duplicate message');
  assert.deepEqual(composer.onDeliveryReconciled.mock.calls, [[SESSION.id]]);
  assert.equal(composer.onSessionProcessing.mock.calls.length, state === 'accepted' || state === 'running' ? 1 : 0);
  assert.equal(sessionStorage.getItem(`chat-pending-delivery:${SESSION.id}`), null);
});

test.each(['switch session', 'unmount', 'receive acceptance', 'disconnect'] as const)('a retry lookup must not resend after %s', async (change) => {
  const composer = await renderUnknownComposer();
  const original = composer.lastRequest();
  let completeLookup!: (response: Response) => void;
  vi.mocked(api.taskRecovery.requestStatus).mockImplementationOnce(() => new Promise<Response>((resolve) => {
    completeLookup = resolve;
  }));
  let retry!: Promise<void>;
  await act(async () => { retry = composer.view.result.current.retryDelivery(); });
  assert.deepEqual(vi.mocked(api.taskRecovery.requestStatus).mock.calls, [[original.requestId]]);
  assert.equal(composer.sendMessage.mock.calls.length, 1, 'retry must wait for the lookup result');

  if (change === 'receive acceptance') await composer.accept(original.requestId);
  else if (change === 'unmount') composer.view.unmount();
  else {
    await act(async () => {
      composer.view.rerender({ connected: change !== 'disconnect', session: change === 'switch session' ? { id: 'session-b' } : SESSION });
    });
    if (change === 'switch session') {
      await act(async () => { composer.view.result.current.setInput('New session draft'); });
    }
  }
  await act(async () => {
    completeLookup(new Response(JSON.stringify({ run: null })));
    await retry;
  });

  assert.equal(composer.sendMessage.mock.calls.length, 1);
  if (change === 'switch session') {
    assert.equal(composer.view.result.current.input, 'New session draft');
    assert.equal(composer.view.result.current.delivery, null);
    assert.equal(readDraftText(SESSION.id), 'Do not execute this twice');
  } else if (change === 'receive acceptance') {
    assert.equal(composer.view.result.current.delivery, null);
    assert.equal(composer.addMessage.mock.calls.length, 1);
  } else if (change === 'disconnect') {
    assert.deepEqual(composer.view.result.current.delivery, {
      requestId: original.requestId, state: 'unknown', errorCode: 'DELIVERY_CHECK_UNAVAILABLE',
    });
  }
});

test('concurrent retries share one lookup and resend the original payload once', async () => {
  const composer = await renderUnknownComposer();
  const original = composer.lastRequest();
  let completeLookup!: (response: Response) => void;
  vi.mocked(api.taskRecovery.requestStatus).mockImplementationOnce(() => new Promise<Response>((resolve) => {
    completeLookup = resolve;
  }));
  let retries!: Promise<void[]>;
  await act(async () => {
    retries = Promise.all([
      composer.view.result.current.retryDelivery(),
      composer.view.result.current.retryDelivery(),
    ]);
  });
  assert.deepEqual(vi.mocked(api.taskRecovery.requestStatus).mock.calls, [[original.requestId]]);
  assert.equal(composer.sendMessage.mock.calls.length, 1);

  await act(async () => {
    completeLookup(new Response(JSON.stringify({ run: null })));
    await retries;
  });

  assert.equal(composer.sendMessage.mock.calls.length, 2);
  assert.deepEqual(composer.lastRequest(), original);
  assert.equal(composer.view.result.current.delivery?.state, 'sending');
  assert.equal(composer.addMessage.mock.calls.length, 0);
});

test('a read-only lookup with no record never automatically retries an unknown request', async () => {
  const composer = renderComposer();
  await act(async () => { composer.view.result.current.setInput('Check before any retry'); });
  await composer.send();
  const request = composer.lastRequest();

  await act(async () => { await composer.view.result.current.checkDelivery(); });
  assert.equal(composer.view.result.current.delivery?.state, 'unknown');
  assert.equal(composer.sendMessage.mock.calls.length, 1);
  assert.equal(composer.view.result.current.input, 'Check before any retry');
  await composer.emit({ kind: 'websocket_reconnected' });
  assert.equal(composer.sendMessage.mock.calls.length, 1);
  assert.equal(composer.view.result.current.delivery?.requestId, request.requestId);
  assert.equal(composer.addMessage.mock.calls.length, 0);
});

test('a confirmed read-only lookup after reload clears the sent snapshot without restarting completed work', async () => {
  const first = renderComposer();
  await act(async () => { first.view.result.current.setInput('Already completed while away'); });
  await first.send();
  const request = first.lastRequest();
  first.view.unmount();
  vi.mocked(api.taskRecovery.requestStatus).mockImplementation(async () => new Response(JSON.stringify({
    run: { requestId: request.requestId, sessionId: SESSION.id, runId: 'completed-run', state: 'completed' },
  })));

  const restored = renderComposer();
  await act(async () => undefined);
  assert.equal(restored.view.result.current.delivery, null);
  assert.equal(restored.view.result.current.input, '');
  assert.equal(readDraftText(SESSION.id), '');
  assert.equal(restored.sendMessage.mock.calls.length, 0);
  assert.equal(restored.onSessionProcessing.mock.calls.length, 0);
  assert.equal(restored.addMessage.mock.calls.length, 0);
  assert.deepEqual(restored.onDeliveryReconciled.mock.calls, [[SESSION.id]]);
  assert.equal(sessionStorage.getItem(`chat-pending-delivery:${SESSION.id}`), null);
});

test('switching sessions does not apply one session receipt to another session draft', async () => {
  const composer = renderComposer();
  await act(async () => { composer.view.result.current.setInput('Pending in session A'); });
  await composer.send();
  const request = composer.lastRequest();

  await act(async () => {
    composer.view.rerender({ connected: true, session: { id: 'session-b' } });
  });
  await act(async () => { composer.view.result.current.setInput('Unsent in session B'); });
  await composer.accept(request.requestId);
  assert.equal(composer.view.result.current.input, 'Unsent in session B');
  assert.equal(readDraftText('session-b'), 'Unsent in session B');
  assert.equal(composer.addMessage.mock.calls.length, 0);
  assert.equal(composer.view.result.current.delivery, null);

  await act(async () => { composer.view.rerender({ connected: true, session: SESSION }); });
  assert.equal(composer.view.result.current.input, 'Pending in session A');
  assert.deepEqual(composer.view.result.current.delivery, { requestId: request.requestId, state: 'unknown' });
  await composer.accept(request.requestId);
  assert.equal(composer.view.result.current.input, '');
  assert.equal(readDraftText(SESSION.id), '');
  assert.equal(readDraftText('session-b'), 'Unsent in session B');
  assert.equal(composer.addMessage.mock.calls.length, 1);
});

const RECOVERY_RUN: TaskRecoveryRun = {
  runId: 'interrupted-original-run',
  requestId: 'interrupted-original-request',
  sessionId: SESSION.id,
  projectPath: PROJECT.fullPath!,
  provider: 'claude',
  state: 'interrupted',
  content: 'Continue the repository review without repeating completed actions',
  startedAt: '2026-10-02T10:00:00Z',
};

test('a prepared continuation keeps its recovery identity when the composer remounts', async () => {
  const first = renderComposer();
  await act(async () => { first.view.result.current.prepareRecovery(RECOVERY_RUN); });
  const continuation = first.view.result.current.input;
  assert.ok(continuation.includes(RECOVERY_RUN.content));
  assert.equal(readDraftRecovery(SESSION.id), RECOVERY_RUN.runId);
  assert.equal(first.sendMessage.mock.calls.length, 0);
  first.view.unmount();

  const restored = renderComposer();
  await act(async () => undefined);
  assert.equal(restored.view.result.current.input, continuation);
  assert.equal(restored.view.result.current.preparedRecovery?.runId, RECOVERY_RUN.runId);
  await restored.send();
  assert.equal(restored.lastRequest().recoveryOfRunId, RECOVERY_RUN.runId);
});

test.each(['clear text', 'remove recovery association'] as const)('%s leaves the next message as a fresh request', async (action) => {
  const composer = renderComposer();
  await act(async () => { composer.view.result.current.prepareRecovery(RECOVERY_RUN); });
  await act(async () => {
    if (action === 'clear text') composer.view.result.current.handleClearInput();
    else writeDraftRecovery(SESSION.id, null);
  });
  assert.equal(readDraftRecovery(SESSION.id), null);
  assert.equal(composer.view.result.current.preparedRecovery, null);

  await act(async () => { composer.view.result.current.setInput('An independent new request'); });
  await composer.send();
  assert.equal(composer.lastRequest().recoveryOfRunId, undefined);
});

test('accepting a continuation clears its recovery association while retaining a later edited draft', async () => {
  const composer = renderComposer();
  await act(async () => { composer.view.result.current.prepareRecovery(RECOVERY_RUN); });
  await composer.send();
  const recoveryRequest = composer.lastRequest();
  assert.equal(recoveryRequest.recoveryOfRunId, RECOVERY_RUN.runId);
  await act(async () => { composer.view.result.current.setInput('My next independent request'); });

  await composer.accept(recoveryRequest.requestId);
  assert.equal(composer.view.result.current.input, 'My next independent request');
  assert.equal(readDraftText(SESSION.id), 'My next independent request');
  assert.equal(readDraftRecovery(SESSION.id), null);
  assert.equal(composer.view.result.current.preparedRecovery, null);
  await composer.send();
  assert.equal(composer.lastRequest().recoveryOfRunId, undefined);
});

test('a delayed receipt uses the original send time for the user message', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T10:00:00Z'));
  const composer = renderComposer();
  await act(async () => { composer.view.result.current.setInput('This receipt will arrive late'); });
  await composer.send();
  const request = composer.lastRequest();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  await composer.accept(request.requestId);

  const message = composer.addMessage.mock.calls[0]?.[0];
  const timestamp = message?.timestamp;
  assert.ok(timestamp instanceof Date);
  assert.equal(timestamp.toISOString(), '2026-10-02T10:00:00.000Z');
});

test('a receipt for a server-deduplicated retry reconciles history without appending a duplicate message', async () => {
  const composer = renderComposer();
  await act(async () => { composer.view.result.current.setInput('Already accepted elsewhere'); });
  await composer.send();
  const request = composer.lastRequest();
  await composer.emit({
    kind: 'run_accepted', sessionId: SESSION.id, requestId: request.requestId,
    runId: 'existing-run', duplicate: true,
  });

  assert.equal(composer.view.result.current.input, '');
  assert.equal(composer.addMessage.mock.calls.length, 0);
  assert.deepEqual(composer.onDeliveryReconciled.mock.calls, [[SESSION.id]]);
});
