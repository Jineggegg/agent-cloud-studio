import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LazyMotion, MotionConfig, domMax } from 'motion/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';

import type { WorkbenchProjectActivity, WorkbenchProjectEntry } from '@/shared/types';
import { installPointerEvent } from '@/modules/workbench/tests/swipeTestHelpers';

// The Studio barrel pulls in the whole home screen; the switcher only needs its tile icon.
vi.mock('@/modules/studio', () => ({ StudioTileIcon: () => <span /> }));

const { WorkbenchProjectSwitcher } = await import('@/modules/workbench/WorkbenchProjectSwitcher');

const project = (projectId: string, displayName: string) => ({
  projectId, displayName, fullPath: `/home/me/projects/${displayName}`, path: `/home/me/projects/${displayName}`, isStarred: false,
});
const ENTRIES: WorkbenchProjectEntry[] = [
  { project: project('p1', 'CodexUsage'), hub: null },
  { project: project('p2', 'e-du'), hub: null },
  { project: project('p3', 'trading212'), hub: null },
  { project: project('p4', 'snr3-lab'), hub: null },
  // Seven projects, so the search field shows.
  ...['notes', 'site', 'scripts'].map((name, index) => ({ project: project(`p${index + 5}`, name), hub: null })),
];

beforeAll(installPointerEvent);
afterEach(() => { vi.restoreAllMocks(); });

const mark = (running: number, attention = 0, attentionSessionIds: string[] = []): WorkbenchProjectActivity => ({ running, attention, attentionSessionIds });

function renderSwitcher(activity: Record<string, WorkbenchProjectActivity> | null, current = ENTRIES[0]) {
  const callbacks = { onSelect: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn() };
  const view = render(<LazyMotion features={domMax} strict><MotionConfig reducedMotion="always"><MemoryRouter>
    <WorkbenchProjectSwitcher entries={ENTRIES} current={current} activity={activity} {...callbacks} />
  </MemoryRouter></MotionConfig></LazyMotion>);
  const rerender = (next: Record<string, WorkbenchProjectActivity> | null) => view.rerender(<LazyMotion features={domMax} strict>
    <MotionConfig reducedMotion="always"><MemoryRouter>
      <WorkbenchProjectSwitcher entries={ENTRIES} current={current} activity={next} {...callbacks} />
    </MemoryRouter></MotionConfig></LazyMotion>);
  return { ...callbacks, rerender };
}

const trigger = () => screen.getByRole('button', { name: /^当前项目：CodexUsage，切换项目/ });
const rowButton = (name: RegExp) => screen.getByRole('button', { name });

test('every running project shows a spinner, two at once, left of the current project\'s ✓', () => {
  renderSwitcher({ p1: mark(1), p2: mark(1), p4: mark(2) });
  fireEvent.click(trigger());
  const popover = screen.getByRole('dialog', { name: '切换项目' });
  expect(within(popover).getAllByTestId('project-running')).toHaveLength(3);
  expect(within(rowButton(/^e-du，正在运行$/)).getByTestId('project-running')).toBeTruthy();
  expect(within(rowButton(/^snr3-lab，正在运行$/)).getByTestId('project-running')).toBeTruthy();
  expect(within(rowButton(/^trading212$/)).queryByTestId('project-running')).toBeNull();
  // The current project keeps its ✓, with the spinner just before it.
  const currentRow = rowButton(/^CodexUsage，正在运行$/);
  const spinner = within(currentRow).getByTestId('project-running');
  const check = currentRow.querySelector('.wb-popover-check')!;
  expect(spinner.compareDocumentPosition(check) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('a project that needs the owner shows a red dot, with the spinner too while it still runs', async () => {
  const { rerender } = renderSwitcher({ p2: mark(0, 1, ['s1']), p4: mark(1, 1, ['s9']) });
  fireEvent.click(trigger());
  const waiting = rowButton(/^e-du，需要你处理$/);
  expect(within(waiting).getByTestId('project-attention').getAttribute('title')).toBe('需要你处理');
  expect(within(waiting).queryByTestId('project-running')).toBeNull();
  const both = rowButton(/^snr3-lab，正在运行，需要你处理$/);
  expect(within(both).getByTestId('project-running')).toBeTruthy();
  expect(within(both).getByTestId('project-attention')).toBeTruthy();

  // Handled: the dot leaves (animated out), the name reads plainly again.
  rerender({ p4: mark(1, 0) });
  await waitFor(() => expect(within(rowButton(/^e-du$/)).queryByTestId('project-attention')).toBeNull());
});

test('the closed switcher carries one combined mark for the other projects only', async () => {
  const { rerender } = renderSwitcher({ p1: mark(1, 1) });
  // Only the current project is busy: nothing to open the list for.
  expect(screen.queryByTestId('switcher-running')).toBeNull();
  expect(screen.queryByTestId('switcher-attention')).toBeNull();
  expect(trigger().getAttribute('aria-label')).toBe('当前项目：CodexUsage，切换项目');

  rerender({ p1: mark(1, 1), p2: mark(1), p4: mark(2) });
  expect(screen.getByTestId('switcher-running')).toBeTruthy();
  expect(trigger().getAttribute('aria-label')).toBe('当前项目：CodexUsage，切换项目（其他项目：2 个正在运行）');

  // Needing the owner outranks running: the badge turns into a red dot.
  rerender({ p2: mark(1), p3: mark(0, 2) });
  await waitFor(() => expect(screen.queryByTestId('switcher-running')).toBeNull());
  expect(screen.getByTestId('switcher-attention')).toBeTruthy();
  expect(trigger().getAttribute('aria-label')).toBe('当前项目：CodexUsage，切换项目（其他项目：1 个正在运行，1 个需要你处理）');
});

// ---------- Press and slide ----------

// jsdom has no layout: the "row under the finger" is whatever elementFromPoint is told to return.
function pointAt(resolve: (x: number, y: number) => Element | null) {
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: resolve });
}
const press = (target: Element, x: number, y: number, pointerType = 'touch') =>
  fireEvent.pointerDown(target, { pointerId: 3, pointerType, button: 0, isPrimary: true, clientX: x, clientY: y });
const slide = (target: Element, x: number, y: number, pointerType = 'touch') =>
  fireEvent.pointerMove(target, { pointerId: 3, pointerType, clientX: x, clientY: y });
const lift = (target: Element, x: number, y: number, pointerType = 'touch') =>
  fireEvent.pointerUp(target, { pointerId: 3, pointerType, clientX: x, clientY: y });

test('press, slide onto a row and lift: the list opens on the press and the lifted-on project is chosen', async () => {
  const { onSelect } = renderSwitcher(null);
  const button = trigger();
  press(button, 40, 20);
  const popover = await screen.findByRole('dialog', { name: '切换项目' });
  // Each row sits 50px below the previous one.
  pointAt((_x, y) => (y < 100 ? button : popover.querySelectorAll('[data-project-id]')[Math.floor((y - 100) / 50)] ?? document.body));

  slide(button, 40, 210);
  const trading = rowButton(/^trading212$/);
  expect(trading.getAttribute('data-slide-active')).toBe('true');
  slide(button, 40, 160);
  expect(rowButton(/^e-du$/).getAttribute('data-slide-active')).toBe('true');
  expect(trading.getAttribute('data-slide-active')).toBeNull();
  // A finger's press keeps focus on the panel: sliding never focuses the search field (no keyboard pops up).
  await waitFor(() => expect(document.activeElement).toBe(popover));
  expect(within(popover).getByRole('searchbox', { name: '搜索项目' })).not.toBe(document.activeElement);

  lift(button, 40, 160);
  fireEvent.click(button);
  expect(onSelect).toHaveBeenCalledWith('p2');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '切换项目' })).toBeNull());
});

