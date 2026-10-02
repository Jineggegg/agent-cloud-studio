import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { StudioChat } from '@/modules/studio/StudioChat';

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
