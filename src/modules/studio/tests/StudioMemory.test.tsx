import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StudioMemory } from '@/modules/studio/StudioMemory';
import type { StudioMemoryNote, StudioMemoryNoteDetail, StudioMemoryRecent, StudioMemoryStatus } from '@/shared/types';

const mocks = vi.hoisted(() => {
  class ApiRequestError extends Error {
    code?: string;
    status: number;
    constructor(message: string, options: { code?: string; status: number }) {
      super(message);
      this.code = options.code;
      this.status = options.status;
    }
  }
  return {
    ApiRequestError,
    memory: { status: vi.fn(), recent: vi.fn(), search: vi.fn(), note: vi.fn(), remove: vi.fn() },
    toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  };
});
vi.mock('@/shared/api', () => ({
  ApiRequestError: mocks.ApiRequestError,
  api: { studio: { memory: mocks.memory } },
  readApiJson: async (response: Response) => {
    const value = await response.json();
    if (!response.ok) throw new mocks.ApiRequestError(value.error.message, { code: value.error.code, status: response.status });
    return value;
  },
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));

const NOTES: StudioMemoryNote[] = [
  { id: 'studio/agent-cloud-studio/部署', title: '部署方式', folder: 'agent-cloud-studio', source: 'claude', updatedAt: new Date().toISOString(), snippet: '' },
  { id: 'studio/global/语言偏好', title: '语言偏好', folder: 'global', source: 'deepseek', updatedAt: '2025-03-01T10:00:00Z', snippet: '' },
  { id: 'studio/snr3-lab/回放', title: '回放约定', folder: 'snr3-lab', source: null, updatedAt: null, snippet: '' },
];
const RECENT: StudioMemoryRecent = {
  notes: NOTES,
  folders: [
    { name: 'global', project: null },
    { name: 'agent-cloud-studio', project: { id: 'p1', name: 'Agent Cloud Studio', tone: 'slate', glyph: 'terminal' } },
    { name: 'snr3-lab', project: null },
  ],
  total: 3,
};
const STATUS: StudioMemoryStatus = {
  reachable: true, url: 'http://127.0.0.1:8770/mcp', project: 'studio', notesPath: '~/studio-memory',
  clients: {
    claude: { registered: true, transport: 'http', conventions: true },
    codex: { registered: true, transport: 'http', conventions: false },
    deepseek: { enabled: true },
  },
};
const DETAIL: StudioMemoryNoteDetail = {
  ...NOTES[0], tags: ['claude', 'ops'], truncated: false,
  content: '# 部署方式\n\n服务跑在 **systemd** 用户服务里。<img src=x onerror="alert(1)">\n\n关键词：部署 端口 systemd',
};
const unavailable = () => Response.json({ success: false, error: { code: 'MEMORY_UNAVAILABLE', message: '共享记忆服务未运行或无法连接' } }, { status: 503 });

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  mocks.memory.status.mockImplementation(async () => Response.json(STATUS));
  mocks.memory.recent.mockImplementation(async (folder?: string) => Response.json({ ...RECENT, notes: folder ? NOTES.filter(note => note.folder === folder) : NOTES }));
  mocks.memory.search.mockImplementation(async (q: string) => Response.json({
    notes: q.includes('部署') ? [{ ...NOTES[0], snippet: '部署使用 systemd 用户服务，端口 3002。' }] : [],
  }));
  mocks.memory.note.mockImplementation(async () => Response.json(DETAIL));
  mocks.memory.remove.mockImplementation(async () => Response.json({ deleted: true }));
});

