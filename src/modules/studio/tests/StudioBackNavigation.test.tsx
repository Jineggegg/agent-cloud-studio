import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import type { InitialEntry } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type * as ApiModule from '@/shared/api';
import type { HubProject, StudioAppStatus, StudioBuild } from '@/shared/types';

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }));
// 云记事: an app Studio's AI built (it has a build), so it opens on 主页 with AI 工坊 and 设置 beside it.
const NOTES: HubProject = {
  id: 'notes', name: '云记事', description: 'AI 开发 · 记事本', workspacePath: '/home/me/projects/ai-app', modules: ['agents'],
  providers: ['claude', 'codex', 'deepseek'], tone: 'slate', glyph: 'book', links: [], remoteHost: '', remoteDir: '', updatedAt: '1',
};
const BUILD: StudioBuild = {
  id: 'b1', hubProjectId: 'notes', ideProjectId: 'ide-1', sessionId: 'session-1', workspacePath: '/home/me/projects/ai-app', state: 'done',
  total: 4, completed: 4, currentTask: null, createdAt: '2026-10-03T10:00:00.000Z', startedAt: '2026-10-03T10:00:00.000Z',
  finishedAt: '2026-10-03T10:20:00.000Z', error: null,
};
const RUNNING: StudioAppStatus = { state: 'running', error: null, log: [], startedAt: '2026-10-03T10:21:00.000Z', kind: 'npm', url: `/api/studio/app-site/${'a'.repeat(64)}/` };

vi.mock('@/modules/auth', () => ({ useAuth: () => ({ user: { username: 'tester' }, logout: vi.fn() }) }));
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false, setThemeMode: vi.fn() }) }));
vi.mock('@/modules/studio/StudioFluidBackground', () => ({ StudioFluidBackground: () => null }));
vi.mock('@/modules/studio/StudioWidgets', () => ({ StudioWidgets: () => null }));
vi.mock('@/shared/api', async (original) => ({
  ...(await original<typeof ApiModule>()),
  api: {
    projectSessions: () => json({ sessions: [{ id: 's1', provider: 'claude', summary: '开发云记事', lastActivity: '2026-10-03T10:20:00.000Z' }] }),
    runningSessions: () => json({ data: { sessions: [] } }),
    studio: {
      status: () => json({ deepseek: { configured: true, models: ['deepseek-flash'], baseUrl: 'https://api.deepseek.com' }, agentWorkbenchUrl: null, snrRemoteUrl: null }),
      snr: () => json({ connected: false }),
      conversations: () => json([]),
      closeSnr: () => json({}),
      projects: { list: () => json([NOTES]), sessions: () => json([]) },
      remote: { hosts: () => json([]) },
      trading212: { status: () => json([]) },
      quota: () => json([]),
      workbench: { hubLinks: () => json([{ hubId: 'notes', projectId: 'ide-1' }]) },
      builds: { list: () => json([BUILD]), resume: vi.fn(), cancel: vi.fn(), environment: vi.fn(), create: vi.fn(), suggestName: vi.fn() },
      apps: { open: () => json(RUNNING), status: () => json(RUNNING), stop: () => json({ state: 'stopped', error: null, log: [], startedAt: null, kind: 'npm' }) },
    },
  },
}));

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const { StudioPage } = await import('@/modules/studio/StudioPage');

