import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type * as ApiModule from '@/shared/api';
import type { StudioBuild, StudioHomeTile } from '@/shared/types';

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
const PROJECT = { id: 'water', name: '喝水打卡', description: '', workspacePath: '/home/me/projects/ai-app', modules: ['agents'], providers: ['claude', 'codex', 'deepseek'], tone: 'sage', glyph: 'sparkles', links: [], remoteHost: '', remoteDir: '', updatedAt: '1' };
const build = (patch: Partial<StudioBuild> = {}): StudioBuild => ({
  id: 'b1', hubProjectId: 'water', ideProjectId: 'ide-1', sessionId: 'session-1', workspacePath: '/home/me/projects/ai-app', state: 'building',
  total: 0, completed: 0, currentTask: null, createdAt: '2026-10-02T10:00:00.000Z', startedAt: '2026-10-02T10:00:00.000Z', finishedAt: null, error: null, ...patch,
});
const mocks = vi.hoisted(() => ({
  projects: [] as unknown[],
  builds: { list: vi.fn(), environment: vi.fn(), create: vi.fn(), resume: vi.fn(), cancel: vi.fn() },
}));

vi.mock('@/modules/auth', () => ({ useAuth: () => ({ user: { username: 'tester' }, logout: vi.fn() }) }));
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false, setThemeMode: vi.fn() }) }));
vi.mock('@/modules/studio/StudioFluidBackground', () => ({ StudioFluidBackground: () => null }));
vi.mock('@/modules/studio/StudioWidgets', () => ({ StudioWidgets: () => null }));
vi.mock('@/shared/api', async (original) => ({
  ...(await original<typeof ApiModule>()),
  api: {
    studio: {
      status: () => json({ deepseek: { configured: true, models: ['deepseek-flash'], baseUrl: 'https://api.deepseek.com' }, agentWorkbenchUrl: null, snrRemoteUrl: null }),
      snr: () => json({ connected: false }),
      conversations: () => json([]),
      closeSnr: () => json({}),
      projects: { list: () => json(mocks.projects), sessions: () => json([]) },
      remote: { hosts: () => json([]) },
      trading212: { status: () => json([]) },
      quota: () => json([]),
      builds: mocks.builds,
    },
  },
}));

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const { StudioPage } = await import('@/modules/studio/StudioPage');
const { StudioHomeScreen } = await import('@/modules/studio/StudioHomeScreen');

