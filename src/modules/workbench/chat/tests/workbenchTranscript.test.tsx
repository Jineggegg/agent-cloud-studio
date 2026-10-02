import { createRef } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import type { ChatMessage, PendingPermissionRequest, Project } from '@/shared/types';
import { WorkbenchTranscript } from '@/modules/workbench/chat/WorkbenchTranscript';

const project: Project = { projectId: 'p1', displayName: 'Studio', fullPath: '/repo' };

// Line diff good enough for assertions: every old line removed, every new line added.
const createDiff = (before: string, after: string) => [
  ...(before ? before.split('\n').map((content, index) => ({ type: 'removed' as const, content, lineNum: index + 1 })) : []),
  ...(after ? after.split('\n').map((content, index) => ({ type: 'added' as const, content, lineNum: index + 1 })) : []),
];

const at = (second: number) => `2026-10-02T08:00:${String(second).padStart(2, '0')}.000Z`;

const transcript: ChatMessage[] = [
  { type: 'user', id: 'u1', content: '把标题改成中文', timestamp: at(1), transcriptAnchorId: 'a1' },
  { type: 'assistant', id: 'th1', isThinking: true, content: 'The title lives in header.tsx', timestamp: at(2) },
  {
    type: 'assistant', id: 't1', isToolUse: true, toolName: 'Edit', toolId: 'tool-edit', timestamp: at(3),
    toolInput: JSON.stringify({ file_path: '/repo/src/header.tsx', old_string: 'Title', new_string: '标题\n副标题' }),
    toolResult: { content: 'ok' },
  },
  {
    type: 'assistant', id: 't2', isToolUse: true, toolName: 'Bash', toolId: 'tool-bash', timestamp: at(4),
    toolInput: JSON.stringify({ command: 'npm test', description: 'Run the tests' }),
    toolResult: { content: 'Tests failed', isError: true },
  },
  { type: 'assistant', id: 'r1', content: '已经改好了，**测试**还有一个失败。', timestamp: at(5), model: 'claude-opus-5' },
  { type: 'error', id: 'e1', content: 'Rate limited', timestamp: at(6) },
  { type: 'assistant', id: 'n1', isTaskNotification: true, taskNotificationStatus: 'completed', content: '后台任务已完成', timestamp: at(7) },
  { type: 'assistant', id: 'c1', content: '', compact: { phase: 'done', preTokens: 120000, postTokens: 30000 }, timestamp: at(8) },
  {
    type: 'assistant', id: 'q1', isToolUse: true, toolName: 'AskUserQuestion', toolId: 'tool-q', timestamp: at(9),
    toolInput: JSON.stringify({ questions: [{ question: '用哪种语言？', header: '语言' }], answers: { '用哪种语言？': '中文' } }),
    toolResult: { content: 'answered' },
  },
  {
    type: 'assistant', id: 'p1', isToolUse: true, toolName: 'ExitPlanMode', toolId: 'tool-plan', timestamp: at(10),
    toolInput: JSON.stringify({ plan: '1. 改标题\\n2. 跑测试' }), toolResult: null,
  },
];

function renderTranscript(overrides: Partial<Parameters<typeof WorkbenchTranscript>[0]> = {}) {
  const onDecision = vi.fn();
  const onOpenFile = vi.fn();
  const onEditMessage = vi.fn();
  const utils = render(
    <WorkbenchTranscript
      sessionKey="s1"
      isNewChat={false}
      messages={transcript}
      provider="claude"
      project={project}
      scrollRef={createRef<HTMLDivElement>()}
      onScrollIntent={vi.fn()}
      isLoading={false}
      runActive={false}
      showTyping={false}
      hiddenCount={0}
      onShowEarlier={vi.fn()}
      hasMoreHistory={false}
      isLoadingHistory={false}
      onLoadAllHistory={vi.fn()}
      createDiff={createDiff}
      onOpenFile={onOpenFile}
      pendingPlanRequest={null}
      onDecision={onDecision}
      onEditMessage={onEditMessage}
      emptyState={<p>空</p>}
      {...overrides}
    />,
  );
  return { ...utils, onDecision, onOpenFile, onEditMessage };
}

