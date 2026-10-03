import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LazyMotion, domMax } from 'motion/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// Type-only, so it is erased before vi.mock's hoisted factory runs.
import type * as SharedApi from '@/shared/api';
import type { ServerEvent, WorkbenchChatChrome, WorkbenchChatProps } from '@/shared/types';

// Fakes for every external service: the workbench only talks to these through @/shared/api and the websocket.
const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW - offsetMs).toISOString();
// Noon of the previous local calendar day: always 昨天, whatever time of day the suite runs (1.2 days ago is not,
// before about 05:00).
const YESTERDAY_NOON = (() => { const day = new Date(NOW); day.setHours(0, 0, 0, 0); return new Date(day.getTime() - 12 * 3_600_000).toISOString(); })();
const PROJECTS = [
  { projectId: 'p1', displayName: 'professor-app', fullPath: '/home/me/projects/professor', path: '/home/me/projects/professor', isStarred: false, sessions: [] },
  { projectId: 'p2', displayName: 'snr3-lab', fullPath: '/home/me/projects/snr3-lab', path: '/home/me/projects/snr3-lab', isStarred: false, sessions: [] },
];
const HUBS = [{
  id: 'professor', name: '超级教授', tone: 'clay', glyph: 'graduation', workspacePath: '/home/me/projects/professor', remoteHost: '',
  providers: ['claude', 'codex', 'cursor', 'deepseek'],
}];
const mocks = vi.hoisted(() => ({
  projectSessions: vi.fn(),
  sessionDetails: vi.fn(),
  deleteSession: vi.fn(),
  restoreSession: vi.fn(),
  renameSession: vi.fn(),
  conversations: vi.fn(),
  quota: vi.fn(),
  listeners: [] as ((event: ServerEvent) => void)[],
  busy: new Set<string>(),
  chatMounts: 0,
  toastError: vi.fn(),
}));
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

vi.mock('@/shared/api', async original => ({
  ...(await original<typeof SharedApi>()),
  api: {
    projects: () => json(PROJECTS),
    projectSessions: (...args: unknown[]) => mocks.projectSessions(...args),
    sessionDetails: (id: string) => mocks.sessionDetails(id),
    deleteSession: (...args: unknown[]) => mocks.deleteSession(...args),
    restoreSession: (id: string) => mocks.restoreSession(id),
    renameSession: (...args: unknown[]) => mocks.renameSession(...args),
    getFiles: () => json([]),
    studio: {
      projects: { list: () => json(HUBS) },
      workbench: { hubLinks: () => json([{ hubId: 'professor', projectId: 'p1' }]) },
      conversations: (space: string) => mocks.conversations(space),
      conversation: () => json({ error: 'missing' }, 404),
      removeConversation: () => json({ deleted: true }),
      quota: () => mocks.quota(),
    },
  },
}));
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: (listener: (event: ServerEvent) => void) => { mocks.listeners.push(listener); return () => { mocks.listeners = mocks.listeners.filter(item => item !== listener); }; } }),
}));
vi.mock('@/shared/context/SessionProtectionContext', () => ({ useBusySessionIdSet: () => mocks.busy }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOpsRegister: () => {} }));
vi.mock('sonner', () => ({ toast: Object.assign(() => undefined, { error: (...args: unknown[]) => mocks.toastError(...args) }) }));
vi.mock('@/modules/code-editor', () => ({
  useEditorSidebar: () => ({ editingFile: null, handleFileOpen: vi.fn(), handleCloseEditor: vi.fn(), handleUnsavedChangesChange: vi.fn() }),
  CodeEditor: () => null,
}));
vi.mock('@/modules/file-tree', () => ({ FileTree: () => <div>file tree</div> }));
vi.mock('@/modules/git-panel', () => ({ GitPanel: () => <div>git panel</div> }));
vi.mock('@/modules/standalone-shell', () => ({
  StandaloneShell: ({ onUrlDetected }: { onUrlDetected: (url: string) => void }) => <div>terminal
    <button type="button" onClick={() => {
      onUrlDetected('https://github.com/acme/repo');
      onUrlDetected('http://localhost:5173/');
      // The server glues a following prompt line onto an address that ends a line.
      onUrlDetected('http://localhost:5173/me@laptop:/home/me/projects/professor$');
    }}>print urls</button></div>,
}));
vi.mock('@/modules/studio', () => ({
  StudioSpinner: ({ label }: { label?: string }) => <span role={label ? 'status' : undefined}>{label}</span>,
  StudioTileIcon: () => <span />,
  StudioConfirmSheet: ({ title, confirmLabel, onConfirm, onCancel }: { title: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void }) =>
    <div role="alertdialog" aria-label={title}><button type="button" onClick={onCancel}>取消</button><button type="button" onClick={onConfirm}>{confirmLabel}</button></div>,
}));
// The chat column has its own tests; this stand-in shows what the shell hands it, including the title-bar chrome
// it renders in its header (the shell's controls, the project name and the provider callback).
vi.mock('@/modules/workbench/chat/WorkbenchChat', async () => {
  const { useEffect } = await import('react');
  return {
    WorkbenchChat: (props: WorkbenchChatProps & { chrome?: WorkbenchChatChrome }) => {
      useEffect(() => { mocks.chatMounts += 1; }, []);
      return <section aria-label="chat">
        <header data-testid="chat-header">{props.chrome?.leading}<span>{props.chrome?.projectName}</span>{props.chrome?.trailing}</header>
        <span data-testid="chat-state">{`${props.project.projectId}|${props.session ? `${props.session.kind}:${props.session.id}:${props.session.title}` : 'new'}|${props.provider}|${props.hubProjectId}`}</span>
        <button type="button" onClick={() => props.onSessionCreated({ id: 'created-1', kind: 'agent', provider: 'codex', title: '新建的会话', updatedAt: new Date().toISOString() })}>create session</button>
        <button type="button" onClick={() => props.chrome?.onProviderChange?.('codex')}>switch to codex</button>
      </section>;
    },
  };
});

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
const { WorkbenchShell } = await import('@/modules/workbench/WorkbenchShell');

