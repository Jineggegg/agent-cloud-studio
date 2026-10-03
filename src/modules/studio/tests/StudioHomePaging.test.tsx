import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';

vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false, setThemeMode: vi.fn() }) }));
// The widgets' own exit is tested in StudioWidgets.test.tsx; here only what the home screen tells them is kept.
const widgetProps = vi.hoisted(() => ({ last: null as { editing: boolean; leavingEdit?: boolean } | null }));
vi.mock('@/modules/studio/StudioWidgets', () => ({
  StudioWidgets: (props: { editing: boolean; leavingEdit?: boolean }) => { widgetProps.last = props; return null; },
}));
vi.mock('@/modules/studio/StudioFluidBackground', () => ({ StudioFluidBackground: () => null }));

import type { StudioHomeTile } from '@/shared/types';
import { StudioHomeScreen } from '@/modules/studio/StudioHomeScreen';
import { rubberBand } from '@/modules/studio/utils/homePaging';
import { installPointerEvent } from '@/modules/studio/tests/sortableTestHelpers';

// The pager is 1000 px wide and 230 px tall; icons are 250 × 100 cells, so a page holds 4 columns × 2 rows.
const PAGE_WIDTH = 1000;
const PAGE_HEIGHT = 230;
const CELL = { width: 250, height: 100 };
// The pager's current height: a test shrinks it the way Spotlight or a keyboard briefly shrinks the web app.
let pagerHeight = PAGE_HEIGHT;
// The pager's current width: a test turns the iPad to portrait and back.
let pagerWidth = PAGE_WIDTH;

beforeAll(installPointerEvent);
beforeEach(() => {
  localStorage.clear();
  pagerHeight = PAGE_HEIGHT;
  pagerWidth = PAGE_WIDTH;
  vi.useFakeTimers();
  layOutPages();
});
afterEach(() => {
  act(() => { vi.runOnlyPendingTimers(); });
  vi.useRealTimers();
});

const tilesOf = (count: number): StudioHomeTile[] => Array.from({ length: count }, (_, index) => ({ id: `project:p${index + 1}`, name: `App ${index + 1}`, tone: 'sage', glyph: 'folder' }));

function box(left: number, top: number, width: number, height: number) {
  return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) } as DOMRect;
}

// Where the track has slid to, in px (0 on the first page).
function trackOffset() {
  const transform = document.querySelector<HTMLElement>('.home-pager-track')?.style.transform ?? '';
  return Number(/translate3d\((-?[\d.e-]+)px/.exec(transform)?.[1] ?? 0);
}

/**
 * jsdom lays nothing out. This gives the pager, the grids and the icon cells the sizes the home screen measures to
 * split icons into pages, and places each icon by its page, cell and the track's current offset (dnd-kit reads
 * these during a drag). The drag overlay is a fixed box placed with inline styles; what is inside it fills it.
 */
function layOutPages() {
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
    return this.classList.contains('home-pager') || this.classList.contains('home-grid') ? pagerWidth : 0;
  });
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    return this.classList.contains('home-pager') ? pagerHeight : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('home-tile-slot') ? CELL.width : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('home-tile-slot') ? CELL.height : 0;
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('home-pager')) return box(0, 100, PAGE_WIDTH, pagerHeight);
    const page = this.closest<HTMLElement>('[data-home-page]');
    if (this instanceof HTMLElement && this.dataset.sortId && page) {
      const cell = Array.from(page.querySelectorAll('[data-sort-id]')).indexOf(this);
      return box(Number(page.dataset.homePage) * PAGE_WIDTH + (cell % 4) * CELL.width + trackOffset(), 100 + Math.floor(cell / 4) * CELL.height, CELL.width, CELL.height);
    }
    // The lifted copy fills the overlay, which is what dnd-kit measures it by.
    const overlay = this.closest<HTMLElement>('[style*="position: fixed"]');
    if (overlay) {
      const px = (value: string) => Number.parseFloat(value) || 0;
      return box(px(overlay.style.left), px(overlay.style.top), px(overlay.style.width), px(overlay.style.height));
    }
    return box(0, 0, 0, 0);
  });
}

function renderHome(count: number, overrides: Partial<Parameters<typeof StudioHomeScreen>[0]> = {}) {
  const props = { tiles: tilesOf(count), loading: false, covered: false, snr: null, onOpen: vi.fn(), onOpenWidget: vi.fn(), onOpenSettings: vi.fn(), onCreate: vi.fn(), onRefresh: vi.fn(), onSignOut: vi.fn(), refreshing: false, ...overrides };
  render(<MemoryRouter><StudioHomeScreen {...props} /></MemoryRouter>);
  return props;
}