beforeEach(() => {
  localStorage.clear();
  mocks.projects = [];
  mocks.builds.list.mockImplementation(() => json([]));
  mocks.builds.environment.mockImplementation(() => json({ mode: 'sandbox', missing: [], available: true }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

// Stands in for the workbench and shows which of its routes matched, with the decoded parameters.
function WorkbenchProbe({ route }: { route: string }) {
  const { projectId = '', sessionId = '' } = useParams();
  return <div>{`workbench ${route} project=${projectId} session=${sessionId}`}</div>;
}

function renderStudio() {
  render(<MemoryRouter initialEntries={['/']}><Routes>
    <Route path="/" element={<StudioPage />} />
    <Route path="/projects/:id" element={<StudioPage />} />
    {/* The workbench's routes on feat/studio-v6 (src/App.tsx). */}
    <Route path="/work" element={<WorkbenchProbe route="home" />} />
    <Route path="/work/:projectId" element={<WorkbenchProbe route="project" />} />
    <Route path="/work/:projectId/s/:sessionId" element={<WorkbenchProbe route="session" />} />
    <Route path="/session/:sessionId" element={<WorkbenchProbe route="legacy" />} />
  </Routes></MemoryRouter>);
}

const homeTile = (patch: Partial<StudioHomeTile>): StudioHomeTile => ({ id: 'project:water', name: '喝水打卡', tone: 'sage', glyph: 'sparkles', ...patch });

function renderHome(tiles: StudioHomeTile[], onBuildAction = vi.fn()) {
  render(<MemoryRouter><Routes>
    <Route path="/" element={<StudioHomeScreen tiles={tiles} loading={false} covered={false} snr={null} onOpen={vi.fn()} onOpenWidget={vi.fn()} onOpenSettings={vi.fn()} onCreate={vi.fn()}
      onRefresh={vi.fn()} onSignOut={vi.fn()} refreshing={false} onBuildAction={onBuildAction} />} />
  </Routes></MemoryRouter>);
  return onBuildAction;
}

test('a building icon is a dimmed link to its live session with a ring and its progress in words', () => {
  renderHome([
    homeTile({ progress: { value: 0.42, state: 'building' }, href: '/work/ide-1/s/session-1' }),
    homeTile({ id: 'project:queued', name: '记账本', progress: { value: 0, state: 'queued', label: '排队中' }, href: '/work/ide-2/s/session-2' }),
    homeTile({ id: 'project:failed', name: '番茄钟', progress: { value: 0.5, state: 'failed', label: '未完成' }, href: '/work/ide-3/s/session-3' }),
  ]);
  const apps = screen.getByRole('navigation', { name: '应用' });
  const building = within(apps).getByRole('link', { name: '喝水打卡，开发中 42%' });
  expect(building.getAttribute('href')).toBe('/work/ide-1/s/session-1');
  expect(building.querySelector('.home-icon-wrap')?.getAttribute('data-build')).toBe('building');
  expect(building.querySelector('.build-ring-arc')).toBeTruthy();
  expect(within(apps).getByRole('link', { name: '记账本，排队中' }).querySelector('.build-overlay')?.getAttribute('data-state')).toBe('queued');
  const failed = within(apps).getByRole('link', { name: '番茄钟，未完成' });
  expect(failed.querySelector('.build-badge')).toBeTruthy();
  expect(failed.querySelector('.build-ring')).toBeNull();
});

test('edit mode stops a running build instead of hiding it and continues a failed one', () => {
  const onBuildAction = renderHome([
    homeTile({ progress: { value: 0.42, state: 'building' }, href: '/work/ide-1/s/session-1' }),
    homeTile({ id: 'project:failed', name: '番茄钟', progress: { value: 0.5, state: 'failed', label: '未完成' }, href: '/work/ide-3/s/session-3' }),
  ]);
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  expect(screen.queryByRole('button', { name: '从主屏幕隐藏 喝水打卡' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '停止开发 喝水打卡' }));
  expect(onBuildAction).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'project:water' }), 'stop');
  fireEvent.click(screen.getByRole('button', { name: '继续开发 番茄钟' }));
  expect(onBuildAction).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'project:failed' }), 'resume');
  expect(screen.getByRole('button', { name: '从主屏幕隐藏 番茄钟' })).toBeTruthy();
});

