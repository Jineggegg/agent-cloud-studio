import type { ChatMessage, WorkbenchTodoItem, WorkbenchToolSummary } from '@/shared/types';

/*
 * Reads tool calls the way the workbench chat column shows them: one verb, one target, one status. Shared by the
 * tool cards, the run island and the permission sheet, which must describe the same call in the same words.
 */

// Exact denial texts from the Claude runtime adapter; other providers cannot signal a denial reliably.
const DENIAL_MESSAGES = ['user denied tool use', 'tool disallowed by settings', 'permission request timed out', 'permission request cancelled'];

// Tools whose arguments name a file the shell can open.
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'ApplyPatch', 'MultiEdit', 'NotebookEdit']);

/** Tool calls normalised to `TodoWrite` by both providers (Codex `update_plan`/`todo_list` are renamed server side). */
export const TODO_TOOL_NAMES = new Set(['TodoWrite']);
/** Plan approval calls, drawn as the plan card. */
export const PLAN_TOOL_NAMES = new Set(['ExitPlanMode', 'exit_plan_mode']);

/** Tool input as an object: rows carry it JSON-serialised (normalizedToChatMessages), live permission prompts as objects. */
export function readToolInput(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    // A bare command string is the whole payload for some tools.
    return typeof parsed === 'string' ? { command: parsed } : {};
  } catch {
    return raw.trim() ? { command: raw } : {};
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Last path segment, for compact targets; the full path stays in the tooltip and the open action. */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Collapses whitespace so multi-line commands fit the one-line card. */
function oneLine(value: string, max = 160): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** The checklist a TodoWrite call carries, with unknown statuses read as pending. */
export function readTodos(rawInput: unknown): WorkbenchTodoItem[] {
  const todos = readToolInput(rawInput).todos;
  if (!Array.isArray(todos)) return [];
  return todos.flatMap((todo): WorkbenchTodoItem[] => {
    if (!todo || typeof todo !== 'object') return [];
    const record = todo as Record<string, unknown>;
    const content = text(record.content) || text(record.step) || text(record.text);
    if (!content) return [];
    const status = record.status === 'completed' || record.status === 'in_progress' ? record.status : 'pending';
    return [{ content, activeForm: text(record.activeForm) || undefined, status }];
  });
}

/** The newest checklist in the transcript, or null when the agent never wrote one. */
export function findLatestTodos(messages: ChatMessage[]): WorkbenchTodoItem[] | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.isToolUse && TODO_TOOL_NAMES.has(String(message.toolName))) {
      const todos = readTodos(message.toolInput);
      if (todos.length > 0) return todos;
    }
  }
  return null;
}

/** Live status of a call: a provider-reported lifecycle wins, then the result, then whether the run is still going. */
export function readToolStatus(message: ChatMessage, runActive: boolean): WorkbenchToolSummary['status'] {
  if (message.toolStatus === 'in_progress') return runActive ? 'running' : 'idle';
  if (message.toolStatus === 'failed') return 'error';
  const result = message.toolResult;
  if (!result) return runActive ? 'running' : 'idle';
  if (result.isError) {
    const content = String(result.content ?? '').toLowerCase();
    return DENIAL_MESSAGES.some((denial) => content.includes(denial)) ? 'denied' : 'error';
  }
  return 'done';
}

/** `mcp__server__tool` reads as `tool · server`. */
function mcpLabel(toolName: string): string | null {
  const match = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(toolName);
  return match ? `${match[2]} · ${match[1]}` : null;
}

/** First descriptive argument of an unknown tool, so the card says what it acted on. */
function describeUnknownInput(input: Record<string, unknown>): string {
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'name', 'skill']) {
    const value = text(input[key]);
    if (value.trim()) return oneLine(value);
  }
  const keys = Object.keys(input);
  return keys.length ? keys.slice(0, 3).join(', ') : '';
}

/** Kind, verb and target for a tool name and its input; shared by transcript rows and permission prompts. */
export function describeToolCall(toolName: string, rawInput: unknown): Omit<WorkbenchToolSummary, 'status'> {
  const input = readToolInput(rawInput);
  const filePath = text(input.file_path) || text(input.notebook_path) || text(input.path);
  const withFile = FILE_TOOLS.has(toolName) && filePath ? { filePath } : {};
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return { kind: 'command', verb: '运行', target: oneLine(text(input.command)) };
    case 'Read':
      return { kind: 'read', verb: '读取', target: fileName(filePath), ...withFile };
    case 'Edit':
    case 'MultiEdit':
    case 'ApplyPatch':
    case 'NotebookEdit':
      return { kind: 'edit', verb: '编辑', target: fileName(filePath), ...withFile };
    case 'Write':
      return { kind: 'write', verb: '写入', target: fileName(filePath), ...withFile };
    case 'Grep':
      return { kind: 'search', verb: '搜索', target: oneLine(text(input.pattern)) };
    case 'Glob':
      return { kind: 'search', verb: '查找文件', target: oneLine(text(input.pattern)) };
    case 'WebSearch':
      return { kind: 'web', verb: '联网搜索', target: oneLine(text(input.query)) };
    case 'WebFetch':
      return { kind: 'web', verb: '打开网页', target: oneLine(text(input.url)) };
    case 'TodoWrite': {
      const todos = readTodos(input);
      const done = todos.filter((todo) => todo.status === 'completed').length;
      const active = todos.find((todo) => todo.status === 'in_progress');
      return { kind: 'todo', verb: '更新清单', target: active ? oneLine(active.activeForm || active.content) : todos.length ? `${done}/${todos.length} 已完成` : '' };
    }
    case 'Task':
    case 'Agent':
      return { kind: 'agent', verb: '子任务', target: oneLine(text(input.description) || text(input.subagent_type)) };
    case 'ExitPlanMode':
    case 'exit_plan_mode':
      return { kind: 'plan', verb: '提交计划', target: '' };
    case 'AskUserQuestion':
      return { kind: 'question', verb: '提问', target: '' };
    default:
      return { kind: 'other', verb: mcpLabel(toolName) ?? toolName, target: describeUnknownInput(input) };
  }
}

/** Card summary of a transcript tool row; thinking rows (folded into the same stacks) read as 思考. */
export function summarizeTool(message: ChatMessage, runActive: boolean): WorkbenchToolSummary {
  if (message.isThinking) {
    return { kind: 'think', verb: '思考', target: oneLine(String(message.content ?? ''), 90), status: 'done' };
  }
  return { ...describeToolCall(String(message.toolName ?? 'Tool'), message.toolInput), status: readToolStatus(message, runActive) };
}

/** What the agent is doing right now, from the newest unfinished call: `正在运行 npm test`. */
export function describeCurrentActivity(messages: ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= Math.max(0, messages.length - 40); index -= 1) {
    const message = messages[index];
    if (message.type === 'user') return null;
    if (message.isToolUse && !message.toolResult && message.toolStatus !== 'completed') {
      const call = describeToolCall(String(message.toolName ?? ''), message.toolInput);
      if (call.kind === 'todo' || call.kind === 'plan' || call.kind === 'question') return null;
      return `正在${call.verb}${call.target ? ` ${call.target}` : ''}`;
    }
  }
  return null;
}
