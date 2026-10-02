import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';

// Only SNR widgets are placed, which read their data from props; any network call would be a bug.
const mocks = vi.hoisted(() => ({ quota: vi.fn(), trading212: { status: vi.fn(), overview: vi.fn(), history: vi.fn() } }));
vi.mock('@/shared/api', () => ({
  api: { studio: { quota: mocks.quota, trading212: mocks.trading212 } },
  readApiJson: async (response: Response) => response.json(),
}));

import { StudioWidgets } from '@/modules/studio/StudioWidgets';
import { installPointerEvent, layOutSortablesInARow, moveOnePlaceWithKeyboard } from '@/modules/studio/tests/sortableTestHelpers';

const STORAGE_KEY = 'studio-widgets-v1';
const SNR = { connected: true, phase: '2', manifest: { version: '3.0' } } as unknown as Parameters<typeof StudioWidgets>[0]['snr'];

beforeAll(installPointerEvent);
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, JSON.stringify([
    { id: 'w-a', type: 'snr', size: 'small' },
    { id: 'w-b', type: 'snr', size: 'medium' },
    { id: 'w-c', type: 'snr', size: 'small' },
  ]));
});
afterEach(() => {
  cleanup();
  // Run the drag's self-removing click guards so they cannot outlive the test.
  if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

function renderWidgets(editing: boolean) {
  const onEnterEdit = vi.fn();
  render(<StudioWidgets editing={editing} snr={SNR} onEnterEdit={onEnterEdit} galleryOpen={false} onGalleryClose={vi.fn()} />);
  return onEnterEdit;
}

function cards() {
  return Array.from(screen.getByRole('region', { name: '小组件' }).querySelectorAll<HTMLElement>('[data-sort-id]'));
}

function savedOrder() {
  return (JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as { id: string }[]).map(widget => widget.id);
}

test('a long press on a widget asks the home screen to enter edit mode; a short press does not', () => {
  vi.useFakeTimers();
  const onEnterEdit = renderWidgets(false);
  const [first, second] = cards();

  fireEvent.pointerDown(second, { button: 0, isPrimary: true, pointerType: 'mouse' });
  act(() => { vi.advanceTimersByTime(200); });
  fireEvent.pointerUp(second);
  expect(onEnterEdit).not.toHaveBeenCalled();

  fireEvent.pointerDown(first, { button: 0, isPrimary: true, pointerType: 'mouse' });
  act(() => { vi.advanceTimersByTime(500); });
  expect(onEnterEdit).toHaveBeenCalledTimes(1);
  fireEvent.pointerUp(first);
  // Lifting without moving changes nothing.
  expect(savedOrder()).toEqual(['w-a', 'w-b', 'w-c']);
});

test('touch pointers are left to the touch sensor, so a finger resting on a widget never lifts it through the pointer path', () => {
  vi.useFakeTimers();
  const onEnterEdit = renderWidgets(false);
  const [first] = cards();
  fireEvent.pointerDown(first, { button: 0, isPrimary: true, pointerType: 'touch' });
  act(() => { vi.advanceTimersByTime(800); });
  expect(onEnterEdit).not.toHaveBeenCalled();
});

test('outside edit mode widgets are not focusable and show no edit controls', () => {
  renderWidgets(false);
  expect(cards().every(card => !card.hasAttribute('tabindex'))).toBe(true);
  expect(screen.queryByRole('button', { name: /移除/ })).toBeNull();
});

test('a widget dragged to a new place keeps that order on this device', async () => {
  const rects = layOutSortablesInARow();
  renderWidgets(true);
  await moveOnePlaceWithKeyboard(cards()[0], 'ArrowRight');
  expect(cards().map(card => card.dataset.sortId)).toEqual(['w-b', 'w-a', 'w-c']);
  expect(savedOrder()).toEqual(['w-b', 'w-a', 'w-c']);
  rects.mockRestore();
  expect(mocks.quota).not.toHaveBeenCalled();
});

test('edit mode resizes and removes widgets, and the layout is remembered', () => {
  renderWidgets(true);
  fireEvent.click(screen.getAllByRole('button', { name: '放大 SNR 实验室' })[0]);
  expect((JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as { size: string }[]).map(widget => widget.size)).toEqual(['medium', 'medium', 'small']);
  fireEvent.click(screen.getAllByRole('button', { name: '移除 SNR 实验室' })[1]);
  expect(savedOrder()).toEqual(['w-a', 'w-c']);
});
