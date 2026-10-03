import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StudioProjectAgents } from '@/modules/studio/StudioProjectAgents';
import { StudioProjectEditor } from '@/modules/studio/StudioProjectEditor';
import type { HubProject } from '@/shared/types';

// The project mail tab (StudioProjectMail) is covered by StudioMail.test.tsx.
const mocks = vi.hoisted(() => ({
  api: { list: vi.fn(), create: vi.fn(), update: vi.fn(), launch: vi.fn(), launchRemote: vi.fn(), sessions: vi.fn() },
  remote: { hosts: vi.fn(), status: vi.fn() },
  workbench: { hubLinks: vi.fn() },
  conversations: vi.fn(),
  projectSessions: vi.fn(),
  runningSessions: vi.fn(),
  writeSelectedProvider: vi.fn(),
}));
vi.mock('@/shared/api', () => ({
  api: {
    studio: { projects: mocks.api, remote: mocks.remote, workbench: mocks.workbench, conversations: mocks.conversations },
    projectSessions: mocks.projectSessions,
    runningSessions: mocks.runningSessions,
  },
  readApiJson: async (response: Response) => {
    const value = await response.json();
    if (!response.ok) throw Error(value.error);
    return value;
  },
}));
vi.mock('@/shared/selectedProvider', () => ({ writeSelectedProvider: mocks.writeSelectedProvider }));
// The real terminal needs xterm and a websocket; the test only checks what it is asked to run.
vi.mock('@/modules/studio/StudioTerminalCover', () => ({
  default: (props: { mode: 'remote'; launch: { command: string; title: string }; hostLabel: string; onClose: () => void } | { mode: 'local'; project: { name: string; workspacePath: string }; onClose: () => void }) => props.mode === 'remote'
    ? <div role="dialog" aria-label={props.launch.title}>{props.hostLabel}: {props.launch.command}</div>
    : <div role="dialog" aria-label={`${props.project.name} 终端`}>shell in {props.project.workspacePath}<button type="button" onClick={props.onClose}>完成</button></div>,
}));

const project: HubProject = {
  id: 'professor', name: '超级教授', description: '', workspacePath: '/home/me/projects/professor',
  modules: ['agents', 'mail', 'automations'], providers: ['claude', 'codex', 'deepseek'], tone: 'clay', glyph: 'graduation', links: [], remoteHost: '', remoteDir: '', updatedAt: '',
};

afterEach(cleanup);

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function renderLanding(target: HubProject = project, openChat = vi.fn()) {
  render(<MemoryRouter initialEntries={['/projects/professor']}><Routes>
    <Route path="/projects/:id" element={<StudioProjectAgents project={target} onOpenChat={openChat} />} />
    <Route path="/work/:projectId" element={<div>Workbench new chat</div>} />
    <Route path="/work/:projectId/d/:conversationId" element={<div>Workbench DeepSeek conversation</div>} />
  </Routes></MemoryRouter>);
  return { openChat };
}

