import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type * as ApiModule from '@/shared/api';
import type { HubProject, StudioAppStatus, StudioBuild } from '@/shared/types';

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
const PROJECT: HubProject = {
  id: 'notes', name: '云记事', description: 'AI 开发 · 记事本', workspacePath: '/home/me/projects/ai-app', modules: ['agents'],
  providers: ['claude', 'codex', 'deepseek'], tone: 'slate', glyph: 'book', links: [], remoteHost: '', remoteDir: '', updatedAt: '1',
};
const URL_1 = `/api/studio/app-site/${'a'.repeat(64)}/`;
const build = (patch: Partial<StudioBuild> = {}): StudioBuild => ({
  id: 'b1', hubProjectId: 'notes', ideProjectId: 'ide-1', sessionId: 'session-1', workspacePath: '/home/me/projects/ai-app', state: 'done',
  total: 4, completed: 4, currentTask: null, createdAt: '2026-10-03T10:00:00.000Z', startedAt: '2026-10-03T10:00:00.000Z',
  finishedAt: '2026-10-03T10:20:00.000Z', error: null, ...patch,
});
const running = (url = URL_1): StudioAppStatus => ({ state: 'running', error: null, log: [], startedAt: '2026-10-03T10:21:00.000Z', kind: 'npm', url });
const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  projects: [] as unknown[],
  builds: [] as unknown[],
}));

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
      projects: { list: () => json(mocks.projects), sessions: () => json([]) },
      remote: { hosts: () => json([]) },
      trading212: { status: () => json([]) },
      quota: () => json([]),
      workbench: { hubLinks: () => json([{ hubId: 'notes', projectId: 'ide-1' }]) },
      builds: { list: () => json(mocks.builds), resume: vi.fn(), cancel: vi.fn(), environment: vi.fn(), create: vi.fn(), suggestName: vi.fn() },
      apps: { open: mocks.open, status: () => json(running()), stop: () => json({ state: 'stopped', error: null, log: [], startedAt: null, kind: 'npm' }) },
    },
  },
}));

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const { StudioAppHome } = await import('@/modules/studio/StudioAppHome');
const { StudioPage } = await import('@/modules/studio/StudioPage');

beforeEach(() => {
  // A wide screen: the AI sidebar sits beside the app.
  window.matchMedia = ((query: string) => ({ matches: query.includes('min-width'), media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
  mocks.open.mockReset();
  mocks.open.mockImplementation(() => json(running()));
  mocks.projects = [PROJECT];
  mocks.builds = [build()];
});
afterEach(() => { cleanup(); });

function renderHome(props: Partial<Parameters<typeof StudioAppHome>[0]> = {}) {
  const onChange = vi.fn(async () => true);
  const view = (next: Partial<Parameters<typeof StudioAppHome>[0]>) => <MemoryRouter><Routes><Route path="/" element={
    <StudioAppHome project={PROJECT} build={build()} progress={undefined} workbenchUrl={null} onChange={onChange} onContinue={vi.fn()}
      onOpenChat={vi.fn()} onShowSessions={vi.fn()} {...props} {...next} />} /></Routes></MemoryRouter>;
  const result = render(view({}));
  return { onChange, rerender: (next: Partial<Parameters<typeof StudioAppHome>[0]>) => result.rerender(view(next)) };
}

test('the 主页 runs the app in a sandboxed frame that never shares Studio\'s origin, with the AI beside it', async () => {
  renderHome();
  const frame = await screen.findByTitle('云记事');
  expect(frame.tagName).toBe('IFRAME');
  expect(frame.getAttribute('src')).toBe(URL_1);
  expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
  expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  expect(mocks.open).toHaveBeenCalledWith('notes', false);
  expect(screen.getByRole('button', { name: /新建会话/ })).toBeTruthy();
  expect(await screen.findByText('开发云记事')).toBeTruthy();
  expect(screen.getByRole('form', { name: '快速让 AI 改' })).toBeTruthy();
});

test('快速让 AI 改 sends one sentence with Enter and clears it once the AI has it', async () => {
  const { onChange } = renderHome();
  const field = screen.getByLabelText('想让 AI 改什么') as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: '给笔记加上标签筛选' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  await waitFor(() => expect(onChange).toHaveBeenCalledWith('给笔记加上标签筛选'));
  await waitFor(() => expect(field.value).toBe(''));
  // While the AI works the field waits, and the running app shows what it is doing.
  renderHome({ build: build({ state: 'building', currentTask: '正在加标签', total: 3, completed: 1 }) });
  expect((await screen.findAllByText(/AI 正在修改/)).length).toBeGreaterThan(0);
});

test('a failed start shows the app\'s output and hands it to the AI to fix', async () => {
  mocks.open.mockImplementation(() => json({ state: 'failed', error: '应用已退出（退出码 1）', log: ['Error: Cannot find module x'], startedAt: null, kind: 'npm', url: null }));
  const { onChange } = renderHome();
  expect(await screen.findByText('应用没能启动')).toBeTruthy();
  expect(screen.getByText(/Cannot find module x/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '让 AI 修复' }));
  expect(onChange).toHaveBeenCalledWith(expect.stringContaining('Cannot find module x'));
});

test('when the AI finishes a change the app opens again on the new code', async () => {
  const { rerender } = renderHome({ build: build({ state: 'building', finishedAt: null }) });
  await screen.findByTitle('云记事');
  expect(mocks.open).toHaveBeenCalledTimes(1);
  mocks.open.mockImplementation(() => json(running(`/api/studio/app-site/${'b'.repeat(64)}/`)));
  rerender({ build: build({ state: 'done' }) });
  await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByTitle('云记事').getAttribute('src')).toBe(`/api/studio/app-site/${'b'.repeat(64)}/`));
});

test('an AI-built app opens on 主页, with AI 工坊 and 设置 beside it', async () => {
  render(<MemoryRouter initialEntries={['/projects/notes']}><Routes>
    <Route path="/" element={<StudioPage />} />
    <Route path="/projects/:id" element={<StudioPage />} />
  </Routes></MemoryRouter>);
  await act(async () => {});
  const tabs = await screen.findByRole('navigation', { name: '项目功能' });
  await waitFor(() => expect(Array.from(tabs.querySelectorAll('button')).map(button => button.textContent)).toEqual(['主页', 'AI 工坊', '设置']));
  expect(tabs.querySelector('[aria-current="page"]')?.textContent).toBe('主页');
  expect(await screen.findByTitle('云记事')).toBeTruthy();
});