const pager = () => document.querySelector<HTMLElement>('.home-pager')!;
const dots = () => within(screen.getByRole('group', { name: '主屏幕页面' }));
const currentPage = () => dots().getAllByRole('button').findIndex(dot => dot.getAttribute('aria-current') === 'true') + 1;
const settle = () => act(() => { vi.advanceTimersByTime(1500); });

// A finger (or mouse) moving from one point to another in steps 16 ms apart, then lifting.
function swipe(target: Element, from: { x: number; y: number }, to: { x: number; y: number }, { steps = 6, pointerType = 'touch', lift = true } = {}) {
  const at = (step: number) => ({ clientX: from.x + (to.x - from.x) * step / steps, clientY: from.y + (to.y - from.y) * step / steps });
  fireEvent.pointerDown(target, { pointerId: 3, pointerType, button: 0, isPrimary: true, ...at(0) });
  for (let step = 1; step <= steps; step += 1) {
    act(() => { vi.advanceTimersByTime(16); });
    fireEvent.pointerMove(target, { pointerId: 3, pointerType, ...at(step) });
  }
  if (lift) fireEvent.pointerUp(target, { pointerId: 3, pointerType, ...at(steps) });
}

test('icons that do not fit on the first page flow onto the next, with + at the end of the last page', () => {
  renderHome(12);
  const first = screen.getByRole('navigation', { name: '应用' });
  const second = screen.getByRole('navigation', { name: '应用（第 2 页）' });
  expect(within(first).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['App 1', 'App 2', 'App 3', 'App 4', 'App 5', 'App 6', 'App 7', 'App 8']);
  expect(within(second).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['App 9', 'App 10', 'App 11', 'App 12', '新建项目']);
  expect(dots().getAllByRole('button').map(dot => dot.getAttribute('aria-label'))).toEqual(['第 1 页', '第 2 页']);
  expect(currentPage()).toBe(1);
});

test('a screen shortened only for a moment (a search, a keyboard) moves no icon; a lasting change glides them to new pages', () => {
  renderHome(12);
  const first = () => within(screen.getByRole('navigation', { name: '应用' })).getAllByRole('button', { name: /^App / }).map(button => button.getAttribute('aria-label'));
  const app8 = screen.getByRole('button', { name: 'App 8' });
  // Room for one row only while it lasts; iOS reports it with a resize when the web app comes back.
  pagerHeight = 170;
  act(() => { window.dispatchEvent(new Event('pageshow')); });
  act(() => { vi.advanceTimersByTime(450); });
  expect(first()).toHaveLength(8);
  pagerHeight = PAGE_HEIGHT;
  act(() => { window.dispatchEvent(new Event('pageshow')); });
  act(() => { vi.advanceTimersByTime(1500); });
  // Nothing moved, and the icons are the very same nodes: nothing remounted, so nothing flashes.
  expect(first()).toHaveLength(8);
  expect(screen.getByRole('button', { name: 'App 8' })).toBe(app8);

  pagerHeight = 170;
  act(() => { window.dispatchEvent(new Event('pageshow')); });
  act(() => { vi.advanceTimersByTime(450); });
  act(() => { vi.advanceTimersByTime(1000); });
  expect(first()).toEqual(['App 1', 'App 2', 'App 3', 'App 4']);
});

// Turns the iPad: the window resizes, then iOS reports the new orientation (the order iOS uses varies; both arrive).
function rotateTo(width: number, height: number) {
  pagerWidth = width;
  pagerHeight = height;
  act(() => { window.dispatchEvent(new Event('resize')); });
  act(() => { window.dispatchEvent(new Event('orientationchange')); });
}
const appsOnPage = (index: number) => within(screen.getByRole('navigation', { name: index === 0 ? '应用' : `应用（第 ${index + 1} 页）` }))
  .getAllByRole('button').map(button => button.getAttribute('aria-label')).filter(label => /^App \d+$|^新建项目$/.test(label ?? ''));

