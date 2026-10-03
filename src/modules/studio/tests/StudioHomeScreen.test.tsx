import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';

vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false, setThemeMode: vi.fn() }) }));
vi.mock('@/modules/studio/StudioWidgets', () => ({ StudioWidgets: () => null }));
vi.mock('@/modules/studio/StudioFluidBackground', () => ({ StudioFluidBackground: () => null }));
// Names typed under icons sync through the user's preferences; the server write is a stub.
vi.mock('@/shared/api', () => ({ api: { user: { savePreferences: vi.fn(async () => Response.json({})), preferences: vi.fn() } } }));
// Reduced motion as motion reads it, switched per test.
const motionPreference = vi.hoisted(() => ({ reduced: false }));
vi.mock('motion/react', async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), useReducedMotion: () => motionPreference.reduced }));

import type { StudioHomeTile } from '@/shared/types';
import { StudioHomeScreen } from '@/modules/studio/StudioHomeScreen';
import { readUserPreference, resetUserPreferences } from '@/shared/userSettings';
import { installPointerEvent, layOutSortablesInARow, moveOnePlaceWithKeyboard } from '@/modules/studio/tests/sortableTestHelpers';

beforeAll(installPointerEvent);
beforeEach(() => { localStorage.clear(); resetUserPreferences(); motionPreference.reduced = false; });
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
  { id: 'workspace', name: '工作台', tone: 'graphite', glyph: 'terminal', href: '/work' },
];

function renderHome(overrides: Partial<Parameters<typeof StudioHomeScreen>[0]> = {}) {
  const props = { tiles: TILES, loading: false, covered: false, snr: null, onOpen: vi.fn(), onOpenWidget: vi.fn(), onOpenSettings: vi.fn(), onCreate: vi.fn(), onRefresh: vi.fn(), onSignOut: vi.fn(), refreshing: false, ...overrides };
  render(<MemoryRouter><Routes>
    <Route path="/" element={<StudioHomeScreen {...props} />} />
    <Route path="/work" element={<div>Workbench opened</div>} />
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
  expect(within(apps).getByRole('link', { name: '工作台' }).getAttribute('href')).toBe('/work');
  fireEvent.click(within(apps).getByRole('button', { name: '新建项目' }));
  expect(props.onCreate).toHaveBeenCalledTimes(1);
});

test('a small gear at the end of the toolbar opens Studio settings; edit mode has no gear', () => {
  const props = renderHome();
  const gear = screen.getByRole('button', { name: '设置' });
  expect(gear.parentElement?.lastElementChild).toBe(gear);
  fireEvent.click(gear);
  expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
  // The settings app zooms out of the button.
  expect(typeof (vi.mocked(props.onOpenSettings).mock.calls[0][0] as DOMRect).width).toBe('number');
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  expect(screen.queryByRole('button', { name: '设置' })).toBeNull();
});

test('labels and hidden tiles are customised in edit mode and remembered on this device', () => {
  renderHome();
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  fireEvent.click(screen.getByRole('switch', { name: '显示名称' }));
  fireEvent.click(screen.getByRole('button', { name: '从主屏幕隐藏 DeepSeek' }));
  expect(screen.queryByRole('button', { name: 'DeepSeek' })).toBeNull();
  // No icon has been dragged yet, so no order is saved and the layout keeps its original shape.
  expect(JSON.parse(localStorage.getItem('studio-home-layout-v1') ?? '{}')).toEqual({ hidden: ['deepseek'], labels: false, large: false, folders: [] });

  fireEvent.click(screen.getByRole('button', { name: '资源库' }));
  const library = screen.getByRole('dialog', { name: 'App 资源库' });
  expect(within(library).queryByText(/Outlook|未接入|规划中/)).toBeNull(); // Outlook mail is built; nothing is planned.
  fireEvent.click(within(library).getByRole('button', { name: '添加到主屏幕' }));
  expect(screen.getByRole('button', { name: 'DeepSeek' })).toBeTruthy();
  // 完成 lets the sheet go the way it came (out of reach meanwhile) before it unmounts.
  vi.useFakeTimers();
  fireEvent.click(within(library).getByRole('button', { name: '完成' }));
  expect(library.closest('.studio-layer')?.classList.contains('closing')).toBe(true);
  act(() => { vi.advanceTimersByTime(350); });
  expect(screen.queryByRole('dialog', { name: 'App 资源库' })).toBeNull();
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
  const link = screen.getByRole('link', { name: '工作台' });
  fireEvent.pointerDown(link, { button: 0, isPrimary: true, pointerType: 'mouse' });
  act(() => { vi.advanceTimersByTime(500); });
  fireEvent.pointerUp(link);
  // dnd-kit stops this click from propagating, which alone would still let the browser follow the href.
  const click = createEvent.click(link);
  fireEvent(link, click);
  expect(click.defaultPrevented).toBe(true);
  expect(screen.queryByText('Workbench opened')).toBeNull();
  expect(screen.getByRole('button', { name: '完成' })).toBeTruthy();
});

