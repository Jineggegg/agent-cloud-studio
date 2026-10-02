import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';

// Most tests place only SNR widgets, which read their data from props; any network call there would be a bug.
const mocks = vi.hoisted(() => ({ quota: vi.fn(), trading212: { status: vi.fn(), overview: vi.fn(), history: vi.fn() } }));
vi.mock('@/shared/api', () => ({
  api: { studio: { quota: mocks.quota, trading212: mocks.trading212 } },
  readApiJson: async (response: Response) => response.json(),
}));

import { StudioWidgets } from '@/modules/studio/StudioWidgets';
import { installPointerEvent, layOutSortablesInARow, layOutSortablesInGrid, moveOnePlaceWithKeyboard } from '@/modules/studio/tests/sortableTestHelpers';

const STORAGE_KEY = 'studio-widgets-v1';
const SNR = { connected: true, phase: '2', manifest: { version: '3.0' } } as unknown as Parameters<typeof StudioWidgets>[0]['snr'];
const MOUSE = { button: 0, isPrimary: true, pointerType: 'mouse' } as const;

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

function card(id: string) {
  const found = cards().find(item => item.dataset.sortId === id);
  if (!found) throw new Error(`no widget ${id}`);
  return found;
}

function shownOrder() {
  return cards().map(item => item.dataset.sortId);
}

function savedOrder() {
  return (JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as { id: string }[]).map(widget => widget.id);
}

// The copy of a dragged widget that dnd-kit's DragOverlay draws under the pointer.
function liftedCopy() {
  return document.querySelector<HTMLElement>('.widget-drag-overlay > .widget');
}

// dnd-kit's DragOverlay keeps a copy of the lifted card for one microtask after a drop (where its drop animation
// would run); this lets that pass.
async function settleOverlay() {
  await act(async () => { await Promise.resolve(); });
}

// The studio stylesheets as text. Vitest blanks CSS imports (even `?raw`) and the frontend program has no Node
// types, so Node's fs is loaded through a specifier TypeScript does not try to resolve. (jsdom's URL cannot
// resolve against a file: URL, hence the plain path arithmetic.)
async function readStylesheet(name: string) {
  const fsModule = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync: (path: string, encoding: 'utf8') => string };
  const testsDir = decodeURIComponent(import.meta.url.replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1')).replace(/\/[^/]*$/, '');
  return readFileSync(`${testsDir}/../${name}`, 'utf8');
}

// Small widgets take one column of the grid, medium and large ones two.
const spanOfWidget = (item: Element) => item.classList.contains('widget-small') ? 1 : 2;

function savedSizes() {
  return (JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as { size: string }[]).map(widget => widget.size);
}

test('a long press on a widget asks the home screen to enter edit mode; a short press does not', () => {
  vi.useFakeTimers();
  const onEnterEdit = renderWidgets(false);
  const [first, second] = cards();

  fireEvent.pointerDown(second, MOUSE);
  act(() => { vi.advanceTimersByTime(200); });
  fireEvent.pointerUp(second);
  expect(onEnterEdit).not.toHaveBeenCalled();

  fireEvent.pointerDown(first, MOUSE);
  act(() => { vi.advanceTimersByTime(500); });
  expect(onEnterEdit).toHaveBeenCalledTimes(1);
  fireEvent.pointerUp(first);
  // Lifting without moving changes nothing.
  expect(savedOrder()).toEqual(['w-a', 'w-b', 'w-c']);
});

test('touch and Apple Pencil pointers are left to the touch sensor, so neither lifts a widget through the pointer path', () => {
  vi.useFakeTimers();
  const onEnterEdit = renderWidgets(false);
  const [first, second] = cards();
  // A pen on the pointer path is cancelled by Safari's panning as soon as it moves; the touch sensor prevents that.
  fireEvent.pointerDown(first, { button: 0, isPrimary: true, pointerType: 'touch' });
  act(() => { vi.advanceTimersByTime(800); });
  fireEvent.pointerDown(second, { button: 0, isPrimary: true, pointerType: 'pen' });
  act(() => { vi.advanceTimersByTime(800); });
  expect(onEnterEdit).not.toHaveBeenCalled();
});

test('outside edit mode widgets are not focusable and show no edit controls', () => {
  renderWidgets(false);
  expect(cards().every(item => !item.hasAttribute('tabindex'))).toBe(true);
  expect(screen.queryByRole('button', { name: /移除/ })).toBeNull();
  expect(screen.queryByRole('slider')).toBeNull();
});

