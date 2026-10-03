import { act, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, expect, test, vi } from 'vitest';

import { api } from '@/shared/api';
import { UiPreferencesProvider, useSetUiPreference } from '@/shared/context/UiPreferencesContext';
import { useSuggestedPrompt } from '@/shared/hooks/useSuggestedPrompt';
import type { PromptSuggestionTurn } from '@/shared/types';
import { resetUserPreferences } from '@/shared/userSettings';

const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(UiPreferencesProvider, null, children);
const answered: PromptSuggestionTurn[] = [
  { role: 'user', text: '加一个深色模式开关' },
  { role: 'tool', text: '编辑 Theme.tsx' },
  { role: 'assistant', text: '加好了。要我跑一下测试吗？' },
];

function answer(suggestion: string | null) {
  return vi.spyOn(api.studio, 'suggestions').mockImplementation(async () => Response.json({ suggestion, source: 'deepseek' }));
}

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
});

test('once the answer is complete, the suggestion for the conversation tail is fetched and shown', async () => {
  const request = answer('好的，跑一下测试');
  const { result } = renderHook(() => useSuggestedPrompt({ conversationKey: 'session-a', assistant: 'claude', turns: answered, ready: true }), { wrapper });
  expect(result.current.suggestion).toBeNull();
  await waitFor(() => expect(result.current.suggestion).toBe('好的，跑一下测试'), { timeout: 3000 });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toEqual({ assistant: 'claude', turns: answered });
});

test('nothing is asked while a reply runs, before the assistant answers, for a new chat or with the preference off', async () => {
  const request = answer('不该出现');
  const running = renderHook(() => useSuggestedPrompt({ conversationKey: 'session-b', assistant: 'claude', turns: answered, ready: false }), { wrapper });
  const unanswered = renderHook(() => useSuggestedPrompt({ conversationKey: 'session-b', assistant: 'claude', turns: answered.slice(0, 1), ready: true }), { wrapper });
  const fresh = renderHook(() => useSuggestedPrompt({ conversationKey: null, assistant: 'deepseek', turns: answered, ready: true }), { wrapper });
  const switchedOff = renderHook(() => {
    const setPreference = useSetUiPreference();
    return { setPreference, prompt: useSuggestedPrompt({ conversationKey: 'session-c', assistant: 'codex', turns: answered, ready: true }) };
  }, { wrapper });
  act(() => switchedOff.result.current.setPreference('suggestNextPrompt', false));
  await new Promise(resolve => setTimeout(resolve, 900));
  expect(request).not.toHaveBeenCalled();
  for (const view of [running, unanswered, fresh]) expect(view.result.current.suggestion).toBeNull();
  expect(switchedOff.result.current.prompt.suggestion).toBeNull();
});

test('a used suggestion stays hidden until the next answer, and a conversation state is asked about only once', async () => {
  const request = answer('提交吧');
  const { result, rerender, unmount } = renderHook(
    ({ turns }) => useSuggestedPrompt({ conversationKey: 'session-d', assistant: 'deepseek', turns, ready: true }),
    { wrapper, initialProps: { turns: answered } },
  );
  await waitFor(() => expect(result.current.suggestion).toBe('提交吧'), { timeout: 3000 });
  act(() => result.current.dismiss());
  expect(result.current.suggestion).toBeNull();

  rerender({ turns: [...answered, { role: 'user', text: '提交吧' }, { role: 'assistant', text: '已提交。' }] });
  await waitFor(() => expect(result.current.suggestion).toBe('提交吧'), { timeout: 3000 });
  expect(request).toHaveBeenCalledTimes(2);
  unmount();

  // Reopening the first state reuses the answer already fetched.
  const reopened = renderHook(() => useSuggestedPrompt({ conversationKey: 'session-d', assistant: 'deepseek', turns: answered, ready: true }), { wrapper });
  await waitFor(() => expect(reopened.result.current.suggestion).toBe('提交吧'));
  expect(request).toHaveBeenCalledTimes(2);
});

test('a failed request shows nothing', async () => {
  const request = vi.spyOn(api.studio, 'suggestions').mockRejectedValue(new Error('offline'));
  const { result } = renderHook(() => useSuggestedPrompt({ conversationKey: 'session-e', assistant: 'claude', turns: answered, ready: true }), { wrapper });
  await waitFor(() => expect(request).toHaveBeenCalled(), { timeout: 3000 });
  expect(result.current.suggestion).toBeNull();
});
