import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LazyMotion, domMax } from 'motion/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';

// Type-only, so it is erased before vi.mock's hoisted factory runs.
import type * as SharedApi from '@/shared/api';
import type { ServerEvent, WorkbenchChatChrome, WorkbenchChatProps } from '@/shared/types';
import { installPointerEvent, swipe } from '@/modules/workbench/tests/swipeTestHelpers';

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
// A conversation handed from Claude Code (修复登录) to Codex (重构侧栏) and on to DeepSeek (课程大纲).
const CHAIN = {
  id: 't1', projectId: 'p1', title: '登录与侧栏', createdAt: iso(3_600_000), updatedAt: iso(30_000),
  segments: [
    { kind: 'agent' as const, provider: 'claude' as const, sessionId: 's1', modelLabel: 'Opus', handoffAt: null },
    { kind: 'agent' as const, provider: 'codex' as const, sessionId: 's2', modelLabel: 'GPT-5.5', handoffAt: iso(600_000) },
    { kind: 'deepseek' as const, provider: 'deepseek' as const, sessionId: 'c1', modelLabel: 'deepseek-chat', handoffAt: iso(300_000) },
  ],
};
const mocks = vi.hoisted(() => ({
  projects: vi.fn(),
  deleteProject: vi.fn(),
  restoreProject: vi.fn(),
  projectSessions: vi.fn(),
  sessionDetails: vi.fn(),
  deleteSession: vi.fn(),
  restoreSession: vi.fn(),
  renameSession: vi.fn(),
  conversations: vi.fn(),
  removeConversation: vi.fn(),
  threads: vi.fn(),
  renameThread: vi.fn(),
  removeThread: vi.fn(),
  quota: vi.fn(),
  activity: vi.fn(),
  sent: [] as unknown[],
  listeners: [] as ((event: ServerEvent) => void)[],
  busy: new Set<string>(),
  chatMounts: 0,
  toast: vi.fn(),
  toastError: vi.fn(),
}));
// One stable function, like the real context's, so the presence report is not re-sent on every render.
const mockSendMessage = vi.hoisted(() => (message: unknown) => { mocks.sent.push(message); return true; });
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

vi.mock('@/shared/api', async original => ({
  ...(await original<typeof SharedApi>()),
  api: {
    projects: () => mocks.projects(),
    deleteProject: (...args: unknown[]) => mocks.deleteProject(...args),
    restoreProject: (id: string) => mocks.restoreProject(id),
    projectSessions: (...args: unknown[]) => mocks.projectSessions(...args),
    sessionDetails: (id: string) => mocks.sessionDetails(id),
    deleteSession: (...args: unknown[]) => mocks.deleteSession(...args),
    restoreSession: (id: string) => mocks.restoreSession(id),
    renameSession: (...args: unknown[]) => mocks.renameSession(...args),
    getFiles: () => json([]),
    studio: {
      projects: { list: () => json(HUBS) },
      workbench: {
        hubLinks: () => json([{ hubId: 'professor', projectId: 'p1' }]),
        activity: () => mocks.activity(),
        threads: (projectId: string) => mocks.threads(projectId),
        renameThread: (...args: unknown[]) => mocks.renameThread(...args),
        removeThread: (id: string) => mocks.removeThread(id),
      },
      conversations: (space: string) => mocks.conversations(space),
      conversation: () => json({ error: 'missing' }, 404),
      removeConversation: (id: string) => mocks.removeConversation(id),
      quota: () => mocks.quota(),
    },
  },
}));
// jsdom never upgrades NumberFlow's custom element, so a figure that changes (剩余 → 已用) would throw there.
vi.mock('@number-flow/react', () => ({
  default: ({ value, suffix = '' }: { value: number; suffix?: string }) => <span>{`${value}${suffix}`}</span>,
}));
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({
    subscribe: (listener: (event: ServerEvent) => void) => { mocks.listeners.push(listener); return () => { mocks.listeners = mocks.listeners.filter(item => item !== listener); }; },
    sendMessage: mockSendMessage,
    isConnected: true,
  }),
}));
vi.mock('@/shared/context/SessionProtectionContext', () => ({ useBusySessionIdSet: () => mocks.busy }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOpsRegister: () => {} }));
vi.mock('sonner', () => ({
  toast: Object.assign((...args: unknown[]) => mocks.toast(...args), { error: (...args: unknown[]) => mocks.toastError(...args) }),
}));
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
  StudioBrandMark: ({ brand }: { brand: string }) => <svg data-brand={brand} />,
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
        <span data-testid="chat-thread">{props.thread ? props.thread.segments.map(segment => segment.sessionId).join(',') : 'none'}</span>
        <button type="button" onClick={() => {
          // A handoff from the open session: the next provider's session is created, then the chain is recorded.
          const created = { id: 's4', kind: 'agent' as const, provider: 'codex' as const, title: '接着修登录', updatedAt: new Date().toISOString() };
          props.onSessionCreated(created);
          props.onThreadChange?.({
            id: 't9', projectId: 'p1', title: '修复登录', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            segments: [
              { kind: 'agent', provider: 'claude', sessionId: 's1', modelLabel: 'Opus', handoffAt: null },
              { kind: 'agent', provider: 'codex', sessionId: 's4', modelLabel: 'GPT-5.5', handoffAt: new Date().toISOString() },
            ],
          });
        }}>hand off</button>
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