test('a widget dragged to a new place keeps that order on this device', async () => {
  const rects = layOutSortablesInARow();
  renderWidgets(true);
  await moveOnePlaceWithKeyboard(cards()[0], 'ArrowRight');
  expect(shownOrder()).toEqual(['w-b', 'w-a', 'w-c']);
  expect(savedOrder()).toEqual(['w-b', 'w-a', 'w-c']);
  rects.mockRestore();
  expect(mocks.quota).not.toHaveBeenCalled();
});

test('with small and medium widgets in two columns, a small widget dragged onto a medium one lands below it, exactly as previewed', async () => {
  vi.useFakeTimers();
  localStorage.setItem(STORAGE_KEY, JSON.stringify([
    { id: 'w-a', type: 'snr', size: 'medium' },
    { id: 'w-b', type: 'snr', size: 'small' },
    { id: 'w-c', type: 'snr', size: 'small' },
    { id: 'w-d', type: 'snr', size: 'medium' },
  ]));
  // Rows of 100px cells: a a / b c / d d (the default widget set has this shape on a phone).
  const rects = layOutSortablesInGrid(2, spanOfWidget);
  renderWidgets(true);

  fireEvent.pointerDown(card('w-b'), { ...MOUSE, clientX: 50, clientY: 150 });
  fireEvent.pointerMove(document, { clientX: 58, clientY: 156 });
  fireEvent.pointerMove(document, { clientX: 150, clientY: 250 });
  // The grid reorders while the pointer is still down, so the preview is the real layout: b's empty slot already
  // sits on a row of its own below d, and the card itself rides in the overlay.
  expect(shownOrder()).toEqual(['w-a', 'w-c', 'w-d', 'w-b']);
  expect(card('w-b').classList.contains('is-placeholder')).toBe(true);
  expect(liftedCopy()?.getAttribute('aria-hidden')).toBe('true');
  expect(liftedCopy()?.textContent).toContain('SNR 实验室');

  fireEvent.pointerUp(document, { clientX: 150, clientY: 250 });
  await settleOverlay();
  // The drop keeps exactly what was shown (rows: a a / c _ / d d / b _).
  expect(shownOrder()).toEqual(['w-a', 'w-c', 'w-d', 'w-b']);
  expect(savedOrder()).toEqual(['w-a', 'w-c', 'w-d', 'w-b']);
  expect(card('w-b').getBoundingClientRect().top).toBeGreaterThan(card('w-d').getBoundingClientRect().top);
  expect(card('w-b').classList.contains('is-placeholder')).toBe(false);
  expect(liftedCopy()).toBeNull();
  rects.mockRestore();
});

test('Esc during a drag puts every widget back where it was before the drag', async () => {
  vi.useFakeTimers();
  // Rows: a _ / b b / c _.
  const rects = layOutSortablesInGrid(2, spanOfWidget);
  renderWidgets(true);
  fireEvent.pointerDown(card('w-a'), { ...MOUSE, clientX: 50, clientY: 50 });
  fireEvent.pointerMove(document, { clientX: 58, clientY: 56 });
  fireEvent.pointerMove(document, { clientX: 80, clientY: 150 });
  expect(shownOrder()).toEqual(['w-b', 'w-a', 'w-c']);
  fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' });
  await settleOverlay();
  expect(shownOrder()).toEqual(['w-a', 'w-b', 'w-c']);
  expect(savedOrder()).toEqual(['w-a', 'w-b', 'w-c']);
  expect(liftedCopy()).toBeNull();
  rects.mockRestore();
});

test('the widget grid places cards in their saved order, never back-filling gaps (a drop could not predict that)', async () => {
  const stylesheets = [await readStylesheet('studio.css'), await readStylesheet('studio-home.css')];
  const widgetGridRules = stylesheets.flatMap(css => [...css.matchAll(/\.widget-grid[^{,]*\{[^}]*\}/g)].map(match => match[0]));
  expect(widgetGridRules.some(rule => rule.includes('grid-template-columns'))).toBe(true);
  expect(widgetGridRules.filter(rule => /grid-auto-flow\s*:[^;}]*dense/.test(rule))).toEqual([]);
});

