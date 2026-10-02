import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';

vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false, setThemeMode: vi.fn() }) }));
vi.mock('@/modules/studio/StudioWidgets', () => ({ StudioWidgets: () => null }));
vi.mock('@/modules/studio/StudioFluidBackground', () => ({ StudioFluidBackground: () => null }));

import type { StudioHomeTile } from '@/shared/types';
import { StudioHomeScreen } from '@/modules/studio/StudioHomeScreen';
import { installPointerEvent, layOutSortablesInARow, moveOnePlaceWithKeyboard } from '@/modules/studio/tests/sortableTestHelpers';

beforeAll(installPointerEvent);
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  // A drag leaves short-lived click guards on document and window that remove themselves on a timer; run those
  // timers, or the guards outlive the test and swallow the next test's clicks.
  if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

const TILES: StudioHomeTile[] = [
  { id: 'project:snr', name: 'SNR 3.0', tone: 'sage', glyph: 'activity', status: '在线' },
  { id: 'project:prof', name: '超级教授', tone: 'clay', glyph: 'graduation' },
  { id: 'deepseek', name: 'DeepSeek', tone: 'slate', glyph: 'sparkles' },
  { id: 'workspace', name: '开发工具', tone: 'graphite', glyph: 'terminal', href: '/workspace' },
];

function renderHome(overrides: Partial<Parameters<typeof StudioHomeScreen>[0]> = {}) {
  const props = { tiles: TILES, loading: false, covered: false, snr: null, onOpen: vi.fn(), onCreate: vi.fn(), onRefresh: vi.fn(), onSignOut: vi.fn(), refreshing: false, ...overrides };
  render(<MemoryRouter><Routes>
    <Route path="/" element={<StudioHomeScreen {...props} />} />
    <Route path="/workspace" element={<div>IDE opened</div>} />
  </Routes></MemoryRouter>);
  return props;
}

// The order the icons are shown in, by tile id.
function shownOrder() {
  return Array.from(screen.getByRole('navigation', { name: '应用' }).querySelectorAll<HTMLElement>('[data-sort-id]')).map(slot => slot.dataset.sortId);
}

// A press held past the long-press delay, as a mouse (the pointer sensor ignores touch, which the touch sensor owns).
function longPress(element: HTMLElement) {
  fireEvent.pointerDown(element, { button: 0, isPrimary: true, pointerType: 'mouse' });
  act(() => { vi.advanceTimersByTime(500); });
  fireEvent.pointerUp(element);
  fireEvent.click(element);
}

test('each project is a large tile that opens its own app; the IDE tile is a route link; + creates a project', () => {
  const props = renderHome();
  const apps = screen.getByRole('navigation', { name: '应用' });
  fireEvent.click(within(apps).getByRole('button', { name: 'SNR 3.0，在线' }));
  expect(props.onOpen).toHaveBeenCalledWith(TILES[0], expect.anything());
  expect(within(apps).getByRole('link', { name: '开发工具' }).getAttribute('href')).toBe('/workspace');
  fireEvent.click(within(apps).getByRole('button', { name: '新建项目' }));
  expect(props.onCreate).toHaveBeenCalledTimes(1);
});

test('labels and hidden tiles are customised in edit mode and remembered on this device', () => {
  renderHome();
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  fireEvent.click(screen.getByRole('switch', { name: '显示名称' }));
  fireEvent.click(screen.getByRole('button', { name: '从主屏幕隐藏 DeepSeek' }));
  expect(screen.queryByRole('button', { name: 'DeepSeek' })).toBeNull();
  // No icon has been dragged yet, so no order is saved and the layout keeps its original shape.
  expect(JSON.parse(localStorage.getItem('studio-home-layout-v1') ?? '{}')).toEqual({ hidden: ['deepseek'], labels: false, large: false });

  fireEvent.click(screen.getByRole('button', { name: '资源库' }));
  const library = screen.getByRole('dialog', { name: 'App 资源库' });
  expect(within(library).getByText('未接入')).toBeTruthy();
  fireEvent.click(within(library).getByRole('button', { name: '添加到主屏幕' }));
  expect(screen.getByRole('button', { name: 'DeepSeek' })).toBeTruthy();
});