test('让 AI 开发 starts a build: the icon appears at once, fills as the plan advances and lights up when done', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  mocks.builds.create.mockImplementation(() => json({ build: build(), project: PROJECT }, 201));
  renderStudio();
  fireEvent.click(await screen.findByRole('button', { name: '新建项目' }));
  const sheet = await screen.findByRole('dialog', { name: '新建项目' });
  expect(within(sheet).getByRole('radio', { name: '让 AI 开发' }).getAttribute('aria-checked')).toBe('true');
  const start = await within(sheet).findByRole('button', { name: '开始开发' });
  expect((start as HTMLButtonElement).disabled).toBe(true);
  // The manual form stays mounted (hidden) beside this one, so fields are found by their accessible role.
  fireEvent.change(within(sheet).getByRole('textbox', { name: '名称' }), { target: { value: '喝水打卡' } });
  fireEvent.change(within(sheet).getByRole('textbox', { name: '想做什么' }), { target: { value: '记录每天喝水，能设目标' } });
  fireEvent.click(within(sheet).getByRole('radio', { name: '苔绿' }));
  fireEvent.click(start);

  await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建项目' })).toBeNull());
  expect(mocks.builds.create).toHaveBeenCalledWith({ name: '喝水打卡', tone: 'moss', glyph: 'sparkles', prompt: '记录每天喝水，能设目标' });
  // The sent draft is not offered again next time.
  expect(localStorage.getItem('studio-build-draft')).toBeNull();
  const apps = screen.getByRole('navigation', { name: '应用' });
  const tile = await within(apps).findByRole('link', { name: '喝水打卡，规划中' });
  expect(tile.getAttribute('href')).toBe('/work/ide-1/s/session-1');
  expect(await screen.findByText('「喝水打卡」开始开发')).toBeTruthy();

  mocks.projects = [PROJECT];
  mocks.builds.list.mockImplementation(() => json([build({ total: 4, completed: 2, currentTask: '正在写测试' })]));
  act(() => { vi.advanceTimersByTime(3000); });
  expect(await within(apps).findByRole('link', { name: '喝水打卡，开发中 63%' })).toBeTruthy();

  mocks.builds.list.mockImplementation(() => json([build({ state: 'done', total: 4, completed: 4, finishedAt: '2026-10-02T10:20:00.000Z' })]));
  act(() => { vi.advanceTimersByTime(3000); });
  expect(await screen.findByText('「喝水打卡」已开发完成')).toBeTruthy();
  expect(within(apps).getByRole('button', { name: '喝水打卡，已完成' }).querySelector('.build-overlay')?.getAttribute('data-state')).toBe('done');
  // After the light-up the icon is an ordinary app that zooms open, and polling has stopped.
  expect(await within(apps).findByRole('button', { name: '喝水打卡' }, { timeout: 3000 })).toBeTruthy();
  const polls = mocks.builds.list.mock.calls.length;
  act(() => { vi.advanceTimersByTime(9000); });
  expect(mocks.builds.list.mock.calls.length).toBe(polls);
});

test('an unsent description survives closing the sheet', async () => {
  mocks.builds.create.mockClear();
  renderStudio();
  fireEvent.click(await screen.findByRole('button', { name: '新建项目' }));
  let sheet = await screen.findByRole('dialog', { name: '新建项目' });
  fireEvent.change(await within(sheet).findByRole('textbox', { name: '想做什么' }), { target: { value: '一个番茄钟，25 分钟一轮' } });
  fireEvent.click(within(sheet).getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建项目' })).toBeNull());

  fireEvent.click(screen.getByRole('button', { name: '新建项目' }));
  sheet = await screen.findByRole('dialog', { name: '新建项目' });
  const prompt = await within(sheet).findByRole('textbox', { name: '想做什么' });
  expect((prompt as HTMLTextAreaElement).value).toBe('一个番茄钟，25 分钟一轮');
  expect(mocks.builds.create).not.toHaveBeenCalled();
});

test('a build that does not finish says so and offers to continue; the manual form is one tap away', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  mocks.projects = [PROJECT];
  mocks.builds.list.mockImplementation(() => json([build({ total: 3, completed: 1 })]));
  mocks.builds.resume.mockImplementation(() => json(build({ state: 'queued' })));
  renderStudio();
  const apps = await screen.findByRole('navigation', { name: '应用' });
  expect(await within(apps).findByRole('link', { name: '喝水打卡，开发中 33%' })).toBeTruthy();

  mocks.builds.list.mockImplementation(() => json([build({ state: 'failed', total: 3, completed: 1, error: 'Claude AI usage limit reached' })]));
  act(() => { vi.advanceTimersByTime(3000); });
  expect(await screen.findByText('「喝水打卡」没有完成')).toBeTruthy();
  expect(screen.getByText('Claude AI usage limit reached')).toBeTruthy();
  expect(within(apps).getByRole('link', { name: '喝水打卡，未完成' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '继续开发' }));
  await waitFor(() => expect(mocks.builds.resume).toHaveBeenCalledWith('b1'));
  expect(await within(apps).findByRole('link', { name: '喝水打卡，排队中' })).toBeTruthy();

  fireEvent.click(within(apps).getByRole('button', { name: '新建项目' }));
  const sheet = await screen.findByRole('dialog', { name: '新建项目' });
  fireEvent.click(within(sheet).getByRole('radio', { name: '手动创建' }));
  expect(await within(sheet).findByRole('button', { name: '创建项目' })).toBeTruthy();
});

