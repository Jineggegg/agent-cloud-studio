import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type * as ApiModule from '@/shared/api';

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }));
const PROJECTS = [
  { id: 'snr', name: 'SNR 3.0', description: '', workspacePath: '/p/snr', modules: ['agents', 'snr-lab'], providers: ['claude', 'deepseek'], tone: 'sage', glyph: 'activity', links: [], remoteHost: '', remoteDir: '', updatedAt: '1' },
  { id: 'prof', name: '超级教授', description: '', workspacePath: '/p/prof', modules: ['agents'], providers: ['claude', 'codex', 'deepseek'], tone: 'clay', glyph: 'graduation', links: [{ label: '网站', url: 'https://example.test/' }], remoteHost: '', remoteDir: '', updatedAt: '1' },
];
const MINUTE = 60_000;
const HARNESS = {
  machines: ['wsl', 'windows'], checkedAt: new Date().toISOString(),
  tasks: [
    { id: 'claude:windows:w1', provider: 'claude', machine: 'windows', sessionId: 'w1', title: 'v7 安全收尾', directory: '~/projects/agent-cloud-studio', client: '桌面版', state: 'running', startedAt: new Date(Date.now() - 12 * MINUTE).toISOString(), updatedAt: new Date().toISOString(), summary: null, href: null },
    { id: 'codex:wsl:c1', provider: 'codex', machine: 'wsl', sessionId: 'c1', title: '排查网络', directory: '~/projects/net', client: '终端', state: 'running', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), summary: null, href: '/work/native-net/s/c1' },
    { id: 'codex:windows:c2', provider: 'codex', machine: 'windows', sessionId: 'c2', title: '注册 API Key', directory: 'C:\\Users\\me\\ca', client: '桌面版', state: 'done', startedAt: null, updatedAt: new Date(Date.now() - 5 * MINUTE).toISOString(), summary: '已推送到 GitHub，未合并。', href: null },
  ],
};
const harnessTasks = vi.fn(() => json(HARNESS));
const launchWorkbench = vi.fn((_provider: string) => json({ url: '/work/bench?new=codex' }));
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
      projects: { list: () => json(PROJECTS), sessions: () => json([]), launchWorkbench: (provider: string) => launchWorkbench(provider) },
      harness: { tasks: () => harnessTasks() },
      workbench: { hubLinks: () => json([{ hubId: 'prof', projectId: 'native-prof' }]) },
      trading212: { status: () => json([{ env: 'live', configured: false, source: null }]) },
      quota: () => json([{ provider: 'claude', available: true, windows: [{ id: 'five_hour', label: '5 小时', usedPercent: 42, windowMinutes: 300, resetsAt: new Date(Date.now() + 7200000).toISOString() }], balances: [], source: 'statusline', observedAt: new Date().toISOString(), stale: false }]),
    },
    projectSessions: () => json({ sessions: [{ id: 's1', provider: 'claude', summary: '修复登录', lastActivity: new Date().toISOString() }] }),
    runningSessions: () => json({ success: true, data: { sessions: [] } }),
  },
}));

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const { StudioPage } = await import('@/modules/studio/StudioPage');

// Studio opens in Harness once per launch by default; most tests start on the home screen with that turned off.
beforeEach(() => { localStorage.clear(); localStorage.setItem('studio-harness-on-launch', 'off'); sessionStorage.clear(); conversations.mockClear(); });
afterEach(cleanup);

function renderStudio(path = '/') {
  render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/" element={<StudioPage />} />
    <Route path="/projects/:id" element={<StudioPage />} />
    <Route path="/apps/:app" element={<StudioPage />} />
  </Routes></MemoryRouter>);
}

test('projects appear as home tiles and open on one AI 助手 page holding agent sessions and project-scoped DeepSeek history', async () => {
  renderStudio();
  const apps = await screen.findByRole('navigation', { name: '应用' });
  expect(await within(apps).findByRole('button', { name: 'SNR 3.0，在线' })).toBeTruthy();

  fireEvent.click(within(apps).getByRole('button', { name: '超级教授' }));
  const professor = await screen.findByRole('region', { name: '超级教授' });
  const tabs = within(professor).getByRole('navigation', { name: '项目功能' });
  // DeepSeek is no separate tab: its conversations sit in AI 助手 with the Claude and Codex sessions.
  expect(within(tabs).getAllByRole('button').map(button => button.textContent)).toEqual(['AI 助手', '设置']);

  await waitFor(() => expect(conversations).toHaveBeenCalledWith('project:prof'));
  expect(await within(professor).findByText('课程大纲')).toBeTruthy();
  expect(await within(professor).findByText('修复登录')).toBeTruthy();
  expect(within(professor).queryByText('通用问题')).toBeNull();
  expect(within(professor).getByRole('link', { name: '打开网站：网站' }).getAttribute('href')).toBe('https://example.test/');
  expect(within(professor).getByRole('button', { name: /新建会话/ })).toBeTruthy();

  fireEvent.click(within(professor).getByRole('button', { name: '返回主屏幕' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: '超级教授' })).toBeNull());
  expect(screen.getByRole('navigation', { name: '应用' })).toBeTruthy();
});