describe('Studio projects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.remote.hosts.mockImplementation(async () => Response.json([{ name: 'aj', label: 'AJ 服务器', target: 'sp-remote' }]));
    mocks.workbench.hubLinks.mockImplementation(async () => Response.json([{ hubId: 'professor', projectId: 'native' }]));
    // The directory's sessions as the workbench lists them; a Cursor one from before Cursor was hidden is among them.
    mocks.projectSessions.mockImplementation(async () => Response.json({ sessions: [
      { id: 's1', provider: 'claude', summary: '课程大纲', lastActivity: minutesAgo(60) },
      { id: 's2', provider: 'codex', summary: '修登录页', lastActivity: minutesAgo(5) },
      { id: 's3', provider: 'cursor', summary: '旧的 Cursor 会话', lastActivity: minutesAgo(1) },
    ] }));
    mocks.conversations.mockImplementation(async () => Response.json([{ id: 'c1', title: '招生文案', model: 'deepseek-flash', updated_at: minutesAgo(30) }]));
    mocks.runningSessions.mockImplementation(async () => Response.json({ success: true, data: { sessions: [{ sessionId: 's2' }] } }));
  });

  it('opens on running and earlier sessions: Claude, Codex and DeepSeek together, newest first, with official marks', async () => {
    renderLanding();
    const running = await screen.findByRole('region', { name: '正在运行的会话' });
    const live = await within(running).findByRole('link', { name: /修登录页/ });
    expect(live.getAttribute('href')).toBe('/work/native/s/s2');
    expect(live.textContent).toContain('运行中');
    expect(live.querySelector('svg[data-brand="openai"]')).toBeTruthy();

    const history = screen.getByRole('region', { name: '历史会话' });
    const rows = within(history).getAllByRole('link');
    expect(rows.map(row => row.querySelector('strong')?.textContent)).toEqual(['招生文案', '课程大纲']);
    expect(rows.map(row => row.getAttribute('href'))).toEqual(['/work/native/d/c1', '/work/native/s/s1']);
    expect(rows.map(row => row.querySelector('svg[data-brand]')?.getAttribute('data-brand'))).toEqual(['deepseek', 'claude']);
    expect(mocks.projectSessions).toHaveBeenCalledWith('native', { limit: 50, offset: 0 });
    expect(mocks.conversations).toHaveBeenCalledWith('project:professor');

    // No provider cards any more, and nothing of Cursor or OpenCode.
    expect(screen.queryByText('在本项目中开始')).toBeNull();
    expect(screen.queryByText(/Cursor|OpenCode/)).toBeNull();
  });

  it('新建会话 opens one new chat in the workbench, registering the directory first when needed', async () => {
    mocks.workbench.hubLinks.mockImplementation(async () => Response.json([{ hubId: 'professor', projectId: null }]));
    mocks.api.launch.mockResolvedValue(Response.json({ url: '/work/native' }));
    renderLanding();
    await screen.findByText('招生文案');
    // Without an IDE project there are no agent sessions yet, only the project's DeepSeek conversations.
    expect(mocks.projectSessions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /新建会话/ }));
    expect(await screen.findByText('Workbench new chat')).toBeTruthy();
    // No provider: the chat opens with the device's last choice, and its model menu picks Claude, Codex or DeepSeek.
    expect(mocks.api.launch).toHaveBeenCalledWith('professor');
  });

  it('a DeepSeek conversation of a directory not yet in the workbench opens there after registering it', async () => {
    mocks.workbench.hubLinks.mockImplementation(async () => Response.json([{ hubId: 'professor', projectId: null }]));
    mocks.api.launch.mockResolvedValue(Response.json({ url: '/work/native' }));
    renderLanding();
    fireEvent.click(await screen.findByRole('button', { name: /招生文案/ }));
    expect(await screen.findByText('Workbench DeepSeek conversation')).toBeTruthy();
  });

  it('shows the product website first, opening it and its other pages in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderLanding({ ...project, links: [{ label: '超级教授', url: 'https://professor.example/' }, { label: '登录', url: 'https://professor.example/login' }] });
    const site = screen.getByRole('link', { name: '打开网站：超级教授' });
    expect(site.getAttribute('href')).toBe('https://professor.example/');
    expect(site.getAttribute('target')).toBe('_blank');
    expect(screen.getByText('professor.example')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开网站：登录' }));
    expect(open).toHaveBeenCalledWith('https://professor.example/login', '_blank', 'noopener,noreferrer');
    open.mockRestore();
    await screen.findByText('招生文案');
  });

  it('without a directory, 新建对话 and the DeepSeek history open the project chat; no shell is offered', async () => {
    const { openChat } = renderLanding({ ...project, workspacePath: '' });
    expect(await screen.findByText(/填写项目目录/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /终端/ })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /招生文案/ }));
    expect(openChat).toHaveBeenLastCalledWith('c1');
    fireEvent.click(screen.getByRole('button', { name: /新建对话/ }));
    expect(openChat).toHaveBeenLastCalledWith();
    expect(mocks.api.launch).not.toHaveBeenCalled();
    expect(mocks.projectSessions).not.toHaveBeenCalled();
  });

  it('opens a full-screen shell on this computer in the project directory', async () => {
    render(<MemoryRouter><StudioProjectAgents project={project} onOpenChat={vi.fn()} /></MemoryRouter>);
    await screen.findByText('课程大纲');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /终端/ }));
    const terminal = await screen.findByRole('dialog', { name: '超级教授 终端' });
    expect(terminal.textContent).toContain('shell in /home/me/projects/professor');
    // A local shell is not an agent launch and not a remote session.
    expect(mocks.api.launch).not.toHaveBeenCalled();
    expect(mocks.api.launchRemote).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('persists modules, models and icon only when explicitly saved', async () => {
    mocks.api.update.mockResolvedValue(Response.json({ ...project, modules: ['agents', 'automations'] }));
    const saved = vi.fn();
    render(<StudioProjectEditor project={project} onSaved={saved} />);
    fireEvent.click(screen.getByRole('switch', { name: '邮箱' }));
    fireEvent.click(screen.getByRole('radio', { name: '苔绿' }));
    expect(mocks.api.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存项目' }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(mocks.api.update.mock.calls[0][1]).toMatchObject({ modules: ['agents', 'automations'], tone: 'moss' });
  });

  it('moves a project to a configured SSH host and saves its website links', async () => {
    mocks.api.update.mockImplementation(async (_id: string, input: object) => Response.json({ ...project, ...input }));
    const saved = vi.fn();
    render(<StudioProjectEditor project={project} onSaved={saved} />);
    fireEvent.click(await screen.findByRole('radio', { name: 'AJ 服务器' }));
    expect(screen.queryByLabelText('目录')).toBeNull();
    fireEvent.change(screen.getByLabelText('远程目录'), { target: { value: '~/projects/super-professor' } });
    fireEvent.click(screen.getByRole('button', { name: '添加网站' }));
    fireEvent.change(screen.getByRole('textbox', { name: '网站 1 名称' }), { target: { value: '网站' } });
    fireEvent.change(screen.getByRole('textbox', { name: '网站 1 地址' }), { target: { value: 'https://example.test/' } });
    fireEvent.click(screen.getByRole('button', { name: '保存项目' }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(mocks.api.update.mock.calls[0][1]).toMatchObject({ remoteHost: 'aj', remoteDir: '~/projects/super-professor', links: [{ label: '网站', url: 'https://example.test/' }] });
  });

  it('moving a remote project back to this computer drops its hidden remote directory', async () => {
    mocks.api.update.mockImplementation(async (_id: string, input: object) => Response.json({ ...project, ...input }));
    const saved = vi.fn();
    render(<StudioProjectEditor project={{ ...project, remoteHost: 'aj', remoteDir: '~/projects/super-professor' }} onSaved={saved} />);
    fireEvent.click(await screen.findByRole('radio', { name: '本机' }));
    fireEvent.click(screen.getByRole('button', { name: '保存项目' }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(mocks.api.update.mock.calls[0][1]).toMatchObject({ remoteHost: '', remoteDir: '' });
  });

  it('runs agents on the remote host only when the host has them installed', async () => {
    mocks.remote.status.mockResolvedValue(Response.json({ name: 'aj', online: true, latencyMs: 42, checkedAt: '', tools: { claude: true, codex: false, tmux: true } }));
    mocks.api.launchRemote.mockResolvedValue(Response.json({ command: 'ssh sp-remote tmux new-session -A', title: 'Claude Code · AJ 服务器' }));
    render(<MemoryRouter><StudioProjectAgents project={{ ...project, remoteHost: 'aj', remoteDir: '~/projects/super-professor' }} onOpenChat={vi.fn()} /></MemoryRouter>);
    expect(await screen.findByText('在线 · 42 ms')).toBeTruthy();
    expect(mocks.projectSessions).not.toHaveBeenCalled();
    // Its DeepSeek conversations stay reachable below the host's agents.
    expect(await screen.findByText('招生文案')).toBeTruthy();
    const codex = screen.getByRole('button', { name: /Codex/ }) as HTMLButtonElement;
    expect(codex.disabled).toBe(true);
    expect(codex.textContent).toContain('未安装');
    fireEvent.click(screen.getByRole('button', { name: /Claude Code/ }));
    const terminal = await screen.findByRole('dialog', { name: 'Claude Code · AJ 服务器' });
    expect(terminal.textContent).toContain('ssh sp-remote tmux new-session -A');
    expect(mocks.api.launchRemote).toHaveBeenCalledWith('professor', 'claude');
  });
});
