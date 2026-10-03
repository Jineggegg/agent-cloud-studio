import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { api } from '@/shared/api';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { ChatMessage, PermissionMode, Project, ProjectSession, ServerEvent } from '@/shared/types';

/**
 * prepareNewSessionContent: the workbench rewrites a new conversation's first prompt when it takes over another
 * provider's conversation (the handoff summary is appended). Only what the provider receives changes.
 */

const PROJECT: Project = { projectId: 'handoff-project', displayName: 'Handoff Project', fullPath: '/tmp/handoff-project' };

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
      assets: { uploadFiles: () => okJson({ attachments: [] }) },
      taskRecovery: { requestStatus: vi.fn() },
      commands: { list: () => okJson({ success: true, commands: [] }) },
      getFiles: () => okJson([]),
      providers: {
        skills: () => okJson({ data: { skills: [] } }),
        createSession: vi.fn(() => okJson({ data: { sessionId: 'created-1', sessionName: '' } })),
      },
    },
  };
});

function renderComposer(prepare: ((content: string) => Promise<string>) | undefined, session: ProjectSession | null = null) {
  const listeners = new Set<(event: ServerEvent) => void>();
  const subscribe = (listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const sendMessage = vi.fn<(message: unknown) => boolean>(() => true);
  const addMessage = vi.fn<(message: ChatMessage) => void>();
  const onSessionEstablished = vi.fn();
  const view = renderHook(() => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: session,
    currentSessionId: session?.id ?? null,
    provider: 'codex',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'gpt-5.5',
    currentProviderEffort: 'medium',
    isLoading: false,
    isConnected: true,
    subscribe,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage,
    onSessionEstablished,
    prepareNewSessionContent: prepare,
    scrollToBottom: () => undefined,
    addMessage,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }));
  const type = async (text: string) => { await act(async () => { view.result.current.setInput(text); }); };
  const send = async () => {
    await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });
  };
  const emit = async (event: ServerEvent) => { await act(async () => { listeners.forEach((listener) => listener(event)); }); };
  return { view, sendMessage, addMessage, onSessionEstablished, type, send, emit };
}

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  vi.mocked(api.providers.createSession).mockClear();
  vi.mocked(api.taskRecovery.requestStatus).mockImplementation(async () => new Response(JSON.stringify({ run: null })));
});

afterEach(() => { resetChatDrafts(); });

test('a new conversation’s first prompt goes out rewritten while the row and the session name keep the typed text', async () => {
  const prepare = vi.fn(async (content: string) => `${content}\n\n<handoff>\n摘要\n</handoff>`);
  const composer = renderComposer(prepare);
  await composer.type('再加一个快捷键');
  await composer.send();

  assert.deepEqual(prepare.mock.calls, [['再加一个快捷键']]);
  assert.equal(vi.mocked(api.providers.createSession).mock.calls[0]?.[0].initialMessage, '再加一个快捷键');
  const request = composer.sendMessage.mock.calls.at(-1)?.[0] as { type: string; requestId: string; sessionId: string; content: string };
  assert.equal(request.type, 'chat.send');
  assert.equal(request.sessionId, 'created-1');
  assert.equal(request.content, '再加一个快捷键\n\n<handoff>\n摘要\n</handoff>');

  await composer.emit({ kind: 'run_accepted', sessionId: 'created-1', requestId: request.requestId, runId: 'run-1' });
  const shown = composer.addMessage.mock.calls.map(([message]) => message).find((message) => message.type === 'user');
  assert.equal(shown?.content, '再加一个快捷键');
  assert.equal(composer.onSessionEstablished.mock.calls[0]?.[0], 'created-1');
  assert.equal(composer.onSessionEstablished.mock.calls[0]?.[1].summary, '再加一个快捷键');
});

test('a failed rewrite stops the send, says why and keeps the draft', async () => {
  const composer = renderComposer(async () => { throw new Error('没能整理交接摘要'); });
  await composer.type('再加一个快捷键');
  await composer.send();
  assert.equal(composer.sendMessage.mock.calls.length, 0);
  assert.equal(vi.mocked(api.providers.createSession).mock.calls.length, 0);
  assert.equal(composer.addMessage.mock.calls[0]?.[0].type, 'error');
  assert.equal(composer.addMessage.mock.calls[0]?.[0].content, '没能整理交接摘要');
  assert.equal(composer.view.result.current.input, '再加一个快捷键');
});

test('an existing conversation sends as typed', async () => {
  const prepare = vi.fn(async (content: string) => `${content}!`);
  const composer = renderComposer(prepare, { id: 'existing-1' });
  await composer.type('继续');
  await composer.send();
  assert.equal(prepare.mock.calls.length, 0);
  const request = composer.sendMessage.mock.calls.at(-1)?.[0] as { content: string } | undefined;
  assert.equal(request?.content, '继续');
});