describe('记忆 app', () => {
  it('lists the newest notes with their writer and project, and shows how each agent is wired', async () => {
    render(<StudioMemory />);
    const row = await screen.findByRole('button', { name: /部署方式/ });
    expect(within(row).getByText('Claude')).toBeTruthy();
    expect(within(row).getByText('Agent Cloud Studio')).toBeTruthy();
    expect(within(screen.getByRole('button', { name: /语言偏好/ })).getByText('全局')).toBeTruthy();
    expect(screen.getByText('共 3 条')).toBeTruthy();

    expect(await screen.findByText('记忆库在线')).toBeTruthy();
    expect(screen.getByText('~/studio-memory · 3 条笔记')).toBeTruthy();
    const agents = screen.getByRole('list', { name: '接入的助手' });
    expect(within(agents).getByText('已接入 · 共享服务')).toBeTruthy();
    expect(within(agents).getByText('已注册，使用约定未写入')).toBeTruthy();
    expect(within(agents).getByText('回复前查阅记忆')).toBeTruthy();
  });

  it('searches after typing pauses, marks the words and explains an empty result', async () => {
    render(<StudioMemory />);
    await screen.findByRole('button', { name: /部署方式/ });
    const box = screen.getByPlaceholderText('搜索决定、偏好和项目事实');
    fireEvent.change(box, { target: { value: '部署' } });
    expect(await screen.findByText('搜索结果')).toBeTruthy();
    await waitFor(() => expect(mocks.memory.search).toHaveBeenCalledWith('部署', undefined, expect.any(AbortSignal)));
    const mark = await screen.findByText('部署', { selector: 'mark' });
    expect(mark.closest('button')?.textContent).toContain('部署方式');
    expect(screen.queryByRole('button', { name: /语言偏好/ })).toBeNull();

    fireEvent.change(box, { target: { value: '量子' } });
    expect(await screen.findByText('没有找到「量子」')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
    expect(await screen.findByText('最近更新')).toBeTruthy();
  });

  it('filters by folder with the chips', async () => {
    render(<StudioMemory />);
    const chips = await screen.findByRole('group', { name: '按文件夹筛选' });
    fireEvent.click(within(chips).getByRole('button', { name: '全局' }));
    await waitFor(() => expect(mocks.memory.recent).toHaveBeenLastCalledWith('global', expect.any(AbortSignal)));
    await waitFor(() => expect(screen.queryByRole('button', { name: /部署方式/ })).toBeNull());
    expect(within(chips).getByRole('button', { name: '全局' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('reads a note as escaped Markdown and turns its keywords into searches', async () => {
    render(<StudioMemory />);
    fireEvent.click(await screen.findByRole('button', { name: /部署方式/ }));
    const reader = await screen.findByRole('dialog');
    await within(reader).findByText('systemd', { selector: 'strong' });
    expect(mocks.memory.note).toHaveBeenCalledWith('studio/agent-cloud-studio/部署', expect.any(AbortSignal));
    expect(reader.querySelector('img')).toBeNull();
    expect(reader.querySelector('strong')?.textContent).toBe('systemd');
    // The repeated "# 部署方式" heading and the keyword line are not shown as text.
    expect(within(reader).queryByRole('heading', { level: 1 })).toBeNull();
    expect(within(reader).queryByText(/关键词：/)).toBeNull();
    expect(within(reader).getByText('#ops')).toBeTruthy();
    fireEvent.click(within(within(reader).getByRole('group', { name: '关键词' })).getByRole('button', { name: '端口' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((screen.getByPlaceholderText('搜索决定、偏好和项目事实') as HTMLInputElement).value).toBe('端口');
  });

  it('deletes a note only after confirmation', async () => {
    render(<StudioMemory />);
    fireEvent.click(await screen.findByRole('button', { name: /部署方式/ }));
    const reader = await screen.findByRole('dialog');
    await within(reader).findByText('systemd', { selector: 'strong' });
    fireEvent.click(within(reader).getByRole('button', { name: '删除' }));
    const alert = await screen.findByRole('alertdialog');
    expect(alert.textContent).toContain('此操作无法撤销');
    fireEvent.click(within(alert).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mocks.memory.remove).not.toHaveBeenCalled();

    fireEvent.click(within(reader).getByRole('button', { name: '删除' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(mocks.memory.remove).toHaveBeenCalledWith('studio/agent-cloud-studio/部署'));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('已删除「部署方式」'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('reads everything again when the app bar refresh starts', async () => {
    const view = render(<StudioMemory refreshing={false} />);
    await screen.findByRole('button', { name: /部署方式/ });
    expect(mocks.memory.recent).toHaveBeenCalledTimes(1);
    view.rerender(<StudioMemory refreshing />);
    await waitFor(() => expect(mocks.memory.recent).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.memory.status).toHaveBeenCalledTimes(2));
    // The refresh ending is not a second refresh.
    view.rerender(<StudioMemory refreshing={false} />);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(mocks.memory.recent).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: '刷新记忆' })).toBeNull();
  });

  it('explains how to start a stopped memory server', async () => {
    mocks.memory.recent.mockImplementation(async () => unavailable());
    mocks.memory.status.mockImplementation(async () => Response.json({ ...STATUS, reachable: false }));
    render(<StudioMemory />);
    expect(await screen.findByText('记忆服务未运行', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText('systemctl --user start studio-memory')).toBeTruthy();
    expect(await screen.findByText('记忆服务未运行', { selector: 'h2' })).toBeTruthy();
    expect(screen.getByText('等待记忆服务')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(mocks.memory.recent).toHaveBeenCalledTimes(2));
  });
});
