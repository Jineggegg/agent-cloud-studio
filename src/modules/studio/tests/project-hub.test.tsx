import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StudioProjectAgents } from '@/modules/studio/StudioProjectAgents';
import { StudioProjectEditor } from '@/modules/studio/StudioProjectEditor';
import { StudioProjectMail } from '@/modules/studio/StudioProjectMail';
import type { HubProject } from '@/shared/types';

const mocks = vi.hoisted(() => ({
  api: { list: vi.fn(), create: vi.fn(), update: vi.fn(), launch: vi.fn(), sessions: vi.fn(), mailStatus: vi.fn(), mailMessages: vi.fn(), saveTask: vi.fn(), mailMessage: vi.fn() },
  writeSelectedProvider: vi.fn(),
}));
vi.mock('@/shared/api', () => ({
  api: { studio: { projects: mocks.api } },
  readApiJson: async (response: Response) => {
    const value = await response.json();
    if (!response.ok) throw Error(value.error);
    return value;
  },
}));
vi.mock('@/shared/selectedProvider', () => ({ writeSelectedProvider: mocks.writeSelectedProvider }));

const project: HubProject = {
  id: 'professor', name: '超级教授', description: '', workspacePath: '/home/me/projects/professor',
  modules: ['agents', 'mail', 'automations'], providers: ['claude', 'codex', 'deepseek'], tone: 'clay', glyph: 'graduation', links: [], remoteHost: '', remoteDir: '', updatedAt: '',
};

afterEach(cleanup);

describe('Studio projects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.sessions.mockResolvedValue(Response.json([{ id: 's1', provider: 'claude', title: '课程大纲' }]));
    mocks.api.mailStatus.mockResolvedValue(Response.json({ configured: false, connected: false, email: null, access: 'readonly' }));
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

  it('does not query mail, read credentials or generate tasks when OAuth is unconfigured', async () => {
    render(<StudioProjectMail project={project} />);
    expect(await screen.findByText('OAuth 未配置')).toBeTruthy();
    expect((screen.getByRole('button', { name: '连接 Gmail' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.api.mailMessages).not.toHaveBeenCalled();
    expect(mocks.api.saveTask).not.toHaveBeenCalled();
  });

  it('does not query or share mailbox data automatically, and drafts summaries for an IDE agent', async () => {
    mocks.api.mailStatus.mockResolvedValue(Response.json({ configured: true, connected: true, email: 'fake@example.test', access: 'readonly' }));
    mocks.api.mailMessages.mockResolvedValue(Response.json([{ id: 'a123', subject: '事项', from: 'fake@example.test', date: '', snippet: '不可信邮件资料' }]));
    mocks.api.saveTask.mockResolvedValue(Response.json({ id: 'draft' }));
    render(<StudioProjectMail project={{ ...project, providers: ['deepseek', 'claude'] }} />);
    await screen.findByRole('textbox', { name: '搜索邮件' });
    expect(mocks.api.mailMessages).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '搜索邮件' }));
    await screen.findByText('事项');
    expect(mocks.api.mailMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存摘要草稿' }));
    await screen.findByText('摘要草稿已保存到自动化，尚未执行');
    expect(mocks.api.saveTask.mock.calls[0][1].provider).toBe('claude');
    expect(mocks.api.saveTask.mock.calls[0][1].prompt).toContain('不可信资料');
  });
});