test('turned to portrait and back to landscape, the pages fit again at once and the track rests on the same page', () => {
  renderHome(20);
  // Landscape: 4 columns × 2 rows a page.
  expect([0, 1, 2].map(index => appsOnPage(index).length)).toEqual([8, 8, 5]);
  fireEvent.click(dots().getByRole('button', { name: '第 2 页' }));
  settle();
  expect(currentPage()).toBe(2);
  expect(trackOffset()).toBe(-PAGE_WIDTH);

  // Portrait: narrower and taller, 3 columns × 4 rows. The track follows the new width at once.
  rotateTo(750, 450);
  expect(trackOffset()).toBe(-750);
  act(() => { vi.advanceTimersByTime(450); });
  expect([0, 1].map(index => appsOnPage(index).length)).toEqual([12, 9]);
  expect(dots().getAllByRole('button')).toHaveLength(2);
  expect(currentPage()).toBe(2);
  expect(trackOffset()).toBe(-750);
  settle();

  // Back to landscape: fewer icons a page, applied straight away, not held back like a passing shrink. Had it waited,
  // the page in view would carry portrait's 9 icons in room for 8 and scroll up and down instead of paging.
  rotateTo(PAGE_WIDTH, PAGE_HEIGHT);
  act(() => { vi.advanceTimersByTime(50); });
  expect([0, 1, 2].map(index => appsOnPage(index).length)).toEqual([8, 8, 5]);
  expect(currentPage()).toBe(2);
  expect(trackOffset()).toBe(-PAGE_WIDTH);
  // And it stays that way once the rotation has fully settled.
  settle();
  expect([0, 1, 2].map(index => appsOnPage(index).length)).toEqual([8, 8, 5]);
  expect(trackOffset()).toBe(-PAGE_WIDTH);
});

test('an orientation change reported before the layout follows still re-fits the pages once it has', () => {
  renderHome(20);
  fireEvent.click(dots().getByRole('button', { name: '第 2 页' }));
  settle();
  rotateTo(750, 450);
  settle();
  expect([0, 1].map(index => appsOnPage(index).length)).toEqual([12, 9]);

  // iOS: the orientation event first, the new size only later (no resize event for the pages to hear).
  act(() => { window.dispatchEvent(new Event('orientationchange')); });
  pagerWidth = PAGE_WIDTH;
  pagerHeight = PAGE_HEIGHT;
  act(() => { vi.advanceTimersByTime(450); });
  expect([0, 1, 2].map(index => appsOnPage(index).length)).toEqual([8, 8, 5]);
  expect(currentPage()).toBe(2);
  expect(trackOffset()).toBe(-PAGE_WIDTH);
});

test('leaving edit mode winds down: the badges and the edit bar play out before they unmount, the dots go home', () => {
  renderHome(12);
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  expect(document.querySelectorAll('.home-remove').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: '完成' }));
  // Edit mode is over at once (taps open apps again), but its controls are still on their way out.
  expect(document.querySelector('.home-screen')?.classList.contains('editing')).toBe(false);
  expect(document.querySelector('.home-screen')?.classList.contains('edit-leaving')).toBe(true);
  const bar = document.querySelector('.home-edit-bar');
  expect(bar?.classList.contains('is-leaving')).toBe(true);
  expect(bar?.hasAttribute('inert')).toBe(true);
  expect(document.querySelectorAll('.home-remove').length).toBeGreaterThan(0);
  expect(screen.queryByRole('button', { name: /从主屏幕隐藏/ })).toBeNull();
  // The page dots have already left the bar for the foot of the screen.
  expect(bar?.querySelector('.home-page-control')).toBeNull();
  expect(screen.getByRole('group', { name: '主屏幕页面' })).toBeTruthy();
  // The widgets' badges and resize corners wind down with the icons'.
  expect(widgetProps.last).toMatchObject({ editing: false, leavingEdit: true });
  act(() => { vi.advanceTimersByTime(350); });
  expect(widgetProps.last).toMatchObject({ editing: false, leavingEdit: false });
  expect(document.querySelector('.home-edit-bar')).toBeNull();
  expect(document.querySelector('.home-remove')).toBeNull();
  expect(document.querySelector('.home-screen')?.classList.contains('edit-leaving')).toBe(false);

  // Back into edit mode midway, nothing lingers.
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  fireEvent.click(screen.getByRole('button', { name: '完成' }));
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  expect(document.querySelector('.home-edit-bar')?.classList.contains('is-leaving')).toBe(false);
});

test('under reduced motion edit mode ends at once', () => {
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query.includes('reduce'), media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }) as unknown as MediaQueryList);
  renderHome(12);
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  fireEvent.click(screen.getByRole('button', { name: '完成' }));
  expect(document.querySelector('.home-edit-bar')).toBeNull();
  expect(document.querySelector('.home-remove')).toBeNull();
  expect(widgetProps.last).toMatchObject({ editing: false, leavingEdit: false });
});