function Location() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderShell(path: string) {
  return render(<LazyMotion features={domMax} strict><MemoryRouter initialEntries={[path]}>
    <Routes>
      {['/work', '/work/:projectId', '/work/:projectId/s/:sessionId', '/work/:projectId/d/:conversationId'].map(route =>
        <Route key={route} path={route} element={<WorkbenchShell />} />)}
      <Route path="/apps/:app" element={<div>studio settings</div>} />
      <Route path="/" element={<div>studio home</div>} />
    </Routes>
    <Location />
  </MemoryRouter></LazyMotion>);
}

const location = () => screen.getByTestId('location').textContent;
const chatState = () => screen.getByTestId('chat-state').textContent;

beforeEach(() => {
  localStorage.clear();
  mocks.listeners = [];
  mocks.busy = new Set();
  mocks.chatMounts = 0;
  mocks.toastError.mockClear();
  mocks.projectSessions.mockImplementation((projectId: string) => json(projectId === 'p1' ? {
    projectId,
    sessions: [
      { id: 's1', provider: 'claude', summary: '修复登录', lastActivity: iso(60_000) },
      { id: 's2', provider: 'codex', summary: '重构侧栏', lastActivity: YESTERDAY_NOON },
      { id: 's3', provider: 'claude', summary: '整理旧接口', lastActivity: iso(86_400_000 * 40) },
    ],
    sessionMeta: { hasMore: false, total: 3 },
  } : { projectId, sessions: [], sessionMeta: { hasMore: false, total: 0 } }));
  mocks.conversations.mockImplementation(() => json([{ id: 'c1', title: '课程大纲', model: 'deepseek-chat', updated_at: iso(120_000) }]));
  mocks.sessionDetails.mockImplementation((id: string) => (id === 'outside'
    ? json({ success: true, data: { sessionId: 'outside', provider: 'codex', summary: '早期会话', lastActivity: iso(86_400_000 * 90), project: { projectId: 'p1' } } })
    : json({ success: false, error: { code: 'SESSION_NOT_FOUND', message: 'not found' } }, 404)));
  mocks.deleteSession.mockImplementation(() => json({ success: true }));
  mocks.restoreSession.mockImplementation(() => json({ success: true }));
  mocks.renameSession.mockImplementation(() => json({ success: true }));
  mocks.quota.mockImplementation(() => json([
    { provider: 'claude', available: true, windows: [
      { id: 'five_hour', label: '5 小时', usedPercent: 42, windowMinutes: 300, resetsAt: new Date(NOW + 2 * 3_600_000 + 13 * 60_000).toISOString() },
      { id: 'seven_day', label: '每周', usedPercent: 93, windowMinutes: 10080, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
    ], balances: [], source: 'statusline', observedAt: iso(0), stale: false },
    { provider: 'codex', available: false, windows: [], balances: [], source: 'unavailable', observedAt: null, stale: false },
    { provider: 'deepseek', available: true, windows: [], balances: [{ currency: 'CNY', total: 12.3, granted: 0, toppedUp: 12.3 }], source: 'official', observedAt: iso(0), stale: false },
  ]));
});
afterEach(cleanup);

test('/work keeps a requested agent, and DeepSeek in a directory without a hub project starts Claude Code', async () => {
  renderShell('/work?new=codex');
  await waitFor(() => expect(location()).toBe('/work/p1?new=codex'));
  cleanup();
  renderShell('/work/p2?new=deepseek');
  await waitFor(() => expect(chatState()).toBe('p2|new|claude|null'));
});

test('/work opens the project used last on this device, or the first one', async () => {
  renderShell('/work');
  await waitFor(() => expect(location()).toBe('/work/p1'));
  cleanup();
  localStorage.setItem('acs-workbench-last-project', 'p2');
  renderShell('/work');
  await waitFor(() => expect(location()).toBe('/work/p2'));
});

test('a new chat gets the project, the matching hub project and the provider from ?new=', async () => {
  renderShell('/work/p1?new=codex');
  await waitFor(() => expect(chatState()).toBe('p1|new|codex|professor'));
  // The hub project's name replaces the IDE folder name in the switcher.
  expect(screen.getByRole('button', { name: '当前项目：超级教授，切换项目' })).toBeTruthy();
});

test('history is grouped by day, includes the DeepSeek space and filters with the search field', async () => {
  renderShell('/work/p1');
  const history = await screen.findByRole('navigation', { name: '会话历史' });
  await within(history).findByRole('link', { name: /修复登录/ });
  expect(within(history).getAllByRole('heading').map(heading => heading.textContent)).toEqual(['今天', '昨天', '更早']);
  const today = within(history).getByRole('region', { name: '今天' });
  expect(within(today).getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(['/work/p1/s/s1', '/work/p1/d/c1']);
  expect(mocks.conversations).toHaveBeenCalledWith('project:professor');

  fireEvent.change(screen.getByRole('searchbox', { name: '搜索会话' }), { target: { value: '侧栏' } });
  expect(within(history).getAllByRole('link').map(link => link.textContent)).toEqual([expect.stringContaining('重构侧栏')]);
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索会话' }), { target: { value: '没有这个' } });
  expect(within(history).getByText(/没有标题包含「没有这个」的会话/)).toBeTruthy();
  fireEvent.click(within(history).getByRole('button', { name: '清除搜索' }));
  expect(within(history).getAllByRole('link')).toHaveLength(4);
});

test('running sessions are marked from the busy set and new sessions arrive over the websocket', async () => {
  mocks.busy = new Set(['s2']);
  renderShell('/work/p1');
  const running = await screen.findByRole('link', { name: '重构侧栏，Codex，运行中' });
  expect(running.closest('li')?.getAttribute('data-running')).toBe('true');
  expect(screen.getByRole('link', { name: '修复登录，Claude Code' }).closest('li')?.getAttribute('data-running')).toBeNull();

  act(() => mocks.listeners.forEach(listener => listener({
    kind: 'session_upserted', sessionId: 's9', provider: 'codex',
    session: { id: 's9', summary: '从终端开始的会话', lastActivity: new Date().toISOString() }, project: { projectId: 'p1' },
  })));
  expect(await screen.findByRole('link', { name: /从终端开始的会话/ })).toBeTruthy();
  // Frames for other projects are ignored.
  act(() => mocks.listeners.forEach(listener => listener({ kind: 'session_upserted', sessionId: 'x', session: { id: 'x', summary: '别的项目' }, project: { projectId: 'p2' } })));
  expect(screen.queryByText('别的项目')).toBeNull();
});

test('a session URL hands the chat its row, and one outside the loaded history is fetched', async () => {
  renderShell('/work/p1/s/s2');
  await waitFor(() => expect(chatState()).toBe('p1|agent:s2:重构侧栏|codex|professor'));
  expect(screen.getByRole('link', { name: /重构侧栏/ }).getAttribute('aria-current')).toBe('page');
  cleanup();
  renderShell('/work/p1/s/outside');
  await waitFor(() => expect(chatState()).toBe('p1|agent:outside:早期会话|codex|professor'));
  cleanup();
  renderShell('/work/p1/s/ghost');
  expect(await screen.findByRole('heading', { name: '这个会话已不存在' })).toBeTruthy();
});

test('a new chat that becomes a session moves to its URL without remounting the chat', async () => {
  renderShell('/work/p1?new=codex');
  await waitFor(() => expect(chatState()).toBe('p1|new|codex|professor'));
  expect(mocks.chatMounts).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'create session' }));
  await waitFor(() => expect(location()).toBe('/work/p1/s/created-1'));
  expect(chatState()).toBe('p1|agent:created-1:新建的会话|codex|professor');
  expect(mocks.chatMounts).toBe(1);
  expect(screen.getByRole('link', { name: /新建的会话/ }).getAttribute('aria-current')).toBe('page');
  // Opening another session does start a fresh chat view.
  fireEvent.click(screen.getByRole('link', { name: /修复登录/ }));
  await waitFor(() => expect(chatState()).toBe('p1|agent:s1:修复登录|claude|professor'));
  expect(mocks.chatMounts).toBe(2);
});