test('the next press after a drag is a new gesture, so its click is never swallowed by the drag\'s click guard', () => {
  vi.useFakeTimers();
  renderHome();
  const tile = screen.getByRole('button', { name: 'SNR 3.0，在线' });
  // A long press that ends with no click, as a touch drag does (the browser synthesises none after it).
  fireEvent.pointerDown(tile, { button: 0, isPrimary: true, pointerType: 'mouse' });
  act(() => { vi.advanceTimersByTime(500); });
  fireEvent.pointerUp(tile);
  // Well inside the guard's 400 ms window, the user taps 完成.
  act(() => { vi.advanceTimersByTime(100); });
  const done = screen.getByRole('button', { name: '完成' });
  fireEvent.pointerDown(done, { button: 0, isPrimary: true, pointerType: 'mouse' });
  fireEvent.pointerUp(done);
  const click = createEvent.click(done);
  fireEvent(done, click);
  expect(click.defaultPrevented).toBe(false);
  expect(screen.queryByRole('button', { name: '完成' })).toBeNull();
});

test('an Apple Pencil press is left to the touch sensor (the pointer path is cancelled by Safari as soon as the pen moves)', () => {
  vi.useFakeTimers();
  renderHome();
  const tile = screen.getByRole('button', { name: '超级教授' });
  fireEvent.pointerDown(tile, { button: 0, isPrimary: true, pointerType: 'pen' });
  act(() => { vi.advanceTimersByTime(800); });
  fireEvent.pointerUp(tile);
  expect(screen.queryByRole('button', { name: '完成' })).toBeNull();
  // The same pen's touch events lift the icon once held for the long press.
  fireEvent.touchStart(tile, { touches: [{ clientX: 40, clientY: 40 }] });
  act(() => { vi.advanceTimersByTime(500); });
  expect(screen.getByRole('button', { name: '完成' })).toBeTruthy();
  fireEvent.touchEnd(tile, { touches: [], changedTouches: [{ clientX: 40, clientY: 40 }] });
});