test('one page shows no page control', () => {
  renderHome(3);
  expect(screen.queryByRole('group', { name: '主屏幕页面' })).toBeNull();
  expect(screen.queryByRole('navigation', { name: '应用（第 2 页）' })).toBeNull();
});

test('a sideways swipe follows the finger and turns exactly one page, even when it is long and fast', () => {
  renderHome(28);
  expect(dots().getAllByRole('button')).toHaveLength(4);
  swipe(screen.getByRole('button', { name: 'App 2' }), { x: 900, y: 150 }, { x: 600, y: 152 }, { lift: false });
  // 1:1 with the finger from where the axis locked (the first 50 px step), so the page never jumps.
  expect(trackOffset()).toBe(-250);
  expect(document.querySelector('.home-page-control')?.classList.contains('is-lit')).toBe(true);
  fireEvent.pointerUp(pager(), { pointerId: 3, pointerType: 'touch', clientX: 600, clientY: 152 });
  settle();
  expect(currentPage()).toBe(2);
  expect(trackOffset()).toBe(-PAGE_WIDTH);

  // A pointer dragged on past the screen's edge (it is captured) carries the pages well beyond the next one,
  // yet the swipe still turns only one page.
  swipe(pager(), { x: 990, y: 150 }, { x: -1100, y: 150 }, { steps: 3 });
  settle();
  expect(currentPage()).toBe(3);
  expect(trackOffset()).toBe(-2 * PAGE_WIDTH);
});

test('a short slow swipe springs back; a short flick turns the page', () => {
  renderHome(12);
  swipe(pager(), { x: 500, y: 150 }, { x: 400, y: 150 }, { steps: 10 });
  act(() => { vi.advanceTimersByTime(100); });
  // 100 px in 160 ms is over the flick threshold: the page turns.
  settle();
  expect(currentPage()).toBe(2);

  // Slow: 120 px, held still before lifting.
  swipe(pager(), { x: 400, y: 150 }, { x: 520, y: 150 }, { steps: 6, lift: false });
  act(() => { vi.advanceTimersByTime(200); });
  fireEvent.pointerUp(pager(), { pointerId: 3, pointerType: 'touch', clientX: 520, clientY: 150 });
  settle();
  expect(currentPage()).toBe(2);
  expect(trackOffset()).toBe(-PAGE_WIDTH);
});

test('past the first and last page the pages rubber-band, then spring back', () => {
  renderHome(12);
  swipe(pager(), { x: 300, y: 150 }, { x: 610, y: 150 }, { steps: 31, lift: false });
  // The axis locks at the first 10 px step; the remaining 300 px are damped like UIScrollView.
  expect(trackOffset()).toBeCloseTo(rubberBand(300, PAGE_WIDTH), 3);
  expect(trackOffset()).toBeLessThan(150);
  fireEvent.pointerUp(pager(), { pointerId: 3, pointerType: 'touch', clientX: 610, clientY: 150 });
  settle();
  expect(trackOffset()).toBe(0);
  expect(currentPage()).toBe(1);

  fireEvent.click(dots().getByRole('button', { name: '第 2 页' }));
  settle();
  swipe(pager(), { x: 700, y: 150 }, { x: 390, y: 150 }, { steps: 31, lift: false });
  expect(trackOffset()).toBeCloseTo(-PAGE_WIDTH - rubberBand(300, PAGE_WIDTH), 3);
  fireEvent.pointerUp(pager(), { pointerId: 3, pointerType: 'touch', clientX: 390, clientY: 150 });
  settle();
  expect(trackOffset()).toBe(-PAGE_WIDTH);
  expect(currentPage()).toBe(2);
});

test('a vertical swipe scrolls the page and never turns it, even if it drifts sideways later', () => {
  renderHome(12);
  swipe(pager(), { x: 500, y: 100 }, { x: 503, y: 160 }, { steps: 3, lift: false });
  fireEvent.pointerMove(pager(), { pointerId: 3, pointerType: 'touch', clientX: 100, clientY: 170 });
  fireEvent.pointerUp(pager(), { pointerId: 3, pointerType: 'touch', clientX: 100, clientY: 170 });
  settle();
  expect(trackOffset()).toBe(0);
  expect(currentPage()).toBe(1);
});