test('a long press lifts an icon into edit mode without also opening the app', () => {
  vi.useFakeTimers();
  const props = renderHome();
  longPress(screen.getByRole('button', { name: 'SNR 3.0，在线' }));
  expect(props.onOpen).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '完成' })).toBeTruthy();
});

test('the click that ends a long press on a link tile does not navigate', () => {
  vi.useFakeTimers();
  renderHome();
  const link = screen.getByRole('link', { name: '开发工具' });
  fireEvent.pointerDown(link, { button: 0, isPrimary: true, pointerType: 'mouse' });
  act(() => { vi.advanceTimersByTime(500); });
  fireEvent.pointerUp(link);
  // dnd-kit stops this click from propagating, which alone would still let the browser follow the href.
  const click = createEvent.click(link);
  fireEvent(link, click);
  expect(click.defaultPrevented).toBe(true);
  expect(screen.queryByText('IDE opened')).toBeNull();
  expect(screen.getByRole('button', { name: '完成' })).toBeTruthy();
});

test('a quick tap still opens the app', () => {
  vi.useFakeTimers();
  const props = renderHome();
  const tile = screen.getByRole('button', { name: '超级教授' });
  fireEvent.pointerDown(tile, { button: 0, isPrimary: true, pointerType: 'mouse' });
  act(() => { vi.advanceTimersByTime(150); });
  fireEvent.pointerUp(tile);
  fireEvent.click(tile);
  expect(props.onOpen).toHaveBeenCalledWith(TILES[1], expect.anything());
  expect(screen.queryByRole('button', { name: '完成' })).toBeNull();
});

test('outside edit mode Enter stays with the tile (it opens the app); in edit mode it picks the icon up', () => {
  renderHome();
  const tile = screen.getByRole('button', { name: '超级教授' });
  const idleEnter = createEvent.keyDown(tile, { code: 'Enter', key: 'Enter' });
  fireEvent(tile, idleEnter);
  expect(idleEnter.defaultPrevented).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  const editEnter = createEvent.keyDown(tile, { code: 'Enter', key: 'Enter' });
  fireEvent(tile, editEnter);
  expect(editEnter.defaultPrevented).toBe(true);
  fireEvent.keyDown(tile, { code: 'Escape', key: 'Escape' });
});

test('in edit mode a tap on an icon opens nothing, and a tap on empty space leaves edit mode', () => {
  const props = renderHome();
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  fireEvent.click(screen.getByRole('button', { name: '超级教授' }));
  expect(props.onOpen).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '完成' })).toBeTruthy();
  fireEvent.click(screen.getByRole('navigation', { name: '应用' }));
  expect(screen.queryByRole('button', { name: '完成' })).toBeNull();
});

test('icons dragged to a new place keep that order on this device', async () => {
  const rects = layOutSortablesInARow();
  renderHome();
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  await moveOnePlaceWithKeyboard(screen.getByRole('button', { name: 'SNR 3.0，在线' }), 'ArrowRight');
  expect(shownOrder()).toEqual(['project:prof', 'project:snr', 'deepseek', 'workspace']);
  expect(JSON.parse(localStorage.getItem('studio-home-layout-v1') ?? '{}').order).toEqual(['project:prof', 'project:snr', 'deepseek', 'workspace']);
  rects.mockRestore();
});

test('a saved order is applied, and tiles it does not know yet follow in their natural order', () => {
  localStorage.setItem('studio-home-layout-v1', JSON.stringify({ hidden: [], labels: true, large: false, order: ['deepseek', 'project:snr'] }));
  renderHome();
  expect(shownOrder()).toEqual(['deepseek', 'project:snr', 'project:prof', 'workspace']);
});

test('a damaged saved layout falls back to the default home screen', () => {
  localStorage.setItem('studio-home-layout-v1', '{not json');
  renderHome();
  expect(screen.getByRole('button', { name: 'DeepSeek' })).toBeTruthy();
});
