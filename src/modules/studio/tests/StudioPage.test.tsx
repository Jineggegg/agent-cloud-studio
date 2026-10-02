import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type * as ApiModule from '@/shared/api';

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }));
const PROJECTS = [
  { id: 'snr', name: 'SNR 3.0', description: '', workspacePath: '/p/snr', modules: ['agents', 'snr-lab'], providers: ['claude', 'deepseek'], tone: 'sage', glyph: 'activity', links: [], remoteHost: '', remoteDir: '', updatedAt: '1' },
  { id: 'prof', name: '超级教授', description: '', workspacePath: '/p/prof', modules: ['agents'], providers: ['claude', 'codex', 'deepseek'], tone: 'clay', glyph: 'graduation', links: [{ label: '网站', url: 'https://example.test/' }], remoteHost: '', remoteDir: '', updatedAt: '1' },
];
const conversations = vi.fn((space: string) => json(space === 'project:prof'
  ? [{ id: 'p1', title: '课程大纲', model: 'deepseek-flash', updated_at: new Date().toISOString(), space }]
  : [{ id: 'd1', title: '通用问题', model: 'deepseek-flash', updated_at: new Date().toISOString(), space }]));

vi.mock('@/modules/auth', () => ({ useAuth: () => ({ user: { username: 'tester' }, logout: vi.fn() }) }));
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false, setThemeMode: vi.fn() }) }));
vi.mock('@/modules/studio/StudioFluidBackground', () => ({ StudioFluidBackground: () => null }));
vi.mock('@/shared/api', async (original) => ({
  ...(await original<typeof ApiModule>()),
  api: {
    studio: {
      status: () => json({ deepseek: { configured: true, models: ['deepseek-flash'], baseUrl: 'https://api.deepseek.com' }, agentWorkbenchUrl: null, snrRemoteUrl: null }),
      snr: () => json({ connected: true, phase: 5, datasetCount: 2, rulesApproved: false, tradingEnabled: false }),
      conversations: (space: string) => conversations(space),
      conversation: vi.fn(),
      closeSnr: () => json({}),
      projects: { list: () => json(PROJECTS), sessions: () => json([]) },
      trading212: { status: () => json([{ env: 'live', configured: false, source: null }]) },
      quota: () => json([{ provider: 'claude', available: true, windows: [{ id: 'five_hour', label: '5 小时', usedPercent: 42, windowMinutes: 300, resetsAt: new Date(Date.now() + 7200000).toISOString() }], balances: [], source: 'statusline', observedAt: new Date().toISOString(), stale: false }]),
    },
  },
}));

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const { StudioPage } = await import('@/modules/studio/StudioPage');

beforeEach(() => { localStorage.clear(); conversations.mockClear(); });
afterEach(cleanup);

function renderStudio(path = '/') {
  render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/" element={<StudioPage />} />
    <Route path="/projects/:id" element={<StudioPage />} />
    <Route path="/apps/:app" element={<StudioPage />} />
  </Routes></MemoryRouter>);
}

test('projects appear as home tiles and open into their own app with project-scoped DeepSeek history', async () => {
  renderStudio();
  const apps = await screen.findByRole('navigation', { name: '应用' });
  expect(await within(apps).findByRole('button', { name: 'SNR 3.0，在线' })).toBeTruthy();

  fireEvent.click(within(apps).getByRole('button', { name: '超级教授' }));
  const professor = await screen.findByRole('region', { name: '超级教授' });
  const tabs = within(professor).getByRole('navigation', { name: '项目功能' });
  expect(within(tabs).getAllByRole('button').map(button => button.textContent)).toEqual(['AI 助手', 'DeepSeek', '设置']);

  fireEvent.click(within(tabs).getByRole('button', { name: 'DeepSeek' }));
  await waitFor(() => expect(conversations).toHaveBeenCalledWith('project:prof'));
  expect(await within(professor).findByText('课程大纲')).toBeTruthy();
  expect(within(professor).queryByText('通用问题')).toBeNull();

  fireEvent.click(within(professor).getByRole('button', { name: '返回主屏幕' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: '超级教授' })).toBeNull());
  expect(screen.getByRole('navigation', { name: '应用' })).toBeTruthy();
});

test('SNR opens on its K-line lab and a deep link works without the home screen', async () => {
  renderStudio('/projects/snr');
  const snr = await screen.findByRole('region', { name: 'SNR 3.0' });
  expect(within(within(snr).getByRole('navigation', { name: '项目功能' })).getAllByRole('button')[0].getAttribute('aria-current')).toBe('page');
  expect(await within(snr).findByText('K 线实验室', { selector: 'h2' })).toBeTruthy();
  expect(within(snr).getByText('Phase 5')).toBeTruthy();
});

test('an unknown project shows a recoverable empty state', async () => {
  renderStudio('/projects/missing');
  expect(await screen.findByText('这个项目不存在或已被删除')).toBeTruthy();
});