test('stopping a build from edit mode asks first', async () => {
  mocks.projects = [PROJECT];
  mocks.builds.list.mockImplementation(() => json([build({ total: 2, completed: 1 })]));
  mocks.builds.cancel.mockImplementation(() => json(build({ state: 'failed', error: '已取消', total: 2, completed: 1 })));
  renderStudio();
  const apps = await screen.findByRole('navigation', { name: '应用' });
  await within(apps).findByRole('link', { name: '喝水打卡，开发中 50%' });
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  fireEvent.click(screen.getByRole('button', { name: '停止开发 喝水打卡' }));
  const alert = await screen.findByRole('alertdialog', { name: '停止开发「喝水打卡」？' });
  expect(mocks.builds.cancel).not.toHaveBeenCalled();
  fireEvent.click(within(alert).getByRole('button', { name: '停止' }));
  await waitFor(() => expect(mocks.builds.cancel).toHaveBeenCalledWith('b1'));
  expect(await screen.findByText('已停止开发「喝水打卡」')).toBeTruthy();
  expect(await within(apps).findByRole('link', { name: '喝水打卡，已停止' })).toBeTruthy();
});

test('tapping a building or failed icon opens its session on the workbench route (review medium: /work link)', async () => {
  mocks.projects = [PROJECT, { ...PROJECT, id: 'timer', name: '番茄钟' }];
  // Ids with characters a URL must escape still arrive intact.
  mocks.builds.list.mockImplementation(() => json([
    build({ ideProjectId: 'ide/1 a', sessionId: 'session#1', total: 2, completed: 1 }),
    build({ id: 'b2', hubProjectId: 'timer', ideProjectId: '', sessionId: 'session-2', state: 'failed', error: 'Claude AI usage limit reached' }),
  ]));
  renderStudio();
  const apps = await screen.findByRole('navigation', { name: '应用' });
  const failed = await within(apps).findByRole('link', { name: '番茄钟，未完成' });
  // A build without an IDE project id uses the legacy address the workbench redirects from.
  expect(failed.getAttribute('href')).toBe('/session/session-2');
  fireEvent.click(await within(apps).findByRole('link', { name: '喝水打卡，开发中 50%' }));
  expect(await screen.findByText('workbench session project=ide/1 a session=session#1')).toBeTruthy();
});

test('a slow poll that answers after 开始开发 keeps the new icon and its ring (review low: stale poll)', async () => {
  let answerFirstPoll: (response: Response) => void = () => {};
  mocks.builds.list.mockImplementationOnce(() => new Promise<Response>(resolve => { answerFirstPoll = resolve; }));
  mocks.builds.create.mockImplementation(() => json({ build: build(), project: PROJECT }, 201));
  renderStudio();
  fireEvent.click(await screen.findByRole('button', { name: '新建项目' }));
  const sheet = await screen.findByRole('dialog', { name: '新建项目' });
  fireEvent.change(within(sheet).getByRole('textbox', { name: '名称' }), { target: { value: '喝水打卡' } });
  fireEvent.change(within(sheet).getByRole('textbox', { name: '想做什么' }), { target: { value: '记录每天喝水' } });
  fireEvent.click(within(sheet).getByRole('button', { name: '开始开发' }));
  const apps = screen.getByRole('navigation', { name: '应用' });
  expect(await within(apps).findByRole('link', { name: '喝水打卡，规划中' })).toBeTruthy();

  // The poll sent on arrival, before the build existed, finally answers with an empty list.
  await act(async () => { answerFirstPoll(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })); });
  expect(within(apps).getByRole('link', { name: '喝水打卡，规划中' })).toBeTruthy();
});

