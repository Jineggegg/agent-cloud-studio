import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { ScheduleMessagePopover } from '@/modules/chat/composer/ScheduleMessagePopover';
import { ScheduledMessageList } from '@/modules/chat/composer/ScheduledMessageList';
import { useScheduledMessages } from '@/modules/chat/composer/useScheduledMessages';
import { api } from '@/shared/api';
import type { ScheduledMessage } from '@/shared/types';

const MESSAGE: ScheduledMessage = {
  id: 'scheduled-one',
  sessionId: 'session-one',
  content: 'Run the scheduled review',
  options: {},
  scheduledFor: '2026-10-02T10:00:00Z',
  status: 'pending',
  failureReason: null,
  createdAt: '2026-10-02T09:00:00Z',
};

vi.mock('@/shared/api', () => ({
  api: { scheduledMessages: { list: vi.fn(), create: vi.fn(), cancel: vi.fn() } },
}));

const response = (data: ScheduledMessage[]) => new Response(JSON.stringify({ data }));

beforeEach(() => {
  vi.mocked(api.scheduledMessages.list).mockReset();
  vi.mocked(api.scheduledMessages.list).mockImplementation(async () => response([]));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test.each(['quick option', 'custom confirmation'])(
  'an already-open schedule menu rejects %s after scheduling becomes disabled',
  (selection) => {
    const onSchedule = vi.fn();
    const view = render(<ScheduleMessagePopover disabled={false} onSchedule={onSchedule} />);
    fireEvent.click(screen.getByRole('button', { name: 'Schedule this message' }));
    assert.ok(screen.getByRole('menu', { name: 'Schedule this message' }));

    view.rerender(<ScheduleMessagePopover disabled onSchedule={onSchedule} />);

    if (selection === 'quick option') {
      fireEvent.click(screen.getByRole('menuitemradio', { name: /In 15 minutes/ }));
    } else {
      fireEvent.change(screen.getByLabelText('Or pick a time'), {
        target: { value: '2099-10-03T10:30' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^Schedule$/ }));
    }

    assert.equal(onSchedule.mock.calls.length, 0);
  },
);

test('a claimed schedule remains visible as execution in progress without an invalid cancel action', () => {
  const onCancel = vi.fn();
  render(<ScheduledMessageList scheduledMessages={[{ ...MESSAGE, status: 'claimed' }]} onCancel={onCancel} />);

  assert.ok(screen.getByText('Accepted · execution in progress'));
  assert.ok(screen.getByText(MESSAGE.content));
  assert.equal(screen.queryByRole('button'), null);
  assert.equal(onCancel.mock.calls.length, 0);
});

test('pending schedules can be cancelled and failed notices can be dismissed', () => {
  const onCancel = vi.fn();
  render(<ScheduledMessageList scheduledMessages={[
    MESSAGE,
    { ...MESSAGE, id: 'failed-one', content: 'Failed review', status: 'failed', failureReason: 'Server restarted' },
  ]} onCancel={onCancel} />);

  fireEvent.click(screen.getByRole('button', { name: 'Cancel scheduled message' }));
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss failure notice' }));
  assert.deepEqual(onCancel.mock.calls, [[MESSAGE.id], ['failed-one']]);
  assert.ok(screen.getByText(/Server restarted/));
});

test('completed and cancelled schedules leave the composer unobstructed', () => {
  const view = render(<ScheduledMessageList scheduledMessages={[
    { ...MESSAGE, status: 'sent' },
    { ...MESSAGE, id: 'cancelled-one', status: 'cancelled' },
  ]} onCancel={() => undefined} />);
  assert.equal(view.container.childElementCount, 0);
});

test('visible pending and claimed schedules refresh every five seconds until execution finishes', async () => {
  vi.useFakeTimers();
  vi.mocked(api.scheduledMessages.list)
    .mockResolvedValueOnce(response([MESSAGE]))
    .mockResolvedValueOnce(response([{ ...MESSAGE, status: 'claimed' }]))
    .mockResolvedValueOnce(response([{ ...MESSAGE, status: 'sent' }]));
  const { result } = renderHook(() => useScheduledMessages(MESSAGE.sessionId));
  await act(async () => undefined);
  assert.equal(result.current.scheduledMessages[0]?.status, 'pending');

  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  assert.equal(result.current.scheduledMessages[0]?.status, 'claimed');
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  assert.equal(result.current.scheduledMessages[0]?.status, 'sent');
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  assert.equal(vi.mocked(api.scheduledMessages.list).mock.calls.length, 3);
});

test('hidden pages do not poll unfinished schedules and returning to the page refreshes immediately', async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, 'visibilityState', 'get');
  vi.mocked(api.scheduledMessages.list).mockImplementation(async () => response([{ ...MESSAGE, status: 'claimed' }]));
  renderHook(() => useScheduledMessages(MESSAGE.sessionId));
  await act(async () => undefined);
  visibility.mockReturnValue('hidden');

  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  assert.equal(vi.mocked(api.scheduledMessages.list).mock.calls.length, 1);
  visibility.mockReturnValue('visible');
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(vi.mocked(api.scheduledMessages.list).mock.calls.length, 2);
});

test('focus refreshes the current session even when its previous lookup had no pending work', async () => {
  const { result, unmount } = renderHook(() => useScheduledMessages(MESSAGE.sessionId));
  await act(async () => undefined);
  vi.mocked(api.scheduledMessages.list).mockResolvedValueOnce(response([{ ...MESSAGE, status: 'claimed' }]));

  await act(async () => { window.dispatchEvent(new Event('focus')); });
  assert.equal(result.current.scheduledMessages[0]?.status, 'claimed');
  assert.equal(vi.mocked(api.scheduledMessages.list).mock.calls.length, 2);
  unmount();
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  assert.equal(vi.mocked(api.scheduledMessages.list).mock.calls.length, 2);
});
