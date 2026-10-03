import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LazyMotion, domMax } from 'motion/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, expect, test, vi } from 'vitest';

import type { WorkbenchProjectEntry } from '@/shared/types';
import { installPointerEvent, swipe, tap } from '@/modules/workbench/tests/swipeTestHelpers';

// The Studio barrel pulls in the whole home screen; the switcher only needs its tile icon.
vi.mock('@/modules/studio', () => ({ StudioTileIcon: () => <span /> }));

const { WorkbenchProjectSwitcher } = await import('@/modules/workbench/WorkbenchProjectSwitcher');

const project = (projectId: string, displayName: string) => ({
  projectId, displayName, fullPath: `/home/me/projects/${displayName}`, path: `/home/me/projects/${displayName}`, isStarred: false,
});
// Seven projects, so the search field shows; the first belongs to a Studio hub project and is shown by its name.
const ENTRIES: WorkbenchProjectEntry[] = [
  { project: project('p1', 'professor'), hub: { id: 'professor', name: '超级教授', tone: 'clay', glyph: 'graduation' } as WorkbenchProjectEntry['hub'] },
  ...['snr3-lab', 'notes', 'trading', 'site', 'scripts', 'dotfiles'].map((name, index) => ({ project: project(`p${index + 2}`, name), hub: null })),
];

beforeAll(installPointerEvent);

function renderSwitcher() {
  const callbacks = { onSelect: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn() };
  render(<LazyMotion features={domMax} strict><MemoryRouter>
    <WorkbenchProjectSwitcher entries={ENTRIES} current={ENTRIES[0]} {...callbacks} />
  </MemoryRouter></LazyMotion>);
  fireEvent.click(screen.getByRole('button', { name: '当前项目：超级教授，切换项目' }));
  return { ...callbacks, popover: screen.getByRole('dialog', { name: '切换项目' }) };
}

const rowOf = (name: string) => screen.getByRole('button', { name }).closest('li')!;
const listedNames = (popover: HTMLElement) => Array.from(popover.querySelectorAll('[data-popover-item]')).map(item => item.textContent);

test('the trigger and the rows show names only, never directory paths, and search matches names', async () => {
  const { popover } = renderSwitcher();
  expect(screen.getByRole('button', { name: '当前项目：超级教授，切换项目' }).textContent).toBe('超级教授');
  expect(within(popover).getAllByRole('listitem')).toHaveLength(7);
  expect(document.body.textContent).not.toContain('/home/me');

  const search = within(popover).getByRole('searchbox', { name: '搜索项目' });
  // A path segment is not a name, so it matches nothing (and the message says names).
  fireEvent.change(search, { target: { value: 'projects' } });
  expect(within(popover).getByText('没有名称包含「projects」的项目')).toBeTruthy();
  fireEvent.change(search, { target: { value: 'SNR' } });
  await waitFor(() => expect(listedNames(popover)).toEqual(['snr3-lab']));
  // The folder name of a hub project still finds it.
  fireEvent.change(search, { target: { value: 'profess' } });
  await waitFor(() => expect(listedNames(popover)).toEqual(['超级教授']));
});

test('swiping a row left reveals 归档 and a red 删除, each handing back the project; a tap on a closed row still selects', () => {
  const { onSelect, onArchive, onDelete } = renderSwitcher();
  const row = screen.getByRole('button', { name: 'snr3-lab' });
  expect(screen.queryByRole('button', { name: '归档' })).toBeNull();

  swipe(row, { dx: -160 });
  const actions = within(rowOf('snr3-lab'));
  expect(actions.getByRole('button', { name: '归档' })).toBeTruthy();
  expect(actions.getByRole('button', { name: '删除' }).getAttribute('data-destructive')).toBe('true');
  // The click that ends a (mouse) swipe never selects the row it moved.
  fireEvent.click(row);
  expect(onSelect).not.toHaveBeenCalled();

  fireEvent.click(actions.getByRole('button', { name: '归档' }));
  expect(onArchive).toHaveBeenCalledWith(ENTRIES[1]);
  expect(screen.queryByRole('button', { name: '归档' })).toBeNull();

  swipe(row, { dx: -160, pointerType: 'mouse' });
  fireEvent.click(within(rowOf('snr3-lab')).getByRole('button', { name: '删除' }));
  expect(onDelete).toHaveBeenCalledWith(ENTRIES[1]);

  tap(screen.getByRole('button', { name: 'notes' }));
  expect(onSelect).toHaveBeenCalledWith('p3');
});

test('a vertical drag is left to the list, one row opens at a time, and a tap elsewhere or on the open row closes it', () => {
  const { onSelect } = renderSwitcher();
  const snr = screen.getByRole('button', { name: 'snr3-lab' });
  const notes = screen.getByRole('button', { name: 'notes' });

  swipe(snr, { dx: -6, dy: 70 });
  expect(screen.queryByRole('button', { name: '归档' })).toBeNull();

  swipe(snr, { dx: -160 });
  expect(within(rowOf('snr3-lab')).getByRole('button', { name: '归档' })).toBeTruthy();
  swipe(notes, { dx: -160 });
  expect(within(rowOf('notes')).getByRole('button', { name: '归档' })).toBeTruthy();
  expect(within(rowOf('snr3-lab')).queryByRole('button', { name: '归档' })).toBeNull();

  // A tap on the open row's content closes it rather than switching project.
  tap(notes);
  expect(onSelect).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '归档' })).toBeNull();

  swipe(notes, { dx: -160 });
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('button', { name: '归档' })).toBeNull();
  // Swiping back to the right closes it too.
  swipe(notes, { dx: -160 });
  swipe(notes, { dx: 160 });
  expect(screen.queryByRole('button', { name: '归档' })).toBeNull();
});

test('the "…" button and the context menu open the actions without swiping; Escape closes them and keeps the popover', async () => {
  const { popover, onArchive } = renderSwitcher();
  // The popover puts focus on its first row once it opens; let that happen first.
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '超级教授' })));
  const reveal = screen.getByRole('button', { name: '「snr3-lab」的更多操作' });
  fireEvent.click(reveal);
  expect(reveal.getAttribute('aria-expanded')).toBe('true');
  const archive = within(rowOf('snr3-lab')).getByRole('button', { name: '归档' });
  await waitFor(() => expect(document.activeElement).toBe(archive));

  fireEvent.keyDown(archive, { key: 'Escape' });
  expect(screen.queryByRole('button', { name: '归档' })).toBeNull();
  expect(popover.isConnected).toBe(true);
  expect(document.activeElement).toBe(reveal);

  fireEvent.contextMenu(screen.getByRole('button', { name: 'notes' }));
  fireEvent.click(within(rowOf('notes')).getByRole('button', { name: '归档' }));
  expect(onArchive).toHaveBeenCalledWith(ENTRIES[2]);
});