test('the new-session menu starts a chat with the chosen agent and remembers it', async () => {
  renderShell('/work/p1/s/s1');
  await waitFor(() => expect(chatState()).toContain('agent:s1'));
  fireEvent.click(screen.getByRole('button', { name: '新会话' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /DeepSeek/ }));
  await waitFor(() => expect(location()).toBe('/work/p1?new=deepseek'));
  expect(chatState()).toBe('p1|new|deepseek|professor');
  expect(localStorage.getItem('acs-workbench-last-provider')).toBe('deepseek');
});

test('deleting asks first and archiving removes the row; both leave an open session', async () => {
  renderShell('/work/p1/s/s1');
  await screen.findByRole('link', { name: /修复登录/ });
  fireEvent.click(screen.getByRole('button', { name: '「修复登录」的更多操作' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: '删除' }));
  const confirm = screen.getByRole('alertdialog', { name: '删除这个会话？' });
  expect(mocks.deleteSession).not.toHaveBeenCalled();
  fireEvent.click(within(confirm).getByRole('button', { name: '删除' }));
  await waitFor(() => expect(mocks.deleteSession).toHaveBeenCalledWith('s1', true));
  await waitFor(() => expect(location()).toBe('/work/p1'));
  await waitFor(() => expect(screen.queryByRole('link', { name: /修复登录/ })).toBeNull());

  fireEvent.click(screen.getByRole('button', { name: '「重构侧栏」的更多操作' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: '归档' }));
  await waitFor(() => expect(mocks.deleteSession).toHaveBeenCalledWith('s2', false));
  await waitFor(() => expect(screen.queryByRole('link', { name: /重构侧栏/ })).toBeNull());
});