beforeAll(installPointerEvent);

beforeEach(() => {
  localStorage.clear();
  mocks.listeners = [];
  mocks.sent = [];
  mocks.activity.mockImplementation(() => json({ projects: {} }));
  mocks.busy = new Set();
  mocks.chatMounts = 0;
  mocks.toast.mockClear();
  mocks.toastError.mockClear();
  // The server's project list: archiving or deleting takes a project out of it, restoring puts it back.
  let projectRows = [...PROJECTS];
  mocks.projects.mockImplementation(() => json(projectRows));
  mocks.deleteProject.mockImplementation((id: string) => { projectRows = projectRows.filter(row => row.projectId !== id); return json({ success: true }); });
  mocks.restoreProject.mockImplementation((id: string) => {
    projectRows = PROJECTS.filter(row => row.projectId === id || projectRows.includes(row));
    return json({ success: true, data: { projectId: id, isArchived: false } });
  });
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
  mocks.removeConversation.mockImplementation(() => json({ deleted: true }));
  mocks.threads.mockImplementation(() => json([]));
  mocks.renameThread.mockImplementation((id: string, title: string) => json({ ...CHAIN, id, title }));
  mocks.removeThread.mockImplementation(() => json({ ok: true }));
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

test('a conversation handed between providers is one history row with the latest provider and opens whole', async () => {
  mocks.threads.mockImplementation(() => json([CHAIN]));
  renderShell('/work/p1/d/c1');
  const history = await screen.findByRole('navigation', { name: '会话历史' });
  const chain = await within(history).findByRole('link', { name: '登录与侧栏，DeepSeek，交接过 2 次' });
  expect(chain.getAttribute('href')).toBe('/work/p1/d/c1');
  expect(chain.querySelector('[data-provider]')?.getAttribute('data-provider')).toBe('deepseek');
  // Its sessions are not listed on their own; the unrelated one is.
  expect(within(history).queryByRole('link', { name: /修复登录/ })).toBeNull();
  expect(within(history).queryByRole('link', { name: /重构侧栏/ })).toBeNull();
  expect(within(history).getByRole('link', { name: /整理旧接口/ })).toBeTruthy();
  expect(mocks.threads).toHaveBeenCalledWith('p1');
  // The chat gets the latest session under the conversation's title, with the whole chain.
  await waitFor(() => expect(chatState()).toBe('p1|deepseek:c1:登录与侧栏|deepseek|professor'));
  expect(screen.getByTestId('chat-thread').textContent).toBe('s1,s2,c1');
});

test('a handoff from the chat moves to the new session without remounting it and folds the history into one row', async () => {
  renderShell('/work/p1/s/s1');
  await waitFor(() => expect(chatState()).toBe('p1|agent:s1:修复登录|claude|professor'));
  expect(mocks.chatMounts).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'hand off' }));
  await waitFor(() => expect(location()).toBe('/work/p1/s/s4'));
  expect(mocks.chatMounts).toBe(1);
  await waitFor(() => expect(chatState()).toBe('p1|agent:s4:修复登录|codex|professor'));
  expect(screen.getByTestId('chat-thread').textContent).toBe('s1,s4');
  const history = screen.getByRole('navigation', { name: '会话历史' });
  expect(within(history).getByRole('link', { name: '修复登录，Codex，交接过 1 次' }).getAttribute('aria-current')).toBe('page');
  expect(within(history).queryByRole('link', { name: /接着修登录/ })).toBeNull();
});