beforeEach(() => {
  // A wide screen: the AI sidebar sits beside the app on its 主页.
  window.matchMedia = ((query: string) => ({ matches: query.includes('min-width'), media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

// Where the router is, how it got there (PUSH, REPLACE or POP, i.e. along history) and the entry's state.
function RouterProbe() {
  const location = useLocation();
  return <output data-testid="router" data-type={useNavigationType()} data-state={JSON.stringify(location.state ?? null)}>{`${location.pathname}${location.search}`}</output>;
}
// The workbench's part here: its back control steps back along history (WorkbenchShell does when the app is behind).
function WorkbenchStandIn() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(-1)}>工作台返回</button>;
}

function renderAt(entries: InitialEntry[]) {
  render(<MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}><Routes>
    <Route path="/" element={<StudioPage />} />
    <Route path="/projects/:id" element={<StudioPage />} />
    <Route path="/work/*" element={<WorkbenchStandIn />} />
  </Routes><RouterProbe /></MemoryRouter>);
}
const probe = () => screen.getByTestId('router');
const where = () => probe().textContent;
const currentTab = async () => (await screen.findByRole('navigation', { name: '项目功能' })).querySelector('[aria-current="page"]')?.textContent;
const openedFromHome: InitialEntry[] = ['/', { pathname: '/projects/notes', state: { fromHome: true } }];

test('at the app\'s root the top-left back leaves for the home screen, with the zoom back into the icon', async () => {
  renderAt(openedFromHome);
  const notes = await screen.findByRole('region', { name: '云记事' });
  await waitFor(async () => expect(await currentTab()).toBe('主页'));
  fireEvent.click(within(notes).getByRole('button', { name: '返回主屏幕' }));
  expect(notes.classList.contains('closing')).toBe(true);
  await waitFor(() => expect(screen.queryByRole('region', { name: '云记事' })).toBeNull());
  // Back along history to the home screen it was opened from, not a new home entry on top.
  expect(where()).toBe('/');
  expect(probe().dataset.type).toBe('POP');
});

test('a tab or 全部 is a step: back returns to the view before it, then home, and a tab tapped back is that step back', async () => {
  renderAt(openedFromHome);
  const notes = await screen.findByRole('region', { name: '云记事' });
  const tabs = await within(notes).findByRole('navigation', { name: '项目功能' });
  await waitFor(() => expect(within(tabs).getAllByRole('button').map(button => button.textContent)).toEqual(['主页', 'AI 工坊', '设置']));

  fireEvent.click(within(tabs).getByRole('button', { name: 'AI 工坊' }));
  expect(where()).toBe('/projects/notes?tab=ai');
  expect(probe().dataset.type).toBe('PUSH');
  fireEvent.click(within(tabs).getByRole('button', { name: '设置' }));
  expect(where()).toBe('/projects/notes?tab=settings');

  // No zoom while stepping back inside the app; the button is named after the view it returns to.
  fireEvent.click(within(notes).getByRole('button', { name: '返回 AI 工坊' }));
  expect(notes.classList.contains('closing')).toBe(false);
  expect(where()).toBe('/projects/notes?tab=ai');
  expect(probe().dataset.type).toBe('POP');
  fireEvent.click(within(notes).getByRole('button', { name: '返回 主页' }));
  expect(where()).toBe('/projects/notes');
  expect(await currentTab()).toBe('主页');

  // Tapping the tab just behind steps back to it instead of piling up history.
  fireEvent.click(within(tabs).getByRole('button', { name: 'AI 工坊' }));
  fireEvent.click(within(tabs).getByRole('button', { name: '主页' }));
  expect(where()).toBe('/projects/notes');
  expect(probe().dataset.type).toBe('POP');

  // 全部 in the 主页's 最近会话 opens AI 工坊 as a step too.
  fireEvent.click(await within(notes).findByRole('button', { name: '全部' }));
  expect(where()).toBe('/projects/notes?tab=ai');
  fireEvent.click(within(notes).getByRole('button', { name: '返回 主页' }));
  expect(where()).toBe('/projects/notes');

  fireEvent.click(within(notes).getByRole('button', { name: '返回主屏幕' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: '云记事' })).toBeNull());
  expect(where()).toBe('/');
});

test('a session opened from the app returns to the app page, not the home screen', async () => {
  renderAt(openedFromHome);
  const notes = await screen.findByRole('region', { name: '云记事' });
  const recent = await within(notes).findByRole('region', { name: '最近会话' });
  fireEvent.click(await within(recent).findByRole('link', { name: /开发云记事/ }));
  expect(where()).toBe('/work/ide-1/s/s1');
  // The workbench learns which app it was opened from, so its back control can return there.
  expect(JSON.parse(probe().dataset.state ?? 'null')).toEqual({ studioReturn: { path: '/projects/notes', title: '云记事' } });

  fireEvent.click(screen.getByRole('button', { name: '工作台返回' }));
  const back = await screen.findByRole('region', { name: '云记事' });
  expect(where()).toBe('/projects/notes');
  expect(await currentTab()).toBe('主页');
  // The app's own entry is untouched: its back still leaves for the home screen it came from.
  await act(async () => {});
  fireEvent.click(within(back).getByRole('button', { name: '返回主屏幕' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: '云记事' })).toBeNull());
  expect(where()).toBe('/');
  expect(probe().dataset.type).toBe('POP');
});

test('a deep link to a view inside the app has no history: back goes to the app\'s root first, then home', async () => {
  renderAt(['/projects/notes?tab=ai']);
  const notes = await screen.findByRole('region', { name: '云记事' });
  await waitFor(async () => expect(await currentTab()).toBe('AI 工坊'));
  fireEvent.click(within(notes).getByRole('button', { name: '返回 主页' }));
  expect(where()).toBe('/projects/notes');
  expect(probe().dataset.type).toBe('REPLACE');
  expect(await currentTab()).toBe('主页');

  fireEvent.click(within(notes).getByRole('button', { name: '返回主屏幕' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: '云记事' })).toBeNull());
  expect(where()).toBe('/');
});