test('quota bars show the Claude windows with their reset countdown and open Studio Settings', async () => {
  renderShell('/work/p1');
  const quota = await screen.findByRole('button', { name: '模型额度，打开设置' });
  await within(quota).findByTitle(/Claude 5 小时 已用 42%，2小时1[34]分后重置/);
  const weekly = within(quota).getByTitle(/Claude 每周 已用 93%/);
  expect(weekly.getAttribute('data-high')).toBe('true');
  expect(within(quota).getByText('未接入')).toBeTruthy();
  expect(within(quota).getByText(/12\.30/)).toBeTruthy();
  fireEvent.click(quota);
  expect(await screen.findByText('studio settings')).toBeTruthy();
});

test('the inspector opens on a tool, toggles with ⌘J, remembers itself and collects preview addresses', async () => {
  renderShell('/work/p1');
  await screen.findByRole('link', { name: /修复登录/ });
  // A closed inspector is inert, which also hides it from role queries.
  const inspector = document.querySelector<HTMLElement>('aside.wb-inspector[aria-label="检查器"]')!;
  expect(inspector.getAttribute('data-open')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: '终端' }));
  expect(inspector.getAttribute('data-open')).toBe('true');
  expect(within(inspector).getByRole('tab', { name: /终端/ }).getAttribute('aria-selected')).toBe('true');
  expect(within(inspector).getByText('terminal')).toBeTruthy();
  expect(JSON.parse(localStorage.getItem('acs-workbench-layout-v1') ?? '{}')).toMatchObject({ inspectorOpen: true, inspectorTab: 'terminal' });

  // Only dev-server-like addresses become previews.
  fireEvent.click(within(inspector).getByRole('button', { name: 'print urls' }));
  fireEvent.click(within(inspector).getByRole('tab', { name: /预览/ }));
  expect(within(inspector).getByRole('button', { name: 'localhost:5173' })).toBeTruthy();
  expect(within(inspector).queryByRole('button', { name: /github/ })).toBeNull();
  expect(within(inspector).getByTitle('网页预览：localhost:5173').getAttribute('src')).toBe('http://localhost:5173/');
  expect(within(inspector).getAllByRole('button', { name: /localhost/ })).toHaveLength(1);
  // A reload does not replay the terminal, so the project's addresses are remembered on this device.
  expect(JSON.parse(localStorage.getItem('acs-workbench-preview:p1') ?? '[]')).toEqual(['http://localhost:5173/']);

  fireEvent.keyDown(window, { key: 'j', metaKey: true });
  expect(inspector.getAttribute('data-open')).toBeNull();
  fireEvent.keyDown(window, { key: 'j', metaKey: true });
  expect(inspector.getAttribute('data-open')).toBe('true');
  // The terminal stayed mounted while hidden.
  expect(within(inspector).getByText('terminal')).toBeTruthy();
});