test('a handed-over conversation is renamed as a whole and deleted with every session it went through', async () => {
  mocks.threads.mockImplementation(() => json([CHAIN]));
  renderShell('/work/p1');
  const history = await screen.findByRole('navigation', { name: '会话历史' });
  await within(history).findByRole('link', { name: /登录与侧栏/ });

  fireEvent.click(screen.getByRole('button', { name: '「登录与侧栏」的更多操作' }));
  // A chain with a DeepSeek conversation in it cannot be archived.
  expect(screen.queryByRole('menuitem', { name: '归档' })).toBeNull();
  fireEvent.click(await screen.findByRole('menuitem', { name: '重命名' }));
  const field = screen.getByRole('textbox', { name: '会话名称' });
  fireEvent.change(field, { target: { value: '登录、侧栏和大纲' } });
  fireEvent.submit(field.closest('form')!);
  await waitFor(() => expect(mocks.renameThread).toHaveBeenCalledWith('t1', '登录、侧栏和大纲'));
  expect(mocks.renameSession).not.toHaveBeenCalled();
  const renamed = await within(history).findByRole('link', { name: /登录、侧栏和大纲/ });

  fireEvent.click(screen.getByRole('button', { name: '「登录、侧栏和大纲」的更多操作' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: '删除' }));
  const confirm = screen.getByRole('alertdialog', { name: '删除这段对话？' });
  fireEvent.click(within(confirm).getByRole('button', { name: '删除' }));
  await waitFor(() => expect(mocks.removeThread).toHaveBeenCalledWith('t1'));
  expect(mocks.deleteSession).toHaveBeenCalledWith('s1', true);
  expect(mocks.deleteSession).toHaveBeenCalledWith('s2', true);
  expect(mocks.removeConversation).toHaveBeenCalledWith('c1');
  await waitFor(() => expect(renamed.isConnected).toBe(false));
  expect(within(history).getByRole('link', { name: /整理旧接口/ })).toBeTruthy();
});

