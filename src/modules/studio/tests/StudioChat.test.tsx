import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { StudioChat } from '@/modules/studio/StudioChat';
import { api } from '@/shared/api';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { StudioConversation } from '@/shared/types';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

afterEach(cleanup);

test('SNR context defaults to off and is only included after explicit selection', async () => {
  const send = vi.fn().mockResolvedValue(true);
  render(<StudioChat active={null} models={['deepseek-flash', 'deepseek-v4-pro']} sending={false} onSend={send} onStop={vi.fn()} />);
  expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(false);
  fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: '第一个问题' } });
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith('第一个问题', 'deepseek-flash', false));
  fireEvent.click(screen.getByRole('switch'));
  fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: '第二个问题' } });
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith('第二个问题', 'deepseek-flash', true));
});

test('pending replies can be stopped and cannot accidentally switch model', () => {
  const stop = vi.fn();
  render(<StudioChat active={null} models={['deepseek-flash']} sending={true} onSend={vi.fn()} onStop={stop} />);
  expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '停止回复' }));
  expect(stop).toHaveBeenCalledTimes(1);
});

test('failed submissions restore the draft', async () => {
  render(<StudioChat active={null} models={['deepseek-flash']} sending={false} onSend={vi.fn().mockResolvedValue(false)} onStop={vi.fn()} />);
  fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: '保留这条消息' } });
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('保留这条消息'));
});

test('a hardware Enter sends, but Shift+Enter and IME confirmation do not', async () => {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: query === '(pointer: fine)' })) as unknown as typeof window.matchMedia;
  try {
    const send = vi.fn().mockResolvedValue(true);
    render(<StudioChat active={null} models={['deepseek-flash']} sending={false} onSend={send} onStop={vi.fn()} />);
    const field = screen.getByRole('textbox', { name: '消息' });
    fireEvent.change(field, { target: { value: '换行' } });
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    fireEvent.compositionStart(field);
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.compositionEnd(field);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    await new Promise(resolve => setTimeout(resolve, 40));
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledWith('换行', 'deepseek-flash', false));
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    window.matchMedia = original;
  }
});

test('after a reply, the suggested next message shows faintly and one tap on Send sends it; typing hides it, clearing restores it', async () => {
  const request = vi.spyOn(api.studio, 'suggestions').mockImplementation(async () => Response.json({ suggestion: '再举一个例子', source: 'deepseek' }));
  const send = vi.fn().mockResolvedValue(true);
  const active = {
    id: 'conversation-1', title: '问答', model: 'deepseek-flash',
    messages: [
      { id: 1, role: 'user', content: '解释一下闭包', status: 'complete' },
      { id: 2, role: 'assistant', content: '闭包是函数和它捕获的变量……', status: 'complete' },
    ],
  } as unknown as StudioConversation;
  render(<UiPreferencesProvider>
    <StudioChat active={active} models={['deepseek-flash']} sending={false} onSend={send} onStop={vi.fn()} />
  </UiPreferencesProvider>);
  await waitFor(() => expect(screen.getByText('再举一个例子')).toBeTruthy(), { timeout: 3000 });
  expect(request.mock.calls[0][0]).toEqual({
    assistant: 'deepseek',
    turns: [{ role: 'user', text: '解释一下闭包' }, { role: 'assistant', text: '闭包是函数和它捕获的变量……' }],
  });

  const field = screen.getByRole('textbox', { name: '消息' });
  fireEvent.change(field, { target: { value: '换个问题' } });
  expect(screen.queryByText('再举一个例子')).toBeNull();
  fireEvent.change(field, { target: { value: '' } });
  expect(screen.getByText('再举一个例子')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: '发送建议的消息' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith('再举一个例子', 'deepseek-flash', false));
  expect(send).toHaveBeenCalledTimes(1);
});