test('keyboard shortcuts toggle the sidebar and focus the session search', async () => {
  renderShell('/work/p1');
  await screen.findByRole('link', { name: /修复登录/ });
  fireEvent.keyDown(window, { key: '\\', ctrlKey: true });
  await waitFor(() => expect(screen.getByRole('button', { name: '显示会话列表' })).toBeTruthy());
  vi.useFakeTimers();
  try {
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    act(() => { vi.advanceTimersByTime(100); });
  } finally {
    vi.useRealTimers();
  }
  expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: '搜索会话' }));
  expect(screen.queryByRole('button', { name: '显示会话列表' })).toBeNull();
});

test('an unknown project shows a recoverable state', async () => {
  renderShell('/work/nope');
  expect(await screen.findByRole('heading', { name: '找不到这个项目' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '打开最近的项目' }));
  await waitFor(() => expect(location()).toBe('/work/p1'));
});

test('the chat header is the only title bar: it carries the shell controls, and the shell bar returns without a chat', async () => {
  renderShell('/work/p1/s/s1');
  await waitFor(() => expect(chatState()).toContain('agent:s1'));
  expect(document.querySelector('.wb-bar')).toBeNull();
  const header = screen.getByTestId('chat-header');
  expect(within(header).getByText('超级教授')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: '终端' })).toHaveLength(1);
  expect(within(header).getByRole('button', { name: '终端' })).toBeTruthy();
  // With the sidebar hidden, its toggle and the way home move into the same bar.
  fireEvent.keyDown(window, { key: '\\', ctrlKey: true });
  await waitFor(() => expect(within(header).getByRole('button', { name: '显示会话列表' })).toBeTruthy());
  expect(within(header).getByRole('button', { name: '返回 Studio 主屏幕' })).toBeTruthy();
  cleanup();
  // No chat (a session that is gone): the shell's own bar is back with the same controls.
  renderShell('/work/p1/s/ghost');
  expect(await screen.findByRole('heading', { name: '这个会话已不存在' })).toBeTruthy();
  expect(document.querySelector('.wb-bar')).not.toBeNull();
  expect(screen.getAllByRole('button', { name: '终端' })).toHaveLength(1);
});