test('a swipe that starts on an icon does not open it; the next tap does', () => {
  const props = renderHome(12);
  const icon = screen.getByRole('button', { name: 'App 3' });
  swipe(icon, { x: 600, y: 150 }, { x: 300, y: 150 });
  fireEvent.click(icon);
  expect(props.onOpen).not.toHaveBeenCalled();
  settle();

  fireEvent.pointerDown(icon, { pointerId: 4, pointerType: 'touch', clientX: 600, clientY: 150 });
  fireEvent.pointerUp(icon, { pointerId: 4, pointerType: 'touch', clientX: 600, clientY: 150 });
  fireEvent.click(icon);
  expect(props.onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: 'App 3' }), expect.anything());
});

test('a mouse swipe in edit mode turns the page and does not end edit mode', () => {
  renderHome(12);
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  // In edit mode the page control rides in the floating bar.
  expect(within(screen.getByRole('group', { name: '主屏幕外观' })).getByRole('group', { name: '主屏幕页面' })).toBeTruthy();
  const page = document.querySelector('.home-page')!;
  swipe(page, { x: 800, y: 300 }, { x: 300, y: 300 }, { pointerType: 'mouse' });
  fireEvent.click(page);
  settle();
  expect(currentPage()).toBe(2);
  expect(screen.getByRole('button', { name: '完成' })).toBeTruthy();
});

test('a touch on a page still moving catches it, and that touch is not a tap', () => {
  const props = renderHome(12);
  fireEvent.click(dots().getByRole('button', { name: '第 2 页' }));
  act(() => { vi.advanceTimersByTime(80); });
  const caughtAt = trackOffset();
  expect(caughtAt).toBeLessThan(0);
  expect(caughtAt).toBeGreaterThan(-PAGE_WIDTH);
  const icon = screen.getByRole('button', { name: 'App 1' });
  fireEvent.pointerDown(icon, { pointerId: 5, pointerType: 'touch', clientX: 500, clientY: 150 });
  act(() => { vi.advanceTimersByTime(200); });
  // Held: the page stays where the finger caught it.
  expect(trackOffset()).toBe(caughtAt);
  fireEvent.pointerUp(icon, { pointerId: 5, pointerType: 'touch', clientX: 500, clientY: 150 });
  fireEvent.click(icon);
  expect(props.onOpen).not.toHaveBeenCalled();
  settle();
  // Let go a third of the way across, it settles on the nearer page.
  expect(trackOffset()).toBe(0);
  expect(currentPage()).toBe(1);
});

test('the page control turns pages and shows the current one', () => {
  renderHome(20);
  fireEvent.click(dots().getByRole('button', { name: '第 3 页' }));
  expect(currentPage()).toBe(3);
  settle();
  expect(trackOffset()).toBe(-2 * PAGE_WIDTH);
  fireEvent.click(dots().getByRole('button', { name: '第 1 页' }));
  settle();
  expect(trackOffset()).toBe(0);
});

test('sideways trackpad scrolling turns one page per gesture, and nudges at the last page', () => {
  renderHome(12);
  fireEvent.wheel(pager(), { deltaX: 40, deltaY: 2 });
  fireEvent.wheel(pager(), { deltaX: 40, deltaY: 1 });
  // The rest of the same gesture (momentum) turns nothing more.
  for (let event = 0; event < 10; event += 1) {
    act(() => { vi.advanceTimersByTime(30); });
    fireEvent.wheel(pager(), { deltaX: 60, deltaY: 0 });
  }
  settle();
  expect(currentPage()).toBe(2);
  // A new gesture at the last page: a rubber-band nudge, then back.
  fireEvent.wheel(pager(), { deltaX: 80, deltaY: 0 });
  expect(trackOffset()).toBeLessThan(-PAGE_WIDTH);
  settle();
  expect(trackOffset()).toBe(-PAGE_WIDTH);
  // Vertical scrolling is left to the page.
  fireEvent.wheel(pager(), { deltaX: 5, deltaY: -120 });
  settle();
  expect(currentPage()).toBe(2);
});

test('the arrow keys do nothing while an app covers the home screen', () => {
  renderHome(12, { covered: true });
  fireEvent.keyDown(window, { key: 'ArrowRight' });
  expect(currentPage()).toBe(1);
});

test('the arrow keys turn pages, but not while typing', () => {
  renderHome(12);
  fireEvent.keyDown(window, { key: 'ArrowRight' });
  expect(currentPage()).toBe(2);
  fireEvent.keyDown(window, { key: 'ArrowRight' });
  expect(currentPage()).toBe(2);
  const field = document.body.appendChild(document.createElement('input'));
  fireEvent.keyDown(field, { key: 'ArrowLeft' });
  expect(currentPage()).toBe(2);
  field.remove();
  fireEvent.keyDown(window, { key: 'ArrowLeft' });
  expect(currentPage()).toBe(1);
});

