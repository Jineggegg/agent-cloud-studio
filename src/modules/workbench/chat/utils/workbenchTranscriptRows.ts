import type { ChatMessage, WorkbenchTranscriptRow } from '@/shared/types';
import { PLAN_TOOL_NAMES } from '@/modules/workbench/chat/utils/workbenchToolSummary';

/*
 * Folds a session's flat message list into the rows the workbench chat column draws. Kept apart from the
 * transcript component because the handoff prelude folds earlier stretches by the same rules.
 */

/** Stable identity of a row across refreshes: provider ids first, then time, tool and a content prefix. */
function intrinsicKey(message: ChatMessage): string {
  for (const candidate of [message.id, message.messageId, message.toolId, message.toolCallId]) {
    if ((typeof candidate === 'string' || typeof candidate === 'number') && String(candidate).trim()) {
      return `${message.type}-${String(candidate)}`;
    }
  }
  const time = new Date(message.timestamp).getTime();
  return `${message.type}-${Number.isFinite(time) ? time : 'x'}-${String(message.toolName ?? '')}-${String(message.content ?? '').slice(0, 32)}`;
}

/** Tool calls that render as a row inside a stack; agents, workflows, plans and questions own whole cards. */
function isStackedTool(message: ChatMessage): boolean {
  if (!message.isToolUse) return false;
  const name = String(message.toolName ?? '');
  return !message.isSubagentContainer && name !== 'Workflow' && name !== 'AskUserQuestion' && !PLAN_TOOL_NAMES.has(name);
}

/**
 * Folds the flat message list into what the column draws: a label at each agent turn, prose, and runs of tool
 * calls (with the reasoning between them) as one stack. Pure, so callers memoise it on the message array. Used by
 * WorkbenchTranscript and WorkbenchHandoffPrelude, so an earlier stretch of a handed-over conversation folds exactly
 * like a live session.
 */
export function buildWorkbenchTranscriptRows(messages: ChatMessage[]): WorkbenchTranscriptRow[] {
  const items: WorkbenchTranscriptRow[] = [];
  const occurrences = new Map<string, number>();
  const keyOf = (message: ChatMessage) => {
    const base = intrinsicKey(message);
    const seen = occurrences.get(base) ?? 0;
    occurrences.set(base, seen + 1);
    return seen ? `${base}__${seen}` : base;
  };
  let stack: ChatMessage[] = [];
  let stackKey = '';
  let openTurn: Extract<WorkbenchTranscriptRow, { kind: 'turn' }> | null = null;
  let turnPending = true;

  const flushStack = () => {
    if (stack.length) items.push({ kind: 'tools', key: `tools-${stackKey}`, messages: stack });
    stack = [];
  };
  const startTurnIfNeeded = (key: string) => {
    if (!turnPending) return;
    openTurn = { kind: 'turn', key: `turn-${key}`, model: null };
    items.push(openTurn);
    turnPending = false;
  };

  for (const message of messages) {
    const key = keyOf(message);
    if (message.type === 'user') {
      flushStack();
      items.push({ kind: 'user', key, message });
      turnPending = true;
      openTurn = null;
      continue;
    }
    if (message.isThinking || isStackedTool(message)) {
      startTurnIfNeeded(key);
      if (!stack.length) stackKey = key;
      stack.push(message);
      continue;
    }
    flushStack();
    if (message.type === 'error' || message.isTaskNotification || message.compact) {
      items.push({ kind: 'notice', key, message });
      continue;
    }
    startTurnIfNeeded(key);
    if (message.isToolUse) {
      const name = String(message.toolName ?? '');
      items.push({
        kind: PLAN_TOOL_NAMES.has(name) ? 'plan' : name === 'AskUserQuestion' ? 'question' : 'agent',
        key,
        message,
      });
      continue;
    }
    const turn = openTurn as Extract<WorkbenchTranscriptRow, { kind: 'turn' }> | null;
    if (turn && !turn.model && typeof message.model === 'string') turn.model = message.model;
    items.push({ kind: 'assistant', key, message });
  }
  flushStack();
  return items;
}