test('Cursor and OpenCode launches open a chat with that agent, and the menu offers what the project enables', async () => {
  renderShell('/work/p1?new=cursor');
  await waitFor(() => expect(chatState()).toBe('p1|new|cursor|professor'));
  fireEvent.click(screen.getByRole('button', { name: '新会话' }));
  const menu = await screen.findByRole('menu', { name: '选择助手' });
  expect(within(menu).getAllByRole('menuitem').map(item => item.querySelector('strong')?.firstChild?.textContent)).toEqual(['Claude Code', 'Codex', 'DeepSeek', 'Cursor']);
  cleanup();
  renderShell('/work/p2?new=opencode');
  await waitFor(() => expect(chatState()).toBe('p2|new|opencode|null'));
});

test('DeepSeek is offered but disabled in a directory without a Studio project, with the reason', async () => {
  renderShell('/work/p2');
  await waitFor(() => expect(chatState()).toBe('p2|new|claude|null'));
  fireEvent.click(screen.getByRole('button', { name: '新会话' }));
  const deepseek = await screen.findByRole('menuitem', { name: /DeepSeek/ });
  expect(deepseek.getAttribute('aria-disabled')).toBe('true');
  expect(within(deepseek).getByText('需先在 Studio 中建立此项目')).toBeTruthy();
  fireEvent.click(deepseek);
  expect(location()).toBe('/work/p2');
});

test('a provider switched in the chat header is remembered and kept in the URL without remounting the chat', async () => {
  renderShell('/work/p1?new=claude');
  await waitFor(() => expect(chatState()).toBe('p1|new|claude|professor'));
  fireEvent.click(screen.getByRole('button', { name: 'switch to codex' }));
  await waitFor(() => expect(location()).toBe('/work/p1?new=codex'));
  expect(chatState()).toBe('p1|new|codex|professor');
  expect(localStorage.getItem('acs-workbench-last-provider')).toBe('codex');
  expect(mocks.chatMounts).toBe(1);
});

test('a session link naming the wrong project moves to the right one and opens there', async () => {
  // "outside" belongs to p1 and is not in its first history page.
  renderShell('/work/p2/s/outside');
  await waitFor(() => expect(location()).toBe('/work/p1/s/outside'));
  await waitFor(() => expect(chatState()).toBe('p1|agent:outside:早期会话|codex|professor'));
  expect(screen.queryByRole('heading', { name: '这个会话已不存在' })).toBeNull();
});

test('an older page that fails to load says so and keeps the button for a retry', async () => {
  mocks.projectSessions.mockImplementation((projectId: string, page: { offset: number }) => (page.offset === 0
    ? json({ projectId, sessions: [{ id: 's1', provider: 'claude', summary: '修复登录', lastActivity: iso(60_000) }], sessionMeta: { hasMore: true } })
    : json({ error: 'boom' }, 500)));
  renderShell('/work/p1');
  fireEvent.click(await screen.findByRole('button', { name: '显示更早的会话' }));
  await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('更早的会话加载失败（500）'));
  expect(await screen.findByRole('button', { name: '显示更早的会话' })).toBeTruthy();
});

test('the workbench follows the iOS soft keyboard through the visual viewport', async () => {
  const viewport = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0, scale: 1 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  try {
    renderShell('/work/p1');
    await waitFor(() => expect(chatState()).toBe('p1|new|claude|professor'));
    const root = document.documentElement.style;
    expect(root.getPropertyValue('--keyboard-height')).toBe('0px');
    // The keyboard takes 320px and Safari pans the page up by 40px to reveal the composer.
    act(() => {
      viewport.height = window.innerHeight - 320;
      viewport.offsetTop = 40;
      viewport.dispatchEvent(new Event('resize'));
    });
    expect(root.getPropertyValue('--keyboard-height')).toBe('280px');
    expect(root.getPropertyValue('--viewport-offset-top')).toBe('40px');
    cleanup();
    expect(root.getPropertyValue('--keyboard-height')).toBe('');
  } finally {
    Reflect.deleteProperty(window, 'visualViewport');
  }
});

test('leaving the workbench gives the tab back the app title', async () => {
  renderShell('/work/p1/s/s1');
  await waitFor(() => expect(document.title).toBe('修复登录 · 超级教授'));
  cleanup();
  expect(document.title).toBe('Agent Cloud Studio');
});