test('the composer says plainly when builds are restricted and how to enable the sandbox', async () => {
  mocks.builds.environment.mockImplementation(() => json({ mode: 'restricted', missing: ['bubblewrap', 'socat'], available: false }));
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  renderStudio();
  fireEvent.click(await screen.findByRole('button', { name: '新建项目' }));
  const sheet = await screen.findByRole('dialog', { name: '新建项目' });
  const notice = await within(sheet).findByRole('note', { name: '受限模式' });
  expect(notice.textContent).toContain('不能安装依赖、运行代码或测试');
  expect(within(notice).getByText('sudo apt-get install -y bubblewrap socat')).toBeTruthy();
  fireEvent.click(within(notice).getByRole('button', { name: '复制命令' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('sudo apt-get install -y bubblewrap socat'));
  expect(await within(notice).findByRole('button', { name: '已复制' })).toBeTruthy();
  // Installing is not enough: the sandbox is turned on only after the checks.
  expect(notice.textContent).toContain('装好后按 docs/ai-builds.md 做一遍沙箱检查');
  expect(within(notice).getByText('STUDIO_BUILD_SANDBOX=on')).toBeTruthy();
  // Building is still possible, just limited.
  expect(within(sheet).getByRole('button', { name: '开始开发' })).toBeTruthy();
});

test('an installed but unverified sandbox stays off: the notice asks for the checks and the opt-in (review: opt-in sandbox)', async () => {
  mocks.builds.environment.mockImplementation(() => json({ mode: 'restricted', missing: [], available: true }));
  renderStudio();
  fireEvent.click(await screen.findByRole('button', { name: '新建项目' }));
  let sheet = await screen.findByRole('dialog', { name: '新建项目' });
  let notice = await within(sheet).findByRole('note', { name: '受限模式' });
  expect(notice.textContent).toContain('沙箱默认关闭，要先确认它在这台服务器上真的有效');
  expect(notice.textContent).toContain('不能安装依赖、运行代码或测试');
  expect(notice.textContent).toContain('读不到 ~/.ssh、写不了项目以外和 .git/hooks、连不上软件包仓库以外的网站');
  expect(within(notice).getByText('STUDIO_BUILD_SANDBOX=on')).toBeTruthy();
  expect(within(notice).queryByText('sudo apt-get install -y bubblewrap socat')).toBeNull();
  fireEvent.click(within(sheet).getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建项目' })).toBeNull());

  // A platform without a sandbox offers nothing to turn on.
  mocks.builds.environment.mockImplementation(() => json({ mode: 'restricted', missing: [], available: false }));
  fireEvent.click(screen.getByRole('button', { name: '新建项目' }));
  sheet = await screen.findByRole('dialog', { name: '新建项目' });
  notice = await within(sheet).findByRole('note', { name: '受限模式' });
  expect(notice.textContent).toContain('这台服务器不支持沙箱');
  expect(within(notice).queryByText('STUDIO_BUILD_SANDBOX=on')).toBeNull();
});

test('a sandboxed server promises installs and tests, and a server that cannot say makes no promise', async () => {
  renderStudio();
  fireEvent.click(await screen.findByRole('button', { name: '新建项目' }));
  let sheet = await screen.findByRole('dialog', { name: '新建项目' });
  expect(await within(sheet).findByText(/命令在沙箱里运行，只能写这个文件夹、只连软件包仓库/)).toBeTruthy();
  expect(within(sheet).queryByRole('note', { name: '受限模式' })).toBeNull();
  fireEvent.click(within(sheet).getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建项目' })).toBeNull());

  mocks.builds.environment.mockImplementation(() => json({ error: 'unavailable' }, 500));
  fireEvent.click(screen.getByRole('button', { name: '新建项目' }));
  sheet = await screen.findByRole('dialog', { name: '新建项目' });
  expect(await within(sheet).findByText(/它只在这个文件夹里工作，不会推送或发布/)).toBeTruthy();
  expect(within(sheet).queryByText(/沙箱/)).toBeNull();
});