test('the usage panel shows what is left by default, flips to 已用 everywhere, folds, and opens Studio Settings', async () => {
  renderShell('/work/p1');
  const panel = await screen.findByRole('region', { name: '模型用量' });
  const session = await within(panel).findByTitle(/^Claude 5 小时 剩余 58%，2 小时 1[1-4] 分后重置$/);
  expect(within(session).getByText(/2 小时 1[1-4] 分后重置/)).toBeTruthy();
  // 93 % used leaves 7 %: still drawn in the warning colour.
  const weekly = within(panel).getByTitle(/^Claude 每周 剩余 7%，/);
  expect(weekly.getAttribute('data-high')).toBe('true');
  expect(within(panel).getByText('未接入')).toBeTruthy();
  expect(within(panel).getByText(/12\.30/)).toBeTruthy();
  expect(within(panel).queryByText('可能过期')).toBeNull();

  fireEvent.click(within(panel).getByRole('radio', { name: '已用' }));
  expect(within(panel).getByTitle(/^Claude 5 小时 已用 42%，/)).toBeTruthy();
  expect(JSON.parse(localStorage.getItem('studio-quota-display-v1') ?? '{}').mode).toBe('used');

  const fold = within(panel).getByRole('button', { name: /用量/ });
  expect(fold.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(fold);
  expect(fold.getAttribute('aria-expanded')).toBe('false');
  expect(within(panel).queryByTitle(/Claude 每周/)).toBeNull();
  expect(within(fold).getByText('5 小时 42%')).toBeTruthy();
  expect(localStorage.getItem('workbench-quota-collapsed')).toBe('1');

  fireEvent.click(within(panel).getByRole('button', { name: '额度显示设置' }));
  expect(await screen.findByText('studio settings')).toBeTruthy();
});

test('the usage panel shows only the items switched on, flags stale readings and lists per-model windows when chosen', async () => {
  localStorage.setItem('studio-quota-display-v1', JSON.stringify({
    mode: 'remaining', items: { 'claude:window:five_hour': false, 'claude:window:seven_day_opus': true, 'claude:credit:cinder_cove': true, 'deepseek:balance': false },
  }));
  mocks.quota.mockImplementation(() => json([
    { provider: 'claude', available: true, windows: [
      { id: 'five_hour', label: '5 小时', usedPercent: 9, windowMinutes: 300, resetsAt: null },
      { id: 'seven_day', label: '每周', usedPercent: 4.4, windowMinutes: 10080, resetsAt: null },
      { id: 'seven_day_opus', label: '每周 · Opus', usedPercent: 9.6, windowMinutes: 10080, resetsAt: null, model: 'Opus' },
      { id: 'seven_day_sonnet', label: '每周 · Sonnet', usedPercent: 1, windowMinutes: 10080, resetsAt: null, model: 'Sonnet' },
    ], credits: [
      { id: 'cinder_cove', label: '云端额度', usedPercent: 8.4, currency: 'USD', limit: 250, used: 21, remaining: 229, endsAt: null, endKind: 'expires' },
    ], balances: [], source: 'usage-api', observedAt: iso(0), stale: true },
    { provider: 'codex', available: true, windows: [
      { id: 'codex:secondary', label: '每周', usedPercent: 29, windowMinutes: 10080, resetsAt: null },
      { id: 'gpt-reserve:secondary', label: '每周 · GPT Reserve', usedPercent: 0, windowMinutes: 10080, resetsAt: null, model: 'GPT Reserve' },
    ], balances: [], source: 'official', observedAt: iso(0), stale: false },
    { provider: 'deepseek', available: true, windows: [], balances: [{ currency: 'CNY', total: 253.99, granted: 0, toppedUp: 253.99 }], source: 'official', observedAt: iso(0), stale: false },
  ]));
  renderShell('/work/p1');
  const panel = await screen.findByRole('region', { name: '模型用量' });
  await within(panel).findByTitle(/^Claude 每周 剩余 96%/);
  expect(within(panel).getByTitle(/^Claude 每周 · Opus 剩余 90%/)).toBeTruthy();
  expect(within(panel).getByTitle(/^Claude 云端额度 剩余 92%，剩余 \$229 \/ \$250/)).toBeTruthy();
  expect(within(panel).getByText('剩余 $229 / $250')).toBeTruthy();
  expect(within(panel).getByTitle(/^Codex 每周 剩余 71%/)).toBeTruthy();
  for (const hidden of [/Claude 5 小时/, /Sonnet/, /GPT Reserve/, /DeepSeek/]) expect(within(panel).queryByTitle(hidden)).toBeNull();
  expect(within(panel).queryByText(/DeepSeek/)).toBeNull();
  // The Claude reading is stale: its rows are dimmed and the header says so.
  expect(within(panel).getByTitle(/^Claude 每周 剩余 96%/).getAttribute('data-stale')).toBe('true');
  expect(within(panel).getByTitle(/^Codex 每周/).getAttribute('data-stale')).toBeNull();
  expect(within(panel).getByText('可能过期')).toBeTruthy();
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

test('opened from inside a Studio app, the sidebar back returns to that app; the grid button still goes home', async () => {
  const appPath = '/projects/professor?tab=ai';
  const fromApp = { studioReturn: { path: appPath, title: '超级教授' } };
  function HowArrived() {
    return <output data-testid="arrived">{useNavigationType()}</output>;
  }
  const renderFromApp = (entry: { pathname: string; search?: string }) => render(<LazyMotion features={domMax} strict>
    <MemoryRouter initialEntries={['/', appPath, { ...entry, state: fromApp }]} initialIndex={2}>
      <Routes>
        {['/work/:projectId', '/work/:projectId/s/:sessionId'].map(route => <Route key={route} path={route} element={<WorkbenchShell />} />)}
        <Route path="/projects/:id" element={<div>studio app</div>} />
        <Route path="/" element={<div>studio home</div>} />
      </Routes>
      <Location /><HowArrived />
    </MemoryRouter></LazyMotion>);

  // 新建会话: the new chat becomes a session (a replace that keeps the note), and back steps back to the app.
  renderFromApp({ pathname: '/work/p1', search: '?new=codex' });
  await waitFor(() => expect(chatState()).toBe('p1|new|codex|professor'));
  fireEvent.click(screen.getByRole('button', { name: 'create session' }));
  await waitFor(() => expect(location()).toBe('/work/p1/s/created-1'));
  fireEvent.click(screen.getByRole('button', { name: '返回 超级教授' }));
  await waitFor(() => expect(location()).toBe(appPath));
  expect(screen.getByTestId('arrived').textContent).toBe('POP');
  cleanup();

  // After moving to another session here, back still returns to the app (opening it again).
  renderFromApp({ pathname: '/work/p1/s/s2' });
  await waitFor(() => expect(chatState()).toContain('agent:s2'));
  fireEvent.click(screen.getByRole('link', { name: /修复登录/ }));
  await waitFor(() => expect(chatState()).toContain('agent:s1'));
  fireEvent.click(screen.getByRole('button', { name: '返回 超级教授' }));
  await waitFor(() => expect(location()).toBe(appPath));
  expect(screen.getByTestId('arrived').textContent).toBe('PUSH');
  cleanup();

  // The separate grid button (sidebar hidden) goes straight home.
  renderFromApp({ pathname: '/work/p1/s/s1' });
  await waitFor(() => expect(chatState()).toContain('agent:s1'));
  fireEvent.keyDown(window, { key: '\\', ctrlKey: true });
  fireEvent.click(await within(screen.getByTestId('chat-header')).findByRole('button', { name: '返回 Studio 主屏幕' }));
  await waitFor(() => expect(location()).toBe('/'));
});

test('opened from the home screen, the sidebar back goes home', async () => {
  renderShell('/work/p1/s/s1');
  await waitFor(() => expect(chatState()).toContain('agent:s1'));
  fireEvent.click(screen.getByRole('button', { name: '返回 Studio 主屏幕' }));
  await waitFor(() => expect(location()).toBe('/'));
});

test('Cursor and OpenCode are hidden: their links open the default agent and the menu never offers them', async () => {
  renderShell('/work/p1?new=cursor');
  await waitFor(() => expect(chatState()).toBe('p1|new|claude|professor'));
  fireEvent.click(screen.getByRole('button', { name: '新会话' }));
  const menu = await screen.findByRole('menu', { name: '选择助手' });
  expect(within(menu).getAllByRole('menuitem').map(item => item.querySelector('strong')?.firstChild?.textContent)).toEqual(['Claude Code', 'Codex', 'DeepSeek']);
  // Each row carries the provider's official mark.
  expect(Array.from(menu.querySelectorAll('svg[data-brand]')).map(mark => mark.getAttribute('data-brand'))).toEqual(['claude', 'openai', 'deepseek']);
  cleanup();
  renderShell('/work/p2?new=opencode');
  await waitFor(() => expect(chatState()).toBe('p2|new|claude|null'));
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

test('archiving the open project from the switcher moves to the next one, and 撤销 brings back the project and the session', async () => {
  renderShell('/work/p1/s/s1');
  await waitFor(() => expect(chatState()).toContain('agent:s1'));
  fireEvent.click(screen.getByRole('button', { name: '当前项目：超级教授，切换项目' }));
  const popover = await screen.findByRole('dialog', { name: '切换项目' });
  // Names only: no directory path anywhere in the trigger or the list.
  expect(document.body.textContent).not.toContain('/home/me');

  swipe(within(popover).getByRole('button', { name: '超级教授' }), { dx: -160 });
  fireEvent.click(within(popover).getByRole('button', { name: '归档' }));
  await waitFor(() => expect(mocks.deleteProject).toHaveBeenCalledWith('p1'));
  await waitFor(() => expect(location()).toBe('/work/p2'));
  // The switcher stays open on the new current project while the archived row leaves.
  await waitFor(() => expect(within(popover).queryByRole('button', { name: '超级教授' })).toBeNull());
  expect(popover.isConnected).toBe(true);
  expect(within(popover).getByRole('button', { name: 'snr3-lab' }).getAttribute('aria-current')).toBe('true');

  expect(mocks.toast).toHaveBeenCalledWith('已归档「超级教授」', expect.objectContaining({ action: expect.objectContaining({ label: '撤销' }) }));
  const [, options] = mocks.toast.mock.calls[0] as [string, { action: { onClick: () => void } }];
  act(() => options.action.onClick());
  await waitFor(() => expect(mocks.restoreProject).toHaveBeenCalledWith('p1'));
  await waitFor(() => expect(location()).toBe('/work/p1/s/s1'));
  expect(await within(popover).findByRole('button', { name: '超级教授' })).toBeTruthy();
});

test('deleting a project from the switcher asks first, then deletes it for good', async () => {
  renderShell('/work/p1');
  await waitFor(() => expect(chatState()).toBe('p1|new|claude|professor'));
  fireEvent.click(screen.getByRole('button', { name: '当前项目：超级教授，切换项目' }));
  const popover = await screen.findByRole('dialog', { name: '切换项目' });

  swipe(within(popover).getByRole('button', { name: 'snr3-lab' }), { dx: -160 });
  fireEvent.click(within(popover).getByRole('button', { name: '删除' }));
  const confirm = screen.getByRole('alertdialog', { name: '删除「snr3-lab」？' });
  expect(mocks.deleteProject).not.toHaveBeenCalled();
  fireEvent.click(within(confirm).getByRole('button', { name: '取消' }));
  expect(mocks.deleteProject).not.toHaveBeenCalled();

  fireEvent.click(within(popover).getByRole('button', { name: '「snr3-lab」的更多操作' }));
  fireEvent.click(within(popover).getByRole('button', { name: '删除' }));
  fireEvent.click(within(screen.getByRole('alertdialog', { name: '删除「snr3-lab」？' })).getByRole('button', { name: '删除' }));
  await waitFor(() => expect(mocks.deleteProject).toHaveBeenCalledWith('p2', true));
  await waitFor(() => expect(within(popover).queryByRole('button', { name: 'snr3-lab' })).toBeNull());
  // Another project went; the open one stays.
  expect(location()).toBe('/work/p1');
  expect(mocks.toast).toHaveBeenCalledWith('已删除「snr3-lab」');
});

test('a history row swipes to the same archive and delete as its menu; DeepSeek rows only delete', async () => {
  renderShell('/work/p1');
  const history = await screen.findByRole('navigation', { name: '会话历史' });
  const row = await within(history).findByRole('link', { name: /修复登录/ });

  swipe(within(history).getByRole('link', { name: /课程大纲/ }), { dx: -160 });
  expect(within(history).queryByRole('button', { name: '归档' })).toBeNull();
  expect(within(history).getByRole('button', { name: '删除' })).toBeTruthy();

  swipe(row, { dx: -160, pointerType: 'mouse' });
  // The click that ends a mouse swipe does not open the session.
  fireEvent.click(row);
  expect(location()).toBe('/work/p1');
  fireEvent.click(within(history).getByRole('button', { name: '删除' }));
  fireEvent.click(within(screen.getByRole('alertdialog', { name: '删除这个会话？' })).getByRole('button', { name: '删除' }));
  await waitFor(() => expect(mocks.deleteSession).toHaveBeenCalledWith('s1', true));

  swipe(within(history).getByRole('link', { name: /重构侧栏/ }), { dx: -160 });
  fireEvent.click(within(history).getByRole('button', { name: '归档' }));
  await waitFor(() => expect(mocks.deleteSession).toHaveBeenCalledWith('s2', false));
  await waitFor(() => expect(within(history).queryByRole('link', { name: /重构侧栏/ })).toBeNull());
});

test('sessions that finish or ask for permission while another is open get a red dot until opened, also on the hidden history button', async () => {
  mocks.busy = new Set(['s2']);
  renderShell('/work/p1/s/s1');
  const history = await screen.findByRole('navigation', { name: '会话历史' });
  await within(history).findByRole('link', { name: '重构侧栏，Codex，运行中' });

  // s2's run ends (the busy set changes on the next render) and s3 asks for permission; the open s1 asking does not count.
  mocks.busy = new Set();
  act(() => mocks.listeners.forEach(listener => listener({ kind: 'permission_request', sessionId: 's3', requestId: 'r1' })));
  act(() => mocks.listeners.forEach(listener => listener({ kind: 'permission_request', sessionId: 's1', requestId: 'r2' })));
  const finished = await within(history).findByRole('link', { name: '重构侧栏，Codex，需要查看' });
  expect(finished.closest('li')?.getAttribute('data-attention')).toBe('true');
  expect(within(history).getByRole('link', { name: '整理旧接口，Claude Code，需要查看' })).toBeTruthy();
  expect(within(history).getByRole('link', { name: '修复登录，Claude Code' }).closest('li')?.getAttribute('data-attention')).toBeNull();
  expect(JSON.parse(localStorage.getItem('acs-workbench-attention-v1') ?? '[]')).toEqual(expect.arrayContaining(['s2', 's3']));

  // With the history hidden, its button carries the dot.
  fireEvent.keyDown(window, { key: '\\', ctrlKey: true });
  fireEvent.click(await screen.findByRole('button', { name: '显示会话列表，有会话需要查看' }));

  // Opening a session clears its dot; the other stays.
  fireEvent.click(await within(history).findByRole('link', { name: /重构侧栏/ }));
  await waitFor(() => expect(location()).toBe('/work/p1/s/s2'));
  expect(within(history).getByRole('link', { name: '重构侧栏，Codex' })).toBeTruthy();
  expect(within(history).getByRole('link', { name: '整理旧接口，Claude Code，需要查看' })).toBeTruthy();
});

test('leaving the workbench gives the tab back the app title', async () => {
  renderShell('/work/p1/s/s1');
  await waitFor(() => expect(document.title).toBe('修复登录 · 超级教授'));
  cleanup();
  expect(document.title).toBe('Agent Cloud Studio');
});

test('the page tells the server which conversation is on screen, and again when another one opens', async () => {
  renderShell('/work/p1/s/s1');
  const history = await screen.findByRole('navigation', { name: '会话历史' });
  const visible = document.visibilityState === 'visible';
  await waitFor(() => expect(mocks.sent).toContainEqual({ type: 'workbench.presence', sessionIds: ['s1'], visible }));

  fireEvent.click(await within(history).findByRole('link', { name: /重构侧栏/ }));
  await waitFor(() => expect(mocks.sent.at(-1)).toEqual({ type: 'workbench.presence', sessionIds: ['s2'], visible }));
  cleanup();
  // Leaving the workbench clears the report.
  expect(mocks.sent.at(-1)).toEqual({ type: 'workbench.presence', sessionIds: [], visible: false });
});

test('the switcher shows the server\'s activity live, and this project\'s sessions that need the owner get their dot', async () => {
  mocks.activity.mockImplementation(() => json({ projects: {
    p1: { running: 0, attention: 1, attentionSessionIds: ['s3'] },
    p2: { running: 1, attention: 0, attentionSessionIds: [] },
  } }));
  renderShell('/work/p1/s/s1');
  const history = await screen.findByRole('navigation', { name: '会话历史' });
  // A failed run in s3 (perhaps on another device) dots its row; the closed switcher marks the other running project.
  expect(await within(history).findByRole('link', { name: '整理旧接口，Claude Code，需要查看' })).toBeTruthy();
  expect(await screen.findByTestId('switcher-running')).toBeTruthy();
  expect(screen.getByRole('button', { name: '当前项目：超级教授，切换项目（其他项目：1 个正在运行）' })).toBeTruthy();

  // A workbench_activity frame makes the page read again: snr3-lab now waits for an approval.
  mocks.activity.mockImplementation(() => json({ projects: { p2: { running: 1, attention: 1, attentionSessionIds: ['x1'] } } }));
  act(() => mocks.listeners.forEach(listener => listener({ kind: 'workbench_activity' })));
  expect(await screen.findByTestId('switcher-attention')).toBeTruthy();
  await waitFor(() => expect(within(history).getByRole('link', { name: '整理旧接口，Claude Code' })).toBeTruthy());

  fireEvent.click(screen.getByRole('button', { name: /^当前项目：超级教授，切换项目/ }));
  const popover = screen.getByRole('dialog', { name: '切换项目' });
  const snr = within(popover).getByRole('button', { name: 'snr3-lab，正在运行，需要你处理' });
  expect(within(snr).getByTestId('project-running')).toBeTruthy();
  expect(within(snr).getByTestId('project-attention')).toBeTruthy();
});