test('lifting outside the list, or back on the trigger, cancels and leaves the list open like a tap', async () => {
  const { onSelect } = renderSwitcher(null);
  const button = trigger();
  press(button, 40, 20, 'mouse');
  const popover = await screen.findByRole('dialog', { name: '切换项目' });
  pointAt((_x, y) => (y < 100 ? button : y > 400 ? document.body : popover.querySelector('[data-project-id]')));

  slide(button, 40, 120, 'mouse');
  expect(rowButton(/^CodexUsage$/).getAttribute('data-slide-active')).toBe('true');
  slide(button, 40, 600, 'mouse');
  lift(button, 40, 600, 'mouse');
  fireEvent.click(button);
  expect(onSelect).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: '切换项目' })).toBe(popover);
  expect(popover.querySelector('[data-slide-active]')).toBeNull();

  // The list is now an ordinary open menu: a plain row tap switches.
  fireEvent.click(rowButton(/^snr3-lab$/));
  expect(onSelect).toHaveBeenCalledWith('p4');
});

test('a plain tap still opens the list and leaves it open; the keyboard toggles it as before', async () => {
  renderSwitcher(null);
  const button = trigger();
  press(button, 40, 20);
  lift(button, 40, 20);
  fireEvent.click(button);
  expect(await screen.findByRole('dialog', { name: '切换项目' })).toBeTruthy();
  expect(button.getAttribute('aria-expanded')).toBe('true');
  // A click with no press before it (Enter or Space) closes it again.
  await new Promise(resolve => setTimeout(resolve, 0));
  fireEvent.click(button);
  expect(button.getAttribute('aria-expanded')).toBe('false');
});

test('a finger resting near the list\'s bottom or top edge scrolls it', async () => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  const runFrames = (count: number) => { for (let i = 0; i < count && frames.length; i += 1) frames.shift()!(performance.now()); };

  renderSwitcher(null);
  const button = trigger();
  press(button, 40, 20);
  const popover = await screen.findByRole('dialog', { name: '切换项目' });
  const list = within(popover).getByRole('list', { name: '项目' });
  list.getBoundingClientRect = () => ({ top: 100, bottom: 300, left: 0, right: 320, width: 320, height: 200, x: 0, y: 100, toJSON: () => ({}) });
  let scrollTop = 0;
  Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => scrollTop, set: value => { scrollTop = Math.max(0, Math.min(value, 400)); } });
  pointAt(() => popover.querySelector('[data-project-id]'));

  // In the middle of the list nothing scrolls.
  slide(button, 40, 200);
  runFrames(3);
  expect(scrollTop).toBe(0);
  // Near the bottom edge it keeps scrolling down, frame after frame, while the finger rests there.
  slide(button, 40, 296);
  runFrames(5);
  expect(scrollTop).toBeGreaterThan(20);
  const scrolledDown = scrollTop;
  // Near the top edge it scrolls back up.
  slide(button, 40, 104);
  runFrames(3);
  expect(scrollTop).toBeLessThan(scrolledDown);
  lift(button, 40, 104);
});
