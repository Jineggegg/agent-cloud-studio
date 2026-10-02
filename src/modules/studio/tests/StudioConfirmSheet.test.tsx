import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { StudioConfirmSheet } from '@/modules/studio/StudioConfirmSheet';

afterEach(cleanup);

test('the alert focuses cancel first and only confirms on the destructive action', async () => {
  const confirm = vi.fn();
  const cancel = vi.fn();
  render(<StudioConfirmSheet title="删除此对话？" message="无法撤销" confirmLabel="删除" onConfirm={confirm} onCancel={cancel} />);
  const dialog = screen.getByRole('alertdialog', { name: '删除此对话？' });
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }));
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  expect(cancel).not.toHaveBeenCalled();
});

test('Escape cancels and Tab stays inside the alert', async () => {
  const cancel = vi.fn();
  render(<StudioConfirmSheet title="移除密钥？" confirmLabel="移除" onConfirm={vi.fn()} onCancel={cancel} />);
  const cancelButton = screen.getByRole('button', { name: '取消' });
  fireEvent.keyDown(cancelButton, { key: 'Tab' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '移除' }));
  fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
  await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
});