test('the lifted copy of a Trading 212 widget reuses the grid\'s reading instead of fetching again', async () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: 'w-t', type: 'trading212', size: 'medium' }, { id: 'w-s', type: 'snr', size: 'small' }]));
  mocks.trading212.status.mockResolvedValue(Response.json([{ env: 'live', configured: false, source: null }]));
  const rects = layOutSortablesInARow();
  renderWidgets(true);
  expect(await screen.findByText('未接入账户')).toBeTruthy();

  const tradingCard = card('w-t');
  tradingCard.focus();
  fireEvent.keyDown(tradingCard, { code: 'Space', key: ' ' });
  expect(liftedCopy()?.textContent).toContain('未接入账户');
  expect(mocks.trading212.status).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' });
  rects.mockRestore();
});

test('edit mode shows a resize corner instead of move and resize buttons', () => {
  renderWidgets(true);
  expect(screen.queryByRole('button', { name: /前移|后移|放大|缩小/ })).toBeNull();
  expect(screen.getAllByRole('slider', { name: '调整 SNR 实验室 大小' }).map(handle => handle.getAttribute('aria-valuetext'))).toEqual(['小', '中', '小']);
});

test('dragging a widget corner snaps it between small, medium and large, without lifting the widget', () => {
  vi.useFakeTimers();
  const onEnterEdit = renderWidgets(true);
  const first = card('w-a');
  // A small widget is one 100px cell; the grid has no gap in jsdom.
  vi.spyOn(first, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) } as DOMRect);
  const handle = screen.getAllByRole('slider', { name: '调整 SNR 实验室 大小' })[0];

  fireEvent.pointerDown(handle, { ...MOUSE, clientX: 100, clientY: 100 });
  // Less than half a cell further changes nothing.
  fireEvent.pointerMove(handle, { clientX: 140, clientY: 120 });
  expect(savedSizes()).toEqual(['small', 'medium', 'small']);
  // Past half a cell to the right: two columns.
  fireEvent.pointerMove(handle, { clientX: 170, clientY: 120 });
  expect(savedSizes()).toEqual(['medium', 'medium', 'small']);
  // And down as well: two rows, the large size.
  fireEvent.pointerMove(handle, { clientX: 190, clientY: 180 });
  expect(savedSizes()).toEqual(['large', 'medium', 'small']);
  expect(first.classList.contains('widget-large')).toBe(true);
  // Back towards the start: small again.
  fireEvent.pointerMove(handle, { clientX: 110, clientY: 110 });
  fireEvent.pointerMove(handle, { clientX: 190, clientY: 110 });
  fireEvent.pointerUp(handle, { clientX: 190, clientY: 110 });
  expect(savedSizes()).toEqual(['medium', 'medium', 'small']);
  // Moving the pointer after the drag ended resizes nothing.
  fireEvent.pointerMove(handle, { clientX: 300, clientY: 300 });
  expect(savedSizes()).toEqual(['medium', 'medium', 'small']);

  act(() => { vi.advanceTimersByTime(800); });
  expect(onEnterEdit).not.toHaveBeenCalled();
  expect(liftedCopy()).toBeNull();
});

test('the resize corner is a slider for the keyboard and stays within the three sizes', () => {
  renderWidgets(true);
  const handle = screen.getAllByRole('slider', { name: '调整 SNR 实验室 大小' })[0];
  handle.focus();
  fireEvent.keyDown(handle, { key: 'ArrowRight', code: 'ArrowRight' });
  expect(savedSizes()[0]).toBe('medium');
  fireEvent.keyDown(handle, { key: 'End', code: 'End' });
  expect(savedSizes()[0]).toBe('large');
  expect(handle.getAttribute('aria-valuetext')).toBe('大');
  fireEvent.keyDown(handle, { key: 'ArrowUp', code: 'ArrowUp' });
  expect(savedSizes()[0]).toBe('large');
  fireEvent.keyDown(handle, { key: 'Home', code: 'Home' });
  expect(savedSizes()[0]).toBe('small');
  // The keys resize; they never pick the widget up.
  expect(liftedCopy()).toBeNull();
  expect(savedOrder()).toEqual(['w-a', 'w-b', 'w-c']);
});

test('a large widget is kept on this device and shows its detail rows', () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: 'w-a', type: 'snr', size: 'large' }, { id: 'w-x', type: 'snr', size: 'huge' }]));
  renderWidgets(false);
  expect(cards().map(item => item.className.includes('widget-large'))).toEqual([true]);
  expect(screen.getByText('数据集')).toBeTruthy();
  expect(screen.getByText('规则')).toBeTruthy();
});

test('edit mode removes widgets, and the layout is remembered', () => {
  renderWidgets(true);
  fireEvent.click(screen.getAllByRole('button', { name: '移除 SNR 实验室' })[1]);
  expect(savedOrder()).toEqual(['w-a', 'w-c']);
});
