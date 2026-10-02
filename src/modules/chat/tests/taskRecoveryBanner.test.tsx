import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import { ChatRecoveryBanner } from '@/modules/chat/composer/ChatRecoveryBanner';
import type { TaskRecoveryRun } from '@/shared/types';

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

const renderBanner = (overrides: Partial<Parameters<typeof ChatRecoveryBanner>[0]> = {}) => {
  const callbacks = {
    onRefresh: vi.fn(),
    onViewRecords: vi.fn(),
    onPrepare: vi.fn(),
    onResolve: vi.fn(async () => undefined),
  };
  const view = render(<ChatRecoveryBanner runs={[RUN]} {...callbacks} {...overrides} />);
  return { view, ...callbacks };
};

test('preparing a continuation calls only the explicit preparation action', () => {
  const banner = renderBanner();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare continuation' }));

  assert.equal(banner.onPrepare.mock.calls.length, 1);
  assert.deepEqual(banner.onPrepare.mock.calls[0], [RUN]);
  assert.equal(banner.onResolve.mock.calls.length, 0);
  assert.equal(banner.onRefresh.mock.calls.length, 0);
  assert.equal(banner.onViewRecords.mock.calls.length, 0);
  assert.ok(screen.getByText(RUN.content));
});

test('an execution without a conversation explains the limitation and does not offer nonexistent records', () => {
  renderBanner({ runs: [{ ...RUN, sessionId: null }] });

  assert.equal(screen.queryByRole('button', { name: 'View records' }), null);
  assert.ok(screen.getByText(/no recoverable conversation yet/i));
  assert.ok(screen.getByRole('button', { name: 'Prepare continuation' }));
});

test('a failed review action keeps the interrupted record and allows another attempt', async () => {
  const onResolve = vi.fn(async () => { throw new Error('Connection lost'); });
  renderBanner({ onResolve });

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' })); });
  assert.equal(onResolve.mock.calls.length, 1);
  assert.deepEqual(onResolve.mock.calls[0], [RUN.runId]);
  assert.ok(screen.getByRole('alert').textContent?.includes('Could not update this record'));
  assert.ok(screen.getByText(RUN.content));
  assert.equal((screen.getByRole('button', { name: 'Mark reviewed' }) as HTMLButtonElement).disabled, false);
});

test('pending work disables preparation while records remain available for review', () => {
  const banner = renderBanner({ disabled: true });
  const prepare = screen.getByRole('button', { name: 'Prepare continuation' }) as HTMLButtonElement;
  assert.equal(prepare.disabled, true);
  fireEvent.click(prepare);
  assert.equal(banner.onPrepare.mock.calls.length, 0);

  fireEvent.click(screen.getByRole('button', { name: 'View records' }));
  assert.deepEqual(banner.onViewRecords.mock.calls[0], [RUN]);
});

test('a recovery lookup error offers an explicit refresh action', () => {
  const banner = renderBanner({ runs: [], error: true });
  assert.ok(screen.getByRole('status').textContent?.includes('Recovery records could not be loaded'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh records' }));
  assert.equal(banner.onRefresh.mock.calls.length, 1);
});

test('an empty successful lookup adds no recovery banner', () => {
  const banner = renderBanner({ runs: [] });
  assert.equal(banner.view.container.childElementCount, 0);
});