test('reduced motion snaps to the page with no spring', () => {
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query.includes('reduce'), media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }) as unknown as MediaQueryList);
  renderHome(12);
  fireEvent.click(dots().getByRole('button', { name: '第 2 页' }));
  expect(trackOffset()).toBe(-PAGE_WIDTH);
});

test('focus moving to an icon on another page brings that page in', () => {
  renderHome(12);
  act(() => { screen.getByRole('button', { name: 'App 10' }).focus(); });
  expect(currentPage()).toBe(2);
  settle();
  expect(trackOffset()).toBe(-PAGE_WIDTH);
});

test('in edit mode 后移 moves the last icon of a page onto the next page, and focus and the page follow it', () => {
  renderHome(12);
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  const later = screen.getByRole('button', { name: '后移 App 8' });
  act(() => { later.focus(); });
  fireEvent.click(later);
  settle();
  const second = screen.getByRole('navigation', { name: '应用（第 2 页）' });
  const moved = within(second).getByRole('button', { name: '后移 App 8' });
  expect(document.activeElement).toBe(moved);
  expect(within(second).getAllByRole('button', { name: /^App / }).map(button => button.getAttribute('aria-label'))).toEqual(['App 8', 'App 10', 'App 11', 'App 12']);
  expect(within(screen.getByRole('navigation', { name: '应用' })).getAllByRole('button', { name: /^App / }).at(-1)?.getAttribute('aria-label')).toBe('App 9');
  expect(currentPage()).toBe(2);
  expect(JSON.parse(localStorage.getItem('studio-home-layout-v1') ?? '{}').order.slice(6, 10)).toEqual(['project:p7', 'project:p9', 'project:p8', 'project:p10']);
});

test('an icon dragged to the side of the screen and held there turns the page, and drops on the new page', () => {
  renderHome(12);
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  const icon = screen.getByRole('button', { name: 'App 1' });
  // In edit mode a mouse picks an icon up after a few pixels (dnd-kit listens on the document from then on).
  fireEvent.pointerDown(icon, { pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 125, clientY: 150 });
  fireEvent.pointerMove(document, { pointerId: 1, pointerType: 'mouse', clientX: 140, clientY: 150 });
  fireEvent.pointerMove(document, { pointerId: 1, pointerType: 'mouse', clientX: 600, clientY: 150 });
  // Away from the edge nothing turns, however long it is held.
  act(() => { vi.advanceTimersByTime(800); });
  expect(currentPage()).toBe(1);
  fireEvent.pointerMove(document, { pointerId: 1, pointerType: 'mouse', clientX: 985, clientY: 150 });
  act(() => { vi.advanceTimersByTime(400); });
  expect(currentPage()).toBe(1);
  act(() => { vi.advanceTimersByTime(150); });
  expect(currentPage()).toBe(2);
  // Away from the edge again before the next turn (held there, it would go on to the empty page after the last).
  fireEvent.pointerMove(document, { pointerId: 1, pointerType: 'mouse', clientX: 600, clientY: 150 });
  settle();
  expect(trackOffset()).toBe(-PAGE_WIDTH);
  // Back from the edge, over the second page's first icon, and let go.
  fireEvent.pointerMove(document, { pointerId: 1, pointerType: 'mouse', clientX: 130, clientY: 152 });
  fireEvent.pointerMove(document, { pointerId: 1, pointerType: 'mouse', clientX: 125, clientY: 150 });
  fireEvent.pointerUp(document, { pointerId: 1, pointerType: 'mouse', clientX: 125, clientY: 150 });
  settle();
  const order = JSON.parse(localStorage.getItem('studio-home-layout-v1') ?? '{}').order as string[];
  expect(order.indexOf('project:p1')).toBe(8);
  expect(within(screen.getByRole('navigation', { name: '应用（第 2 页）' })).getAllByRole('button', { name: /^App / })[0].getAttribute('aria-label')).toBe('App 1');
  expect(screen.getByRole('button', { name: '完成' })).toBeTruthy();
});