test('an app opens from its icon as a zoom of the whole view (no launch logo) and shrinks back into it', async () => {
  renderStudio();
  const apps = await screen.findByRole('navigation', { name: '应用' });
  fireEvent.click(within(apps).getByRole('button', { name: '超级教授' }));
  const professor = await screen.findByRole('region', { name: '超级教授' });
  // The view itself grows out of the icon's centre while the home screen recedes behind it.
  expect(professor.classList.contains('opening')).toBe(true);
  expect(professor.style.getPropertyValue('--zoom-cx')).toMatch(/px$/);
  expect(document.querySelector('.studio')?.getAttribute('data-transition')).toBe('opening');
  expect(document.querySelector('.acs-star, .studio-app-launch')).toBeNull();
  expect(screen.queryByRole('status', { name: /正在打开/ })).toBeNull();
  expect(document.querySelector('.home-layer')?.classList.contains('is-covered')).toBe(false);
  await waitFor(() => expect(professor.classList.contains('opening')).toBe(false));
  expect(document.querySelector('.home-layer')?.classList.contains('is-covered')).toBe(true);
  expect(within(professor).getByRole('navigation', { name: '项目功能' })).toBeTruthy();

  // Back home: the view shrinks towards its icon as the home screen comes back, then goes.
  fireEvent.click(within(professor).getByRole('button', { name: '返回主屏幕' }));
  expect(professor.classList.contains('closing')).toBe(true);
  expect(document.querySelector('.home-layer')?.classList.contains('is-covered')).toBe(false);
  await waitFor(() => expect(screen.queryByRole('region', { name: '超级教授' })).toBeNull());
});

test('under reduced motion an app simply appears, with no zoom', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  try {
    renderStudio();
    const apps = await screen.findByRole('navigation', { name: '应用' });
    fireEvent.click(within(apps).getByRole('button', { name: '超级教授' }));
    const professor = await screen.findByRole('region', { name: '超级教授' });
    expect(professor.classList.contains('opening')).toBe(false);
    expect(document.querySelector('.studio')?.hasAttribute('data-transition')).toBe(false);
    expect(document.querySelector('.home-layer')?.classList.contains('is-covered')).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});

test('the gear in the home screen corner opens the settings app; AJ 出口 sits among the system tiles', async () => {
  renderStudio();
  const apps = await screen.findByRole('navigation', { name: '应用' });
  expect(within(apps).getByRole('button', { name: 'AJ 出口，未开启' })).toBeTruthy();
  fireEvent.click(screen.getByTitle('设置'));
  expect(await screen.findByRole('region', { name: '设置' })).toBeTruthy();
});

test('opening Studio lands in Harness once per launch: both agents\' tasks on WSL and Windows, and a new session with either', async () => {
  localStorage.removeItem('studio-harness-on-launch');
  renderStudio();
  const harness = await screen.findByRole('region', { name: 'Harness' });
  expect(await within(harness).findByText('2 个任务在跑 · WSL 1 · Windows 1')).toBeTruthy();
  const running = within(harness).getByRole('region', { name: '正在运行' });
  expect(within(running).getByText('v7 安全收尾')).toBeTruthy();
  expect(within(running).getByText('Claude Code · Windows · 桌面版')).toBeTruthy();
  expect(within(running).getByText('已运行 12 分钟')).toBeTruthy();
  // A WSL session Studio knows opens in the workbench; a Windows one is shown as it is.
  expect(within(running).getByRole('link', { name: /排查网络/ }).getAttribute('href')).toBe('/work/native-net/s/c1');
  expect(within(running).queryByRole('link', { name: /v7 安全收尾/ })).toBeNull();
  const recent = within(harness).getByRole('region', { name: '最近' });
  expect(within(recent).getByText('已推送到 GitHub，未合并。')).toBeTruthy();
  expect(within(recent).getByText('ca')).toBeTruthy();

  fireEvent.click(within(harness).getByRole('button', { name: /Codex/ }));
  await waitFor(() => expect(launchWorkbench).toHaveBeenCalledWith('codex'));
});

test('after launching into Harness, its back button reaches the home screen and stays there', async () => {
  localStorage.removeItem('studio-harness-on-launch');
  renderStudio();
  const harness = await screen.findByRole('region', { name: 'Harness' });
  fireEvent.click(within(harness).getByRole('button', { name: '返回主屏幕' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Harness' })).toBeNull());
  expect(screen.getByRole('navigation', { name: '应用' })).toBeTruthy();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(screen.queryByRole('region', { name: 'Harness' })).toBeNull();
});

test('Harness waits on the home screen as a spark tile when the device turns the launch off, and only the first launch redirects', async () => {
  renderStudio();
  const apps = await screen.findByRole('navigation', { name: '应用' });
  expect(screen.queryByRole('region', { name: 'Harness' })).toBeNull();
  const tile = within(apps).getByRole('button', { name: 'Harness' });
  expect(tile.querySelector('svg[data-icon="spark"]')).toBeTruthy();
  cleanup();

  // Turned on, but this launch already went through Harness (a reload or a later visit to the home screen).
  localStorage.removeItem('studio-harness-on-launch');
  sessionStorage.setItem('studio-harness-launched', '1');
  renderStudio();
  expect(await screen.findByRole('navigation', { name: '应用' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Harness' })).toBeNull();
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