test('in edit mode 前移/后移 move an icon for VoiceOver and Switch Control users; the order is remembered', () => {
  renderHome();
  expect(screen.queryByRole('button', { name: /前移|后移/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  // At either end the button stays focusable but says it has nowhere to go.
  expect(screen.getByRole('button', { name: '前移 SNR 3.0' }).getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByRole('button', { name: '后移 工作台' }).getAttribute('aria-disabled')).toBe('true');

  const later = screen.getByRole('button', { name: '后移 SNR 3.0' });
  later.focus();
  fireEvent.click(later);
  expect(shownOrder()).toEqual(['project:prof', 'project:snr', 'deepseek', 'workspace']);
  expect(JSON.parse(localStorage.getItem('studio-home-layout-v1') ?? '{}').order).toEqual(['project:prof', 'project:snr', 'deepseek', 'workspace']);
  expect(document.activeElement).toBe(later);
  expect(screen.getByText('「SNR 3.0」已移到第 2 个，共 4 个。')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '前移 SNR 3.0' }));
  expect(shownOrder()).toEqual(['project:snr', 'project:prof', 'deepseek', 'workspace']);
  // A move button is not empty space: edit mode stays on.
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

// The tests load none of motion's features (StudioPage loads them lazily), so an icon that rises in stays at the
// entrance's first frame: faded out and 20 px low. An icon without the entrance has no such style.
const rising = (tile: HTMLElement) => tile.style.opacity === '0' && tile.style.transform.includes('translateY(20px)');

function renderFilling(tiles: StudioHomeTile[], loading: boolean) {
  const props = { tiles, loading, covered: false, snr: null, onOpen: vi.fn(), onOpenWidget: vi.fn(), onOpenSettings: vi.fn(), onCreate: vi.fn(), onRefresh: vi.fn(), onSignOut: vi.fn(), refreshing: false };
  const tree = (next: Partial<typeof props>) => <MemoryRouter><StudioHomeScreen {...props} {...next} /></MemoryRouter>;
  const view = render(tree({}));
  return { rerender: (next: Partial<typeof props>) => view.rerender(tree(next)) };
}

test('icons rise in while the home screen first fills, and never again on later renders, new icons or edit mode', () => {
  const builtIn = TILES.slice(2);
  const { rerender } = renderFilling(builtIn, true);
  const deepseek = screen.getByRole('button', { name: 'DeepSeek' });
  expect(rising(deepseek)).toBe(true);
  expect(rising(screen.getByRole('link', { name: '工作台' }))).toBe(true);
  expect(rising(screen.getByRole('button', { name: '新建项目' }))).toBe(true);
  // The projects arrive: still the first fill, so they rise in too.
  rerender({ tiles: TILES, loading: false });
  expect(rising(screen.getByRole('button', { name: 'SNR 3.0，在线' }))).toBe(true);
  // Re-rendering keeps every icon mounted, so nothing starts over.
  expect(screen.getByRole('button', { name: 'DeepSeek' })).toBe(deepseek);
  // A project created later simply appears.
  rerender({ tiles: [...TILES, { id: 'project:new', name: '新项目', tone: 'rose', glyph: 'chart' }], loading: false });
  const created = screen.getByRole('button', { name: '新项目' });
  expect(rising(created)).toBe(false);
  expect(created.style.opacity).toBe('');
  // Edit mode leaves the icons mounted (no replay) and keeps dnd-kit's transform on the slot, not the tile.
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  expect(screen.getByRole('button', { name: 'DeepSeek' })).toBe(deepseek);
  expect(deepseek.closest('[data-sort-id]')).not.toBe(deepseek);
  fireEvent.click(screen.getByRole('button', { name: '从主屏幕隐藏 DeepSeek' }));
  expect(screen.queryByRole('button', { name: 'DeepSeek' })).toBeNull();
});

test('under reduced motion icons appear without the entrance', () => {
  motionPreference.reduced = true;
  renderHome();
  expect(rising(screen.getByRole('button', { name: 'DeepSeek' }))).toBe(false);
  expect(rising(screen.getByRole('button', { name: '新建项目' }))).toBe(false);
});

test('icons are cards with the official mark for built-in products and a line glyph for projects', () => {
  renderHome({ tiles: [...TILES, { id: 'github', name: 'GitHub', tone: 'graphite', glyph: 'pull-request' }] });
  const markOf = (name: string) => screen.getByRole('button', { name }).querySelector('.home-icon svg');
  expect(markOf('GitHub')?.getAttribute('data-brand')).toBe('github');
  expect(markOf('DeepSeek')?.getAttribute('data-brand')).toBe('deepseek');
  expect(markOf('SNR 3.0，在线')?.getAttribute('data-icon')).toBe('activity');
  expect(markOf('超级教授')?.getAttribute('data-icon')).toBe('school');
});

test('in edit mode a tap on a name renames the icon in place; an empty name goes back to the original', () => {
  renderHome();
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  const apps = screen.getByRole('navigation', { name: '应用' });
  fireEvent.click(within(within(apps).getByRole('button', { name: '超级教授' })).getByText('超级教授'));
  const field = screen.getByRole('textbox', { name: '超级教授 的名称' });
  fireEvent.change(field, { target: { value: '  AJ   教授 ' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(screen.queryByRole('textbox', { name: '超级教授 的名称' })).toBeNull();
  expect(within(apps).getByRole('button', { name: 'AJ 教授' })).toBeTruthy();
  // Names follow the account to every device.
  expect(readUserPreference('homeNames', {})).toEqual({ 'project:prof': 'AJ 教授' });

  // VoiceOver reaches the same field through the hidden 重命名 button; Esc keeps the name.
  fireEvent.click(screen.getByRole('button', { name: '重命名 AJ 教授' }));
  fireEvent.change(screen.getByRole('textbox', { name: '超级教授 的名称' }), { target: { value: '别的' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: '超级教授 的名称' }), { key: 'Escape' });
  expect(within(apps).getByRole('button', { name: 'AJ 教授' })).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: '重命名 AJ 教授' }));
  const again = screen.getByRole('textbox', { name: '超级教授 的名称' });
  fireEvent.change(again, { target: { value: '' } });
  fireEvent.blur(again);
  expect(within(apps).getByRole('button', { name: '超级教授' })).toBeTruthy();
  expect(readUserPreference('homeNames', {})).toEqual({});
});

test('a folder shows its apps, opens them, and gives them back to the home screen one by one', () => {
  localStorage.setItem('studio-home-layout-v1', JSON.stringify({
    hidden: [], labels: true, large: false, order: ['project:snr', 'folder:tools', 'project:prof'],
    folders: [{ id: 'tools', name: '工具', items: ['deepseek', 'workspace'] }],
  }));
  const props = renderHome();
  expect(shownOrder()).toEqual(['project:snr', 'folder:tools', 'project:prof']);
  fireEvent.click(screen.getByRole('button', { name: '文件夹「工具」，2 个应用' }));
  const folder = screen.getByRole('dialog', { name: '工具' });
  fireEvent.click(within(folder).getByRole('button', { name: 'DeepSeek' }));
  expect(props.onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'deepseek' }), expect.anything());
  expect(screen.queryByRole('dialog', { name: '工具' })).toBeNull();

  // In edit mode an app leaves the folder through its badge and lands right after it; the last one takes its place.
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  fireEvent.click(screen.getByRole('button', { name: '文件夹「工具」，2 个应用' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '把 DeepSeek 移出文件夹' }));
  expect(shownOrder()).toEqual(['project:snr', 'folder:tools', 'deepseek', 'project:prof']);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '把 工作台 移出文件夹' }));
  expect(shownOrder()).toEqual(['project:snr', 'workspace', 'deepseek', 'project:prof']);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(JSON.parse(localStorage.getItem('studio-home-layout-v1') ?? '{}').folders).toEqual([]);
});