test('an icon held at the side of the last page makes a new page and begins it when dropped there', () => {
  renderHome(5);
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  // One page only: no page control until a drag offers the empty page after it.
  expect(screen.queryByRole('group', { name: '主屏幕页面' })).toBeNull();
  const icon = screen.getByRole('button', { name: 'App 2' });
  fireEvent.pointerDown(icon, { pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 375, clientY: 150 });
  fireEvent.pointerMove(document, { pointerId: 1, pointerType: 'mouse', clientX: 390, clientY: 150 });
  expect(dots().getAllByRole('button')).toHaveLength(2);
  fireEvent.pointerMove(document, { pointerId: 1, pointerType: 'mouse', clientX: 985, clientY: 150 });
  act(() => { vi.advanceTimersByTime(550); });
  expect(currentPage()).toBe(2);
  fireEvent.pointerMove(document, { pointerId: 1, pointerType: 'mouse', clientX: 500, clientY: 150 });
  settle();
  fireEvent.pointerUp(document, { pointerId: 1, pointerType: 'mouse', clientX: 500, clientY: 150 });
  settle();
  // The icon went to the end and begins the second page, with + after it; the rest stay on the first.
  expect(within(screen.getByRole('navigation', { name: '应用' })).getAllByRole('button', { name: /^App / }).map(button => button.getAttribute('aria-label'))).toEqual(['App 1', 'App 3', 'App 4', 'App 5']);
  const secondPage = within(screen.getByRole('navigation', { name: '应用（第 2 页）' })).getAllByRole('button').map(button => button.getAttribute('aria-label'));
  expect(secondPage.filter(label => /^App \d+$|^新建项目$/.test(label ?? ''))).toEqual(['App 2', '新建项目']);
  expect(currentPage()).toBe(2);
  const saved = JSON.parse(localStorage.getItem('studio-home-layout-v1') ?? '{}');
  expect(saved.order.at(-1)).toBe('project:p2');
  expect(saved.pageBreaks).toEqual(['project:p2']);
});

