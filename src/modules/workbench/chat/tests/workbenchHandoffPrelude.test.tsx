import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { PermissionContext } from '@/modules/chat';
import { api } from '@/shared/api';
import type { ChatMessage, NormalizedMessage, PendingPermissionRequest, Project, WorkbenchThreadSegment } from '@/shared/types';
import { WorkbenchHandoffPrelude } from '@/modules/workbench/chat/WorkbenchHandoffPrelude';
import { WorkbenchTranscript } from '@/modules/workbench/chat/WorkbenchTranscript';

const project: Project = { projectId: 'p1', displayName: 'Studio', fullPath: '/repo' };

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const at = (minute: number, second = 0) => `2026-10-03T08:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;

// History rows as GET /api/providers/sessions/:id/messages returns them: a tool call and its result are separate rows.
function row(fields: Partial<NormalizedMessage> & Pick<NormalizedMessage, 'id' | 'kind'>, provider: 'claude' | 'codex', sessionId: string): NormalizedMessage {
  return { timestamp: at(0), provider, sessionId, ...fields } as NormalizedMessage;
}

// A Claude Code stretch: reasoning, an edit, a command, a plan that was never answered, then the reply.
const claude = (fields: Parameters<typeof row>[0]) => row(fields, 'claude', 's1');
const CLAUDE_ROWS: NormalizedMessage[] = [
  claude({ id: 'c1', kind: 'text', role: 'user', content: '把侧栏改成可折叠', timestamp: at(1), transcriptAnchorId: 'anchor-1' }),
  claude({ id: 'c2', kind: 'thinking', content: 'The sidebar lives in Sidebar.tsx', timestamp: at(1, 5) }),
  claude({ id: 'c3', kind: 'tool_use', toolName: 'Edit', toolId: 'edit-1', toolInput: { file_path: '/repo/src/Sidebar.tsx', old_string: 'open', new_string: 'collapsed\nanimated' }, timestamp: at(1, 10) }),
  claude({ id: 'c4', kind: 'tool_result', toolId: 'edit-1', content: 'ok', timestamp: at(1, 11) }),
  claude({ id: 'c5', kind: 'tool_use', toolName: 'Bash', toolId: 'bash-1', toolInput: { command: 'npm test -- sidebar' }, timestamp: at(1, 20) }),
  claude({ id: 'c6', kind: 'tool_result', toolId: 'bash-1', content: '12 passed', timestamp: at(1, 30) }),
  claude({ id: 'c7', kind: 'tool_use', toolName: 'ExitPlanMode', toolId: 'plan-1', toolInput: { plan: '1. 折叠侧栏' }, timestamp: at(1, 40) }),
  claude({ id: 'c8', kind: 'text', role: 'assistant', content: '好的，侧栏已经可以折叠。', model: 'claude-opus-5', timestamp: at(2) }),
];

// A Codex stretch: Codex's commands and patches arrive normalised to Bash and Edit; one command never finished.
const codex = (fields: Parameters<typeof row>[0]) => row(fields, 'codex', 's2');
const CODEX_ROWS: NormalizedMessage[] = [
  codex({ id: 'x1', kind: 'text', role: 'user', content: '再加一个快捷键', timestamp: at(3) }),
  codex({ id: 'x2', kind: 'tool_use', toolName: 'Bash', toolId: 'call-rg', toolInput: { command: 'rg shortcut src' }, timestamp: at(3, 10) }),
  codex({ id: 'x3', kind: 'tool_result', toolId: 'call-rg', content: 'src/keys.ts', timestamp: at(3, 11) }),
  codex({ id: 'x4', kind: 'tool_use', toolName: 'Edit', toolId: 'call-patch', toolInput: { file_path: '/repo/src/keys.ts', old_string: '', new_string: "bind('mod+b')" }, timestamp: at(3, 20) }),
  codex({ id: 'x5', kind: 'tool_result', toolId: 'call-patch', content: 'Success', timestamp: at(3, 21) }),
  codex({ id: 'x6', kind: 'tool_use', toolName: 'Bash', toolId: 'call-build', toolInput: { command: 'npm run build' }, timestamp: at(3, 30) }),
  codex({ id: 'x7', kind: 'text', role: 'assistant', content: '快捷键加好了。', timestamp: at(4) }),
];

const SEGMENTS: WorkbenchThreadSegment[] = [
  { kind: 'agent', provider: 'claude', sessionId: 's1', modelLabel: 'Opus', handoffAt: null },
  { kind: 'agent', provider: 'codex', sessionId: 's2', modelLabel: 'GPT-5.5', handoffAt: at(3) },
];
const NEXT = { provider: 'claude' as const, modelLabel: 'Sonnet', handoffAt: at(5) };

// Serves each stretch's rows the way the server pages them: `limit` rows ending `offset` rows before the newest.
function serveHistory(rowsBySession: Record<string, NormalizedMessage[]>) {
  return vi.spyOn(api.providers, 'sessionMessages').mockImplementation(async (sessionId: string, pagination = {}) => {
    const rows = rowsBySession[sessionId] ?? [];
    const limit = pagination.limit ?? rows.length;
    const end = rows.length - (pagination.offset ?? 0);
    const start = Math.max(0, end - limit);
    return json({ success: true, data: { messages: rows.slice(start, Math.max(start, end)), total: rows.length, hasMore: start > 0 } });
  });
}

function renderPrelude(segments = SEGMENTS) {
  const onOpenFile = vi.fn();
  const utils = render(<WorkbenchHandoffPrelude project={project} segments={segments} next={NEXT} onOpenFile={onOpenFile} />, { wrapper: MemoryRouter });
  return { ...utils, onOpenFile };
}

// The open session below the prelude, as WorkbenchAgentChat draws it.
function renderTranscriptWithPrelude(overrides: { hasMoreHistory?: boolean; messages?: ChatMessage[] } = {}) {
  const props = {
    sessionKey: 's3', isNewChat: false, provider: 'claude', project, scrollRef: createRef<HTMLDivElement>(), onScrollIntent: vi.fn(),
    isLoading: false, runActive: false, hiddenCount: 0, onShowEarlier: vi.fn(), isLoadingHistory: false,
    onLoadAllHistory: vi.fn(), createDiff: () => [], onOpenFile: vi.fn(), pendingPlanRequest: null, onDecision: vi.fn(), emptyState: null,
    messages: overrides.messages ?? [{ type: 'user', id: 'n1', content: '现在的会话', timestamp: at(6) } satisfies ChatMessage],
    prelude: <WorkbenchHandoffPrelude project={project} segments={SEGMENTS} next={NEXT} onOpenFile={vi.fn()} />,
  };
  const utils = render(<WorkbenchTranscript {...props} hasMoreHistory={overrides.hasMoreHistory ?? false} />, { wrapper: MemoryRouter });
  return {
    ...utils,
    setHasMoreHistory: (hasMoreHistory: boolean) => utils.rerender(<WorkbenchTranscript {...props} hasMoreHistory={hasMoreHistory} />),
  };
}

const stretch = (name: string) => screen.getByRole('region', { name: `${name} 的对话` });
const isBefore = (first: Element, second: Element) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('earlier stretches show their tool calls', () => {
  test('a Claude Code stretch draws reasoning, edits and commands as the live transcript does', async () => {
    serveHistory({ s1: CLAUDE_ROWS });
    const { onOpenFile } = renderPrelude([SEGMENTS[0]]);
    const region = await screen.findByRole('region', { name: 'Claude Code · Opus 的对话' });
    await within(region).findByText('好的，侧栏已经可以折叠。');

    // The turn label with the model the provider reported, and one stack for the reasoning and the tool calls.
    expect(within(region).getByText('Opus 5')).toBeTruthy();
    const stack = within(region).getByRole('list', { name: '工具调用' });
    expect(within(stack).getByText('思考')).toBeTruthy();
    expect(within(stack).getByText('npm test -- sidebar')).toBeTruthy();
    // The result rows were folded onto their calls: the edit counts its lines, and reasoning, edit and command are done.
    expect(within(stack).getByLabelText('新增 2 行，删除 1 行')).toBeTruthy();
    expect(within(stack).getAllByTitle('完成')).toHaveLength(3);

    // Rows expand to their diff and output, and the edit opens its file in the column's viewer.
    fireEvent.click(within(stack).getByText('Sidebar.tsx').closest('button') as HTMLButtonElement);
    expect(within(region).getByRole('group', { name: '改动' })).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: '打开文件' }));
    expect(onOpenFile).toHaveBeenCalledWith('/repo/src/Sidebar.tsx');
    fireEvent.click(within(stack).getByText('npm test -- sidebar').closest('button') as HTMLButtonElement);
    expect(within(region).getByLabelText('命令输出').textContent).toContain('12 passed');
    // The plan reads as the plan card.
    expect(within(region).getByRole('region', { name: '执行计划' }).textContent).toContain('折叠侧栏');
  });

  test('a Codex stretch draws its commands and patches under the Codex turn label', async () => {
    serveHistory({ s2: CODEX_ROWS });
    renderPrelude([SEGMENTS[1]]);
    const region = await screen.findByRole('region', { name: 'Codex · GPT-5.5 的对话' });
    await within(region).findByText('快捷键加好了。');
    expect(within(region).getByText('Codex')).toBeTruthy();
    const stack = within(region).getByRole('list', { name: '工具调用' });
    expect(within(stack).getByText('rg shortcut src')).toBeTruthy();
    expect(within(stack).getByText('keys.ts')).toBeTruthy();
    expect(within(stack).getByLabelText('新增 1 行，删除 0 行')).toBeTruthy();
    fireEvent.click(within(stack).getByText('rg shortcut src').closest('button') as HTMLButtonElement);
    expect(within(region).getByLabelText('命令输出').textContent).toContain('src/keys.ts');
  });

  test('a DeepSeek stretch reads as the DeepSeek view, unanswered turns included', async () => {
    vi.spyOn(api.studio, 'conversation').mockResolvedValue(json({
      id: 'c9', title: '起名字', model: 'deepseek-v4-pro', updated_at: at(0),
      messages: [
        { id: 1, role: 'user', content: '帮我起个名字', status: 'complete' },
        { id: 2, role: 'assistant', content: '叫「折叠侧栏」。', status: 'complete' },
        { id: 3, role: 'user', content: '再来一个', status: 'error' },
      ],
    }));
    renderPrelude([{ kind: 'deepseek', provider: 'deepseek', sessionId: 'c9', modelLabel: 'deepseek-v4-pro', handoffAt: null }]);
    const region = await screen.findByRole('region', { name: 'DeepSeek · deepseek-v4-pro 的对话' });
    expect(await within(region).findByText('叫「折叠侧栏」。')).toBeTruthy();
    expect(within(region).getByText('deepseek-v4-pro')).toBeTruthy();
    expect(within(region).getByText('没有送达')).toBeTruthy();
  });

  test('earlier stretches are read-only: no plan approval, no edit, nothing shown as running', async () => {
    serveHistory({ s1: CLAUDE_ROWS, s2: CODEX_ROWS });
    const decide = vi.fn();
    // Even with the open session waiting on a plan, the prelude's plan card never offers to answer it.
    const pendingPlan: PendingPermissionRequest = { requestId: 'live-plan', toolName: 'ExitPlanMode', input: {} };
    render(
      <PermissionContext.Provider value={{ pendingPermissionRequests: [pendingPlan], handlePermissionDecision: decide }}>
        <WorkbenchHandoffPrelude project={project} segments={SEGMENTS} next={NEXT} onOpenFile={vi.fn()} />
      </PermissionContext.Provider>,
      { wrapper: MemoryRouter },
    );
    await screen.findByText('快捷键加好了。');
    fireEvent.click(screen.getByRole('button', { name: '载入更早的 Claude Code 对话' }));
    await screen.findByText('好的，侧栏已经可以折叠。');

    expect(screen.queryByRole('button', { name: '批准并执行' })).toBeNull();
    expect(screen.queryByRole('button', { name: '继续修改' })).toBeNull();
    expect(screen.queryByText('等你批准')).toBeNull();
    // The owner's turn keeps copy but not edit, though the row carries an anchor.
    expect(screen.queryByRole('button', { name: '编辑后重新发送' })).toBeNull();
    expect(screen.getAllByRole('button', { name: '复制' }).length).toBeGreaterThan(0);
    // The build that never reported back is unfinished, not spinning.
    const build = screen.getByText('npm run build').closest('[role="listitem"]') as HTMLElement;
    expect(within(build).getByTitle('未完成')).toBeTruthy();
    expect(within(build).queryByRole('status')).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });
});

describe('order and paging', () => {
  test('stretches sit oldest first above their dividers, and the open session follows the last divider', async () => {
    serveHistory({ s1: CLAUDE_ROWS, s2: CODEX_ROWS });
    renderTranscriptWithPrelude();
    await screen.findByText('快捷键加好了。');
    fireEvent.click(screen.getByRole('button', { name: '载入更早的 Claude Code 对话' }));
    await screen.findByText('好的，侧栏已经可以折叠。');

    const [toCodex, toClaude] = screen.getAllByRole('note').filter((note) => note.classList.contains('wbc-handoff-divider'));
    expect(toCodex.textContent).toContain('已交接给 Codex · GPT-5.5');
    expect(toClaude.textContent).toContain('已交接给 Claude Code · Sonnet');
    const order = [
      screen.getByText('把侧栏改成可折叠'), within(stretch('Claude Code · Opus')).getByRole('list', { name: '工具调用' }),
      screen.getByText('好的，侧栏已经可以折叠。'), toCodex,
      screen.getByText('再加一个快捷键'), within(stretch('Codex · GPT-5.5')).getByRole('list', { name: '工具调用' }),
      screen.getByText('快捷键加好了。'), toClaude,
      screen.getByText('现在的会话'),
    ];
    order.slice(1).forEach((element, index) => expect(isBefore(order[index], element)).toBe(true));
    // Each divider still leads back to the stretch above it.
    expect(within(toCodex).getByRole('link', { name: '打开原会话' }).getAttribute('href')).toBe('/work/p1/s/s1');
    expect(within(toClaude).getByRole('link', { name: '打开原会话' }).getAttribute('href')).toBe('/work/p1/s/s2');
  });

  test('the newest stretch loads first, a page at a time; older pages go above, then the stretch before', async () => {
    // A long Claude stretch: 90 rows, read 40 at a time from the newest.
    const longRows = Array.from({ length: 90 }, (_, index) => claude({
      id: `l${index}`, kind: 'text', role: index % 2 ? 'assistant' : 'user', content: `第 ${index} 条`, timestamp: at(0, index % 60),
    }));
    const history = serveHistory({ s1: longRows, s2: CODEX_ROWS });
    renderPrelude();

    await screen.findByText('快捷键加好了。');
    // Only the stretch nearest the handoff was asked for; the one before waits for the owner to scroll up.
    expect(history.mock.calls.map(([id, page]) => [id, page])).toEqual([['s2', { limit: 40, offset: 0 }]]);
    expect(screen.queryByRole('region', { name: 'Claude Code · Opus 的对话' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '载入更早的 Claude Code 对话' }));
    expect(await screen.findByText('第 89 条')).toBeTruthy();
    expect(screen.queryByText('第 49 条')).toBeNull();
    expect(history).toHaveBeenLastCalledWith('s1', { limit: 40, offset: 0 });

    fireEvent.click(screen.getByRole('button', { name: '载入更早的消息' }));
    expect(await screen.findByText('第 49 条')).toBeTruthy();
    expect(history).toHaveBeenLastCalledWith('s1', { limit: 40, offset: 40 });
    // The older page sits above the rows already shown.
    expect(isBefore(screen.getByText('第 50 条'), screen.getByText('第 89 条'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '载入更早的消息' }));
    expect(await screen.findByText('第 0 条')).toBeTruthy();
    expect(history).toHaveBeenLastCalledWith('s1', { limit: 40, offset: 80 });
    // Everything is shown: nothing older to load.
    await waitFor(() => expect(screen.queryByRole('button', { name: /载入更早/ })).toBeNull());
    expect(history).toHaveBeenCalledTimes(4);
  });

  test('a page that fails is offered again; a stretch that is gone says so and the one before still loads', async () => {
    const real = serveHistory({ s1: CLAUDE_ROWS });
    real.mockImplementationOnce(async () => { throw new Error('gone'); });
    renderPrelude();
    expect(await screen.findByText('这段 Codex 对话读不到了（可能已删除）。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '载入更早的 Claude Code 对话' }));
    expect(await screen.findByText('好的，侧栏已经可以折叠。')).toBeTruthy();
  });

  test('the earlier stretches wait until the open session is shown from its first row', async () => {
    const history = serveHistory({ s1: CLAUDE_ROWS, s2: CODEX_ROWS });
    const { setHasMoreHistory } = renderTranscriptWithPrelude({ hasMoreHistory: true });
    // The open session still has older rows of its own: those come first, so nothing above them is read yet.
    expect(screen.getByRole('button', { name: /载入全部历史/ })).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    expect(history).not.toHaveBeenCalled();
    expect(screen.queryByText(/已交接给/)).toBeNull();

    setHasMoreHistory(false);
    expect(await screen.findByText('快捷键加好了。')).toBeTruthy();
    expect(screen.getByText(/已交接给 Claude Code · Sonnet/)).toBeTruthy();
    expect(history).toHaveBeenCalledWith('s2', { limit: 40, offset: 0 });
  });
});
