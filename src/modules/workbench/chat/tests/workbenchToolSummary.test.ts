import { describe, expect, test } from 'vitest';

import type { ChatMessage } from '@/shared/types';
import {
  describeCurrentActivity,
  describeToolCall,
  findLatestTodos,
  readTodos,
  readToolStatus,
  summarizeTool,
} from '@/modules/workbench/chat/utils/workbenchToolSummary';

const tool = (toolName: string, input: unknown, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'assistant',
  timestamp: '2026-10-02T08:00:00.000Z',
  isToolUse: true,
  toolName,
  toolInput: JSON.stringify(input),
  toolResult: null,
  ...extra,
});

describe('describeToolCall', () => {
  test('names commands, files and searches the way the cards show them', () => {
    expect(describeToolCall('Bash', { command: 'npm   test\n --watch=false' })).toEqual({ kind: 'command', verb: '运行', target: 'npm test --watch=false' });
    expect(describeToolCall('Edit', { file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' }))
      .toEqual({ kind: 'edit', verb: '编辑', target: 'app.ts', filePath: '/repo/src/app.ts' });
    expect(describeToolCall('Write', { file_path: 'C:\\repo\\notes.md' })).toMatchObject({ kind: 'write', target: 'notes.md' });
    expect(describeToolCall('Grep', { pattern: 'useChat' })).toMatchObject({ kind: 'search', verb: '搜索', target: 'useChat' });
    expect(describeToolCall('mcp__github__create_issue', { title: 'x' })).toMatchObject({ kind: 'other', verb: 'create_issue · github' });
  });

  test('summarises a checklist by the step in flight, or by progress', () => {
    expect(describeToolCall('TodoWrite', { todos: [
      { content: 'Plan', status: 'completed' },
      { content: 'Build', activeForm: 'Building the column', status: 'in_progress' },
    ] }).target).toBe('Building the column');
    expect(describeToolCall('TodoWrite', { todos: [{ content: 'Plan', status: 'completed' }, { content: 'Ship', status: 'pending' }] }).target)
      .toBe('1/2 已完成');
  });
});

describe('readToolStatus', () => {
  test('a result settles the call; a denial reads as denied, not failed', () => {
    expect(readToolStatus(tool('Bash', {}), true)).toBe('running');
    expect(readToolStatus(tool('Bash', {}), false)).toBe('idle');
    expect(readToolStatus(tool('Bash', {}, { toolResult: { content: 'ok' } }), true)).toBe('done');
    expect(readToolStatus(tool('Bash', {}, { toolResult: { content: 'exit 1', isError: true } }), false)).toBe('error');
    expect(readToolStatus(tool('Bash', {}, { toolResult: { content: 'User denied tool use', isError: true } }), false)).toBe('denied');
    expect(readToolStatus(tool('Bash', {}, { toolStatus: 'in_progress', toolResult: { content: 'partial' } }), true)).toBe('running');
  });
});

describe('checklists and activity', () => {
  test('reads todos, skipping malformed entries, and finds the newest list', () => {
    expect(readTodos(JSON.stringify({ todos: [{ content: 'A', status: 'weird' }, null, { status: 'completed' }] })))
      .toEqual([{ content: 'A', activeForm: undefined, status: 'pending' }]);
    const messages = [
      tool('TodoWrite', { todos: [{ content: 'old', status: 'pending' }] }),
      tool('TodoWrite', { todos: [{ content: 'new', status: 'in_progress' }] }),
    ];
    expect(findLatestTodos(messages)?.[0].content).toBe('new');
  });

  test('describes the newest unfinished call, and nothing once the owner has spoken since', () => {
    const running = tool('Bash', { command: 'npm run build' });
    expect(describeCurrentActivity([running])).toBe('正在运行 npm run build');
    expect(describeCurrentActivity([running, { type: 'user', content: 'stop', timestamp: '' }])).toBeNull();
    expect(summarizeTool({ type: 'assistant', isThinking: true, content: 'Weighing options', timestamp: '' }, true))
      .toMatchObject({ kind: 'think', verb: '思考', status: 'done' });
  });
});