// The slot of the icon with this accessible name, and how far dnd-kit has slid it aside (0 when it holds still).
const slotOf = (name: string) => screen.getByRole('button', { name }).closest<HTMLElement>('.home-tile-slot')!;
const shiftOf = (name: string) => Number(/translate3d\((-?[\d.]+)px/.exec(slotOf(name).style.transform)?.[1] ?? 0);
const mouse = (clientX: number, clientY: number) => ({ pointerId: 1, pointerType: 'mouse', clientX, clientY });

test('an icon held on the middle of another makes a folder: the target holds still, grows, and takes it on release', () => {
  renderHome(5);
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  fireEvent.pointerDown(screen.getByRole('button', { name: 'App 1' }), { ...mouse(125, 150), button: 0, isPrimary: true });
  fireEvent.pointerMove(document, mouse(140, 150));
  // On the middle of App 2's icon card (the cell's top 70 px, centred: centre 375, 135).
  fireEvent.pointerMove(document, mouse(370, 140));
  fireEvent.pointerMove(document, mouse(375, 135));
  expect(slotOf('App 2').classList.contains('is-merge-target')).toBe(true);
  // Past the time a reflow would take, App 2 has not dodged aside: the grid holds still under a merge.
  act(() => { vi.advanceTimersByTime(250); });
  expect(shiftOf('App 2')).toBe(0);
  expect(slotOf('App 2').classList.contains('is-merge-ready')).toBe(false);
  act(() => { vi.advanceTimersByTime(150); });
  expect(slotOf('App 2').classList.contains('is-merge-ready')).toBe(true);
  expect(document.querySelector('.home-drag-overlay .is-lifted.is-merging')).not.toBeNull();
  fireEvent.pointerUp(document, mouse(375, 135));
  settle();
  const saved = JSON.parse(localStorage.getItem('studio-home-layout-v1') ?? '{}');
  expect(saved.folders).toEqual([{ id: expect.any(String), name: '项目', items: ['project:p2', 'project:p1'] }]);
  expect(saved.order[0]).toBe(`folder:${saved.folders[0].id}`);
  expect(screen.getByRole('button', { name: '文件夹「项目」，2 个应用' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'App 1' })).toBeNull();
});

test('dropped on an icon that already is a folder, an icon joins it', () => {
  localStorage.setItem('studio-home-layout-v1', JSON.stringify({
    hidden: [], labels: true, large: false, order: ['project:p3', 'folder:tools', 'project:p4'],
    folders: [{ id: 'tools', name: '工具', items: ['project:p1', 'project:p2'] }],
  }));
  renderHome(4);
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  fireEvent.pointerDown(screen.getByRole('button', { name: 'App 3' }), { ...mouse(125, 150), button: 0, isPrimary: true });
  fireEvent.pointerMove(document, mouse(140, 150));
  fireEvent.pointerMove(document, mouse(375, 135));
  act(() => { vi.advanceTimersByTime(400); });
  fireEvent.pointerUp(document, mouse(375, 135));
  settle();
  const saved = JSON.parse(localStorage.getItem('studio-home-layout-v1') ?? '{}');
  expect(saved.folders).toEqual([{ id: 'tools', name: '工具', items: ['project:p1', 'project:p2', 'project:p3'] }]);
  expect(saved.order).toEqual(['folder:tools', 'project:p4']);
});

test('held between icons, the grid makes room after a short dwell, and a release lands there', () => {
  renderHome(5);
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  fireEvent.pointerDown(screen.getByRole('button', { name: 'App 1' }), { ...mouse(125, 150), button: 0, isPrimary: true });
  fireEvent.pointerMove(document, mouse(140, 150));
  // Under App 3's icon, over its name: not its middle.
  fireEvent.pointerMove(document, mouse(625, 192));
  expect(shiftOf('App 3')).toBe(0);
  act(() => { vi.advanceTimersByTime(250); });
  // App 2 and App 3 slide one slot back to make room.
  expect(shiftOf('App 2')).toBe(-250);
  expect(shiftOf('App 3')).toBe(-250);
  expect(document.querySelector('.is-merge-target')).toBeNull();
  fireEvent.pointerUp(document, mouse(625, 192));
  settle();
  expect(JSON.parse(localStorage.getItem('studio-home-layout-v1') ?? '{}').order.slice(0, 3)).toEqual(['project:p2', 'project:p3', 'project:p1']);
  expect(JSON.parse(localStorage.getItem('studio-home-layout-v1') ?? '{}').folders).toEqual([]);
});

test('an icon dragged out of an open folder closes it and carries on as a drag on the home screen', () => {
  localStorage.setItem('studio-home-layout-v1', JSON.stringify({
    hidden: [], labels: true, large: false, order: ['folder:tools', 'project:p3', 'project:p4'],
    folders: [{ id: 'tools', name: '工具', items: ['project:p1', 'project:p2'] }],
  }));
  const rect = Element.prototype.getBoundingClientRect as unknown as { getMockImplementation: () => (this: Element) => DOMRect };
  const laidOut = rect.getMockImplementation();
  // The open folder's panel sits in the middle of the screen, its icons in a row inside it.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const panel = this.closest('.home-folder-panel');
    if (this === panel) return box(300, 120, 400, 200);
    if (panel && this instanceof HTMLElement && this.dataset.sortId) return box(350 + Array.from(panel.querySelectorAll('[data-sort-id]')).indexOf(this) * 100, 150, 100, 100);
    return laidOut.call(this);
  });
  renderHome(4);
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  fireEvent.click(screen.getByRole('button', { name: '文件夹「工具」，2 个应用' }));
  const folder = screen.getByRole('dialog');
  const icon = within(folder).getByRole('button', { name: 'App 1' });
  fireEvent.pointerDown(icon, { pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 400, clientY: 200 });
  fireEvent.pointerMove(document, { pointerId: 1, pointerType: 'mouse', clientX: 410, clientY: 200 });
  // Still over the panel: the folder stays, however long the icon is held.
  act(() => { vi.advanceTimersByTime(600); });
  expect(screen.getByRole('dialog')).toBeTruthy();
  // Beyond it and held a moment: the folder closes and the icon is on the home screen, still lifted.
  fireEvent.pointerMove(document, { pointerId: 1, pointerType: 'mouse', clientX: 880, clientY: 190 });
  act(() => { vi.advanceTimersByTime(300); });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(JSON.parse(localStorage.getItem('studio-home-layout-v1') ?? '{}').folders).toEqual([{ id: 'tools', name: '工具', items: ['project:p2'] }]);
  expect(document.querySelector('.home-drag-overlay .is-lifted')).not.toBeNull();
  // Dropped over the last icon, it takes that place.
  fireEvent.pointerMove(document, { pointerId: 1, pointerType: 'mouse', clientX: 870, clientY: 190 });
  fireEvent.pointerUp(document, { pointerId: 1, pointerType: 'mouse', clientX: 870, clientY: 190 });
  settle();
  expect(JSON.parse(localStorage.getItem('studio-home-layout-v1') ?? '{}').order).toEqual(['folder:tools', 'project:p3', 'project:p4', 'project:p1']);
  expect(screen.getByRole('button', { name: '完成' })).toBeTruthy();
});