describe('WorkbenchTranscript', () => {
  test('draws every message kind in its own form', () => {
    renderTranscript();
    // The owner's bubble, with edit offered because the turn has an anchor.
    expect(screen.getByText('把标题改成中文')).toBeTruthy();
    expect(screen.getByRole('button', { name: '编辑后重新发送' })).toBeTruthy();
    // One turn label for the agent, carrying the model the provider reported in plain words.
    expect(screen.getByText('Opus 5').getAttribute('title')).toBe('claude-opus-5');
    // Reasoning and tool calls fold into one stack of compact rows.
    const stack = screen.getByRole('list', { name: '工具调用' });
    expect(within(stack).getByText('思考')).toBeTruthy();
    expect(within(stack).getByText('header.tsx')).toBeTruthy();
    expect(within(stack).getByLabelText('新增 2 行，删除 1 行')).toBeTruthy();
    expect(within(stack).getByText('npm test')).toBeTruthy();
    expect(within(stack).getByText('出错')).toBeTruthy();
    // Prose renders markdown.
    expect(screen.getByText('测试').tagName).toBe('STRONG');
    // Quiet rows: error, task report, compaction.
    expect(screen.getByText('Rate limited')).toBeTruthy();
    expect(screen.getByText('后台任务已完成')).toBeTruthy();
    expect(screen.getByText(/已压缩上下文 · 120K → 30K/)).toBeTruthy();
    // An answered question shows the choice; a plan shows its text (literal \n turned into lines).
    expect(screen.getByText('中文')).toBeTruthy();
    expect(screen.getByRole('region', { name: '执行计划' }).textContent).toContain('改标题');
  });

  test('a tool row expands to its detail, and an edit offers to open the file', () => {
    const { onOpenFile } = renderTranscript();
    const editRow = screen.getByText('header.tsx').closest('button') as HTMLButtonElement;
    expect(editRow.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(editRow);
    expect(editRow.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('group', { name: '改动' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开文件' }));
    expect(onOpenFile).toHaveBeenCalledWith('/repo/src/header.tsx');

    fireEvent.click(screen.getByText('npm test').closest('button') as HTMLButtonElement);
    expect(screen.getByLabelText('命令输出').textContent).toContain('Tests failed');
  });

  test('the newest plan carries approve and revise while Claude waits for them', () => {
    const request: PendingPermissionRequest = { requestId: 'plan-1', toolName: 'ExitPlanMode', input: {} };
    const { onDecision } = renderTranscript({ pendingPlanRequest: request });
    fireEvent.click(screen.getByRole('button', { name: '批准并执行' }));
    expect(onDecision).toHaveBeenCalledWith('plan-1', { allow: true });

    fireEvent.click(screen.getByRole('button', { name: '继续修改' }));
    fireEvent.change(screen.getByLabelText('想怎么改'), { target: { value: '先别动数据库' } });
    fireEvent.click(screen.getByRole('button', { name: '发回修改' }));
    expect(onDecision).toHaveBeenLastCalledWith('plan-1', { allow: false, message: '先别动数据库' });
  });

  test('loading shows a skeleton, an empty new chat shows its empty state, a run shows the typing dots', () => {
    const { rerender } = renderTranscript({ messages: [], isLoading: true });
    expect(screen.getByRole('status', { name: '正在载入对话' })).toBeTruthy();
    rerender(
      <WorkbenchTranscript
        sessionKey="new-0" isNewChat messages={[]} provider="claude" project={project}
        scrollRef={createRef<HTMLDivElement>()} onScrollIntent={vi.fn()} isLoading={false} runActive showTyping
        hiddenCount={0} onShowEarlier={vi.fn()} hasMoreHistory={false} isLoadingHistory={false} onLoadAllHistory={vi.fn()}
        createDiff={createDiff} onOpenFile={vi.fn()} pendingPlanRequest={null} onDecision={vi.fn()} emptyState={<p>空</p>}
      />,
    );
    expect(screen.getByText('空')).toBeTruthy();
    expect(screen.getByRole('status', { name: '正在回复' })).toBeTruthy();
  });

  test('older rows outside the window are one tap away', () => {
    const onShowEarlier = vi.fn();
    renderTranscript({ hiddenCount: 40, onShowEarlier });
    fireEvent.click(screen.getByRole('button', { name: /显示更早的 40 条/ }));
    expect(onShowEarlier).toHaveBeenCalled();
  });
});
