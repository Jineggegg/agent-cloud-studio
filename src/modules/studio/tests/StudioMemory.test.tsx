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
const SCRIPT = { where: '在 WSL 的仓库目录运行', command: 'bash scripts/wsl/install-memory.sh' };
const WINDOWS_CLAUDE_COMMAND = 'claude mcp add -s user -t http studio-memory http://127.0.0.1:8770/mcp';
const STATUS: StudioMemoryStatus = {
  reachable: true, slow: false, url: 'http://127.0.0.1:8770/mcp', project: 'studio', notesPath: '~/studio-memory',
  agents: [
    { id: 'claude-wsl', installed: true, registered: true, transport: 'http', shared: true, conventions: true, config: '~/.claude.json', fix: null },
    { id: 'codex-wsl', installed: true, registered: true, transport: 'http', shared: true, conventions: false, config: '~/.codex/config.toml', fix: SCRIPT },
    {
      id: 'claude-windows', installed: true, registered: false, transport: null, shared: false, conventions: false, config: 'C:\\Users\\owner\\.claude.json',
      fix: { where: '在 Windows PowerShell 运行', command: WINDOWS_CLAUDE_COMMAND },
    },
    { id: 'codex-windows', installed: true, registered: true, transport: 'stdio', shared: false, conventions: true, config: 'C:\\Users\\owner\\.codex\\config.toml', fix: SCRIPT },
  ],
  deepseek: { enabled: true },
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
  mocks.memory.recent.mockImplementation(async (folder?: string) => {
    const notes = folder ? NOTES.filter(note => note.folder === folder) : NOTES;
    return Response.json({ ...RECENT, notes, total: notes.length });
  });
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

  it('reports every agent installation truthfully and shows each fix once, ready to copy', async () => {
    render(<StudioMemory />);
    const agents = await screen.findByRole('list', { name: '接入的助手' });
    const rows = within(agents).getAllByRole('listitem');
    expect(rows.map(row => row.querySelector('.memory-agent-body')?.textContent)).toEqual([
      'Claude CodeWSL已接入 · 共享服务',
      'CodexWSL已注册，使用约定未写入',
      'Claude CodeWindows未接入共享记忆',
      'CodexWindows注册的是独立进程，不是共享服务',
      'Studio DeepSeek回复前查阅记忆',
    ]);
    // Only a shared registration with the conventions is green; the Windows apps are not.
    expect(rows.map(row => row.className)).toEqual(['ok', 'warn', 'warn', 'warn', 'ok']);
    const fixes = within(screen.getByRole('list', { name: '接入方法' })).getAllByRole('listitem');
    expect(fixes).toHaveLength(2);
    expect(fixes[0].textContent).toContain('Codex · WSL、Codex · Windows：在 WSL 的仓库目录运行');
    expect(fixes[1].textContent).toContain(WINDOWS_CLAUDE_COMMAND);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fireEvent.click(within(fixes[0]).getByRole('button', { name: '复制命令 bash scripts/wsl/install-memory.sh' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('已复制命令'));
    expect(writeText).toHaveBeenCalledWith('bash scripts/wsl/install-memory.sh');
  });

  it('keeps a missing app quiet and tells a slow server apart from a stopped one', async () => {
    mocks.memory.status.mockImplementation(async () => Response.json({
      ...STATUS, reachable: false, slow: true,
      agents: [{ ...STATUS.agents[0] }, { ...STATUS.agents[1], installed: false, registered: false, transport: null, shared: false, conventions: false, fix: null }],
    }));
    render(<StudioMemory />);
    expect(await screen.findByText('记忆服务响应慢')).toBeTruthy();
    const rows = within(screen.getByRole('list', { name: '接入的助手' })).getAllByRole('listitem');
    expect(rows[1].className).toBe('absent');
    expect(within(rows[1]).getByText('未安装')).toBeTruthy();
    expect(screen.queryByRole('list', { name: '接入方法' })).toBeNull();
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
    // The count follows the filter instead of repeating the whole memory's total.
    expect(screen.getByText('本文件夹 1 条')).toBeTruthy();
    expect(screen.queryByText('共 3 条')).toBeNull();
  });

  it('waits for pinyin to become characters before searching, and caps the query at the server limit', async () => {
    render(<StudioMemory />);
    await screen.findByRole('button', { name: /部署方式/ });
    const box = screen.getByPlaceholderText('搜索决定、偏好和项目事实') as HTMLInputElement;
    expect(box.maxLength).toBe(200);
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: "bu'shu" } });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(mocks.memory.search).not.toHaveBeenCalled();
    expect(screen.queryByText(/没有找到/)).toBeNull();
    expect(screen.getByRole('button', { name: /部署方式/ })).toBeTruthy();
    fireEvent.change(box, { target: { value: '部署' } });
    fireEvent.compositionEnd(box);
    await waitFor(() => expect(mocks.memory.search).toHaveBeenCalledWith('部署', undefined, expect.any(AbortSignal)));
    expect(mocks.memory.search).toHaveBeenCalledTimes(1);
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
