import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import type { PendingPermissionRequest } from '@/shared/types';
import { WorkbenchPermissionSheet } from '@/modules/workbench/chat/WorkbenchPermissionSheet';
import { WorkbenchQuestionSheet } from '@/modules/workbench/chat/WorkbenchQuestionSheet';

const createDiff = (before: string, after: string) => [
  ...(before ? [{ type: 'removed' as const, content: before, lineNum: 1 }] : []),
  ...(after ? [{ type: 'added' as const, content: after, lineNum: 1 }] : []),
];

const bash = (requestId: string, command: string): PendingPermissionRequest => ({
  requestId,
  toolName: 'Bash',
  input: { command, description: 'Run the unit tests' },
  sessionId: 's1',
});

describe('WorkbenchPermissionSheet', () => {
  test('shows the command and answers allow and deny with the runtime wording', () => {
    const onDecision = vi.fn();
    const requests = [bash('r1', 'npm test'), bash('r2', 'npm run lint')];
    render(<WorkbenchPermissionSheet requests={requests} allRequests={requests} provider="claude" onDecision={onDecision} onGrant={vi.fn()} createDiff={createDiff} />);

    // The heading says who wants what in one sentence; the command itself sits below it.
    expect(screen.getByRole('heading', { name: 'Claude Code 想运行命令' })).toBeTruthy();
    expect(screen.getByText('npm test')).toBeTruthy();
    expect(screen.getByText('Run the unit tests')).toBeTruthy();
    expect(screen.getByText('还有 1 个')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    expect(onDecision).toHaveBeenLastCalledWith('r1', { allow: true });
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(onDecision).toHaveBeenLastCalledWith('r1', { allow: false, message: 'User denied tool use' });
  });

  test('always-allow saves the rule and answers every identical pending prompt at once', () => {
    const onDecision = vi.fn();
    const onGrant = vi.fn(() => ({ success: true }));
    const requests = [bash('r1', 'npm test'), bash('r2', 'npm run lint'), bash('r3', 'git push')];
    render(<WorkbenchPermissionSheet requests={requests} allRequests={requests} provider="claude" onDecision={onDecision} onGrant={onGrant} createDiff={createDiff} />);

    fireEvent.click(screen.getByRole('button', { name: /始终允许/ }));
    expect(onGrant).toHaveBeenCalledWith({ entry: 'Bash(npm:*)', toolName: 'Bash' });
    expect(onDecision).toHaveBeenCalledWith(['r1', 'r2'], { allow: true, rememberEntry: 'Bash(npm:*)' });
  });

  test('an edit shows its target and diff; non-Claude providers get no remember option', () => {
    const request: PendingPermissionRequest = {
      requestId: 'e1', toolName: 'Edit', input: { file_path: '/repo/a.ts', old_string: 'old line', new_string: 'new line' },
    };
    render(<WorkbenchPermissionSheet requests={[request]} allRequests={[request]} provider="codex" onDecision={vi.fn()} onGrant={vi.fn()} createDiff={createDiff} />);
    expect(screen.getByRole('heading', { name: /Codex 想修改/ }).textContent).toContain('a.ts');
    expect(screen.getByText('new line')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /始终允许/ })).toBeNull();
  });
});

describe('WorkbenchQuestionSheet', () => {
  const request: PendingPermissionRequest = {
    requestId: 'q1',
    toolName: 'AskUserQuestion',
    input: {
      questions: [
        { question: '先做哪一步？', header: '顺序', options: [{ label: '前端' }, { label: '后端', description: '先改 API' }] },
        { question: '要哪些检查？', options: [{ label: '类型' }, { label: '测试' }], multiSelect: true },
      ],
    },
  };

  test('walks the questions and returns the answers as the updated tool input', () => {
    const onDecision = vi.fn();
    render(<WorkbenchQuestionSheet request={request} provider="claude" onDecision={onDecision} />);

    // The question's topic and its place in the prompt share one quiet badge.
    expect(screen.getByText('顺序 · 1/2')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /后端/ }));
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));

    fireEvent.click(screen.getByRole('checkbox', { name: '类型' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '其他' }));
    fireEvent.change(screen.getByLabelText('其他答案'), { target: { value: '构建' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    expect(onDecision).toHaveBeenCalledWith('q1', {
      allow: true,
      updatedInput: { ...(request.input as object), answers: { '先做哪一步？': '后端', '要哪些检查？': '类型, 构建' } },
    });
  });

  test('skipping answers nothing, so the agent decides on its own', () => {
    const onDecision = vi.fn();
    render(<WorkbenchQuestionSheet request={request} provider="claude" onDecision={onDecision} />);
    fireEvent.click(screen.getByRole('button', { name: '全部跳过' }));
    expect(onDecision).toHaveBeenCalledWith('q1', { allow: true, updatedInput: { ...(request.input as object), answers: {} } });
  });
});