test('a folder shows only its name: no text piles up under it, on the grid or opened in edit mode', () => {
  localStorage.setItem('studio-home-layout-v1', JSON.stringify({
    hidden: [], labels: true, large: false, order: ['folder:tools', 'project:snr', 'project:prof'],
    folders: [{ id: 'tools', name: '工具', items: ['deepseek', 'workspace'] }],
  }));
  renderHome();
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  const icon = screen.getByRole('button', { name: '文件夹「工具」，2 个应用' });
  expect(icon.closest('.home-tile-slot')?.textContent).toBe('工具');
  fireEvent.click(icon);
  const folder = screen.getByRole('dialog');
  // Its name (a field in edit mode) and its apps, nothing else: no hint or caption under the panel.
  expect((within(folder).getByRole('textbox', { name: '文件夹名称' }) as HTMLInputElement).value).toBe('工具');
  expect(Array.from(folder.querySelectorAll('p')).filter(text => !text.classList.contains('studio-visually-hidden'))).toEqual([]);
  expect(folder.querySelector('.home-folder-panel')?.nextElementSibling?.classList.contains('studio-visually-hidden')).toBe(true);
});

test('a folder is renamed in edit mode and dissolves back into its place', () => {
  localStorage.setItem('studio-home-layout-v1', JSON.stringify({
    hidden: [], labels: true, large: false, order: ['folder:tools', 'project:snr', 'project:prof'],
    folders: [{ id: 'tools', name: '工具', items: ['deepseek', 'workspace'] }],
  }));
  renderHome();
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  fireEvent.click(screen.getByRole('button', { name: '文件夹「工具」，2 个应用' }));
  const title = screen.getByRole('textbox', { name: '文件夹名称' });
  fireEvent.change(title, { target: { value: '常用' } });
  fireEvent.keyDown(title, { key: 'Enter' });
  fireEvent.blur(title);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.getByRole('button', { name: '文件夹「常用」，2 个应用' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '解散文件夹「常用」' }));
  expect(shownOrder()).toEqual(['deepseek', 'workspace', 'project:snr', 'project:prof']);
});

test('apps of a deleted project leave their folder once projects have loaded', () => {
  localStorage.setItem('studio-home-layout-v1', JSON.stringify({
    hidden: [], labels: true, large: false, folders: [{ id: 'old', name: '旧', items: ['project:gone'] }, { id: 'tools', name: '工具', items: ['deepseek', 'project:gone'] }],
  }));
  renderHome();
  expect(JSON.parse(localStorage.getItem('studio-home-layout-v1') ?? '{}').folders).toEqual([{ id: 'tools', name: '工具', items: ['deepseek'] }]);
  expect(screen.getByRole('button', { name: '文件夹「工具」，1 个应用' })).toBeTruthy();
});
