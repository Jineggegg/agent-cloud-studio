import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StudioProjectAgents } from '@/modules/studio/StudioProjectAgents';
import { StudioProjectEditor } from '@/modules/studio/StudioProjectEditor';
import type { HubProject } from '@/shared/types';

// The project mail tab (StudioProjectMail) is covered by StudioMail.test.tsx.
const mocks = vi.hoisted(() => ({
  api: { list: vi.fn(), create: vi.fn(), update: vi.fn(), launch: vi.fn(), launchRemote: vi.fn(), sessions: vi.fn() },
  remote: { hosts: vi.fn(), status: vi.fn() },
  writeSelectedProvider: vi.fn(),
}));
vi.mock('@/shared/api', () => ({
  api: { studio: { projects: mocks.api, remote: mocks.remote } },
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

describe('Studio projects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.sessions.mockResolvedValue(Response.json([{ id: 's1', provider: 'claude', title: '课程大纲' }]));
    mocks.remote.hosts.mockImplementation(async () => Response.json([{ name: 'aj', label: 'AJ 服务器', target: 'sp-remote' }]));
  });

  it('starts an agent inside the project directory and chooses its provider before the IDE mounts', async () => {
    mocks.api.launch.mockResolvedValue(Response.json({ url: '/workspace?projectId=native&provider=codex' }));
    const openChat = vi.fn();
    render(<MemoryRouter initialEntries={['/projects/professor']}><Routes>
      <Route path="/projects/:id" element={<StudioProjectAgents project={project} onOpenChat={openChat} />} />
      <Route path="/workspace" element={<div>IDE opened</div>} />
    </Routes></MemoryRouter>);
    expect(await screen.findByText('课程大纲')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Cursor/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /DeepSeek/ }));
    expect(openChat).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }));
    expect(await screen.findByText('IDE opened')).toBeTruthy();
    expect(mocks.api.launch).toHaveBeenCalledWith('professor', 'codex');
    expect(mocks.writeSelectedProvider).toHaveBeenCalledWith('codex');
  });

  it('agents stay disabled until the project has a directory', async () => {
    render(<MemoryRouter><StudioProjectAgents project={{ ...project, workspacePath: '' }} onOpenChat={vi.fn()} /></MemoryRouter>);
    expect((await screen.findByRole('button', { name: /Claude Code/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/填写项目目录/)).toBeTruthy();
    // Without a directory there is nowhere to open a shell either.
    expect(screen.queryByRole('button', { name: /终端/ })).toBeNull();
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
    expect(mocks.api.sessions).not.toHaveBeenCalled();
    const codex = screen.getByRole('button', { name: /Codex/ }) as HTMLButtonElement;
    expect(codex.disabled).toBe(true);
    expect(codex.textContent).toContain('未安装');
    fireEvent.click(screen.getByRole('button', { name: /Claude Code/ }));
    const terminal = await screen.findByRole('dialog', { name: 'Claude Code · AJ 服务器' });
    expect(terminal.textContent).toContain('ssh sp-remote tmux new-session -A');
    expect(mocks.api.launchRemote).toHaveBeenCalledWith('professor', 'claude');
  });
});
