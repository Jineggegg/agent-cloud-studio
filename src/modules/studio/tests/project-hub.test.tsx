import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StudioProjectOverview } from '@/modules/studio/StudioProjectOverview';
import { StudioProjectMail } from '@/modules/studio/StudioProjectMail';
import { StudioProjectEditor } from '@/modules/studio/StudioProjectEditor';
import type { HubProject } from '@/shared/types';

const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), mailStatus: vi.fn(), mailMessages: vi.fn(), saveTask: vi.fn(), mailMessage: vi.fn() }));
vi.mock('@/shared/api', () => ({
  api: { studio: { projects: mocks } },
  readApiJson: async (response: Response) => {
    const value = await response.json();
    if (!response.ok) throw Error(value.error);
    return value;
  },
}));
const project: HubProject = { id: 'professor', name: '超级教授', description: '', workspacePath: '/projects/professor', modules: ['agents', 'mail', 'automations'], providers: ['claude', 'codex'], updatedAt: '' };

describe('modular Studio projects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue(Response.json([project]));
    mocks.mailStatus.mockResolvedValue(Response.json({ configured: false, connected: false, email: null, access: 'readonly' }));
  });
  it('shows a project entry leading to its own workspace', async () => {
    render(<MemoryRouter><StudioProjectOverview /></MemoryRouter>);
    expect((await screen.findByRole('link', { name: /超级教授/ })).getAttribute('href')).toBe('/projects/professor');
    expect(mocks.saveTask).not.toHaveBeenCalled();
  });
  it('persists module selection only when explicitly saved', async () => {
    mocks.update.mockResolvedValue(Response.json({ ...project, modules: ['agents', 'automations'] }));
    const saved = vi.fn();
    render(<StudioProjectEditor project={project} onSaved={saved} />);
    fireEvent.click(screen.getByLabelText('邮箱'));
    expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存项目' }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0][1].modules).toEqual(['agents', 'automations']);
  });
  it('does not query mail, read credentials or generate tasks when OAuth is unconfigured', async () => {
    render(<StudioProjectMail project={project} />);
    expect(await screen.findByText('OAuth 未配置')).toBeTruthy();
    expect((screen.getByRole('button', { name: '连接 Gmail' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.mailMessages).not.toHaveBeenCalled();
    expect(mocks.saveTask).not.toHaveBeenCalled();
  });
  it('does not query or share mailbox data automatically after connecting', async () => {
    mocks.mailStatus.mockResolvedValue(Response.json({ configured: true, connected: true, email: 'fake@example.test', access: 'readonly' }));
    mocks.mailMessages.mockResolvedValue(Response.json([{ id: 'a123', subject: '事项', from: 'fake@example.test', date: '', snippet: '不可信邮件资料' }]));
    mocks.saveTask.mockResolvedValue(Response.json({ id: 'draft' }));
    render(<StudioProjectMail project={project} />);
    await screen.findByRole('textbox', { name: '搜索邮件' });
    expect(mocks.mailMessages).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '搜索邮件' }));
    await screen.findByText('事项');
    expect(mocks.mailMessage).not.toHaveBeenCalled();
    expect(mocks.saveTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存摘要草稿' }));
    await screen.findByText('摘要草稿已保存到自动化，尚未执行');
    expect(mocks.saveTask.mock.calls[0][1].prompt).toContain('不可信资料');
    expect(mocks.saveTask.mock.calls[0][1].prompt).toContain('仅为搜索结果的摘要片段');
  });
});
