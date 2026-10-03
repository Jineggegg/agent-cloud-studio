import { memo, useMemo, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { History } from 'lucide-react';

import { LazyMessageRow, useLazyRowObserver } from '@/modules/chat';
import type { ChatMessage, DiffCalculator, PendingPermissionRequest, Project, WorkbenchPermissionDecision } from '@/shared/types';
import { WorkbenchSpinner } from '@/modules/workbench/chat/WorkbenchSpinner';
import { WorkbenchToolStack } from '@/modules/workbench/chat/WorkbenchToolStack';
import { WorkbenchPlanCard } from '@/modules/workbench/chat/WorkbenchPlanCard';
import {
  WorkbenchAgentPanel,
  WorkbenchAnsweredQuestion,
  WorkbenchAssistantMessage,
  WorkbenchNoticeRow,
  WorkbenchTurnLabel,
  WorkbenchUserMessage,
} from '@/modules/workbench/chat/WorkbenchMessageRow';
import { PLAN_TOOL_NAMES, readToolInput } from '@/modules/workbench/chat/utils/workbenchToolSummary';

// Rows nearest the end mount with real content on first paint so the opening scroll measures real heights.
const INITIAL_MOUNTED_TAIL_ROWS = 30;

// Live rows rise a short way while fading in. Opacity and transform only: a blur would leave a filter (and a
// compositing layer) on every settled row of a long transcript.
const ENTER = { opacity: 0, y: 14 };
const SETTLED = { opacity: 1, y: 0 };
const ENTER_SPRING = { type: 'spring', stiffness: 260, damping: 30, mass: 0.9 } as const;

type TranscriptItem =
  | { kind: 'user'; key: string; message: ChatMessage }
  | { kind: 'turn'; key: string; model: string | null }
  | { kind: 'assistant'; key: string; message: ChatMessage }
  | { kind: 'tools'; key: string; messages: ChatMessage[] }
  | { kind: 'plan'; key: string; message: ChatMessage }
  | { kind: 'question'; key: string; message: ChatMessage }
  | { kind: 'agent'; key: string; message: ChatMessage }
  | { kind: 'notice'; key: string; message: ChatMessage };

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
 * calls (with the reasoning between them) as one stack. Pure, so it is memoised on the message array.
 */
function buildTranscriptItems(messages: ChatMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const occurrences = new Map<string, number>();
  const keyOf = (message: ChatMessage) => {
    const base = intrinsicKey(message);
    const seen = occurrences.get(base) ?? 0;
    occurrences.set(base, seen + 1);
    return seen ? `${base}__${seen}` : base;
  };
  let stack: ChatMessage[] = [];
  let stackKey = '';
  let openTurn: Extract<TranscriptItem, { kind: 'turn' }> | null = null;
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
    const turn = openTurn as Extract<TranscriptItem, { kind: 'turn' }> | null;
    if (turn && !turn.model && typeof message.model === 'string') turn.model = message.model;
    items.push({ kind: 'assistant', key, message });
  }
  flushStack();
  return items;
}

/** The plan text of an ExitPlanMode call, with literal `\n` sequences some transcripts carry turned into newlines. */
function readPlan(message: ChatMessage): string {
  const plan = readToolInput(message.toolInput).plan;
  return typeof plan === 'string' ? plan.replace(/\\n/g, '\n') : '';
}

type WorkbenchTranscriptProps = {
  // Identity of the conversation on screen. It survives a new chat receiving its session id and changes on any other
  // switch, which resets which rows count as history.
  sessionKey: string;
  // A chat with no session yet: there is no history to wait for.
  isNewChat: boolean;
  messages: ChatMessage[];
  provider: string;
  project: Project;
  scrollRef: RefObject<HTMLDivElement>;
  // Wheel and touch: a short transcript never scrolls, so these are the only signals that reach the pager.
  onScrollIntent: () => void;
  isLoading: boolean;
  runActive: boolean;
  showTyping: boolean;
  // Loaded rows outside the render window, revealed by 显示更早的.
  hiddenCount: number;
  onShowEarlier: () => void;
  hasMoreHistory: boolean;
  isLoadingHistory: boolean;
  onLoadAllHistory: () => void;
  createDiff: DiffCalculator;
  onOpenFile: (path: string) => void;
  pendingPlanRequest: PendingPermissionRequest | null;
  onDecision: WorkbenchPermissionDecision;
  onEditMessage?: (message: ChatMessage) => void;
  emptyState: ReactNode;
  // Earlier stretches of a conversation handed between providers, drawn above this session's own rows.
  prelude?: ReactNode;
};

/**
 * Used by WorkbenchAgentChat as the scrolling conversation. Rows outside a band around the viewport unmount to
 * fixed-height placeholders (the inherited lazy-row observer), so a thousand-turn session scrolls like a short one;
 * rows that arrive live rise into place, rows loaded from history do not.
 */
export const WorkbenchTranscript = memo(function WorkbenchTranscript({
  sessionKey,
  isNewChat,
  messages,
  provider,
  project,
  scrollRef,
  onScrollIntent,
  isLoading,
  runActive,
  showTyping,
  hiddenCount,
  onShowEarlier,
  hasMoreHistory,
  isLoadingHistory,
  onLoadAllHistory,
  createDiff,
  onOpenFile,
  pendingPlanRequest,
  onDecision,
  onEditMessage,
  emptyState,
  prelude,
}: WorkbenchTranscriptProps) {
  const lazyRows = useLazyRowObserver(scrollRef);
  const items = useMemo(() => buildTranscriptItems(messages), [messages]);
  const lastPlanKey = useMemo(() => [...items].reverse().find((item) => item.kind === 'plan')?.key ?? null, [items]);

  // Rows that were already there once this conversation's history arrived: they never animate in, every row after
  // them rises into place. Null until the history is in (a new chat has none, so it starts empty). Adjusted during
  // render when the conversation changes. A live row remounted by the lazy-row band replays its entrance, but it
  // mounts 1200px outside the viewport, so nobody sees it.
  const [baseline, setBaseline] = useState<{ session: string; keys: ReadonlySet<string> | null }>({ session: sessionKey, keys: null });
  const historyReady = !isLoading && (items.length > 0 || isNewChat);
  if (baseline.session !== sessionKey) {
    setBaseline({ session: sessionKey, keys: historyReady ? new Set(items.map((item) => item.key)) : null });
  } else if (baseline.keys === null && historyReady) {
    setBaseline({ session: sessionKey, keys: new Set(items.map((item) => item.key)) });
  }
  const seenKeys = baseline.session === sessionKey ? baseline.keys : null;

  const renderItem = (item: TranscriptItem): ReactNode => {
    switch (item.kind) {
      case 'user':
        return <WorkbenchUserMessage message={item.message} projectId={project.projectId} onEdit={onEditMessage} />;
      case 'turn':
        return <WorkbenchTurnLabel provider={provider} model={item.model} />;
      case 'assistant':
        return <WorkbenchAssistantMessage message={item.message} provider={provider} turnStart={false} />;
      case 'tools':
        return <WorkbenchToolStack messages={item.messages} runActive={runActive} createDiff={createDiff} onOpenFile={onOpenFile} />;
      case 'plan': {
        const pending = item.key === lastPlanKey ? pendingPlanRequest : null;
        return (
          <WorkbenchPlanCard
            plan={readPlan(item.message)}
            pendingRequest={pending}
            onDecision={onDecision}
            isWriting={runActive && !item.message.toolResult && !pending}
          />
        );
      }
      case 'question':
        return <WorkbenchAnsweredQuestion message={item.message} />;
      case 'agent':
        return <WorkbenchAgentPanel message={item.message} createDiff={createDiff} onOpenFile={onOpenFile} project={project} />;
      default:
        return <WorkbenchNoticeRow message={item.message} />;
    }
  };

  const showEmpty = !isLoading && messages.length === 0;

  return (
    <div
      ref={scrollRef}
      className="wbc-scroll is-agent"
      onWheel={onScrollIntent}
      onTouchMove={onScrollIntent}
      aria-busy={isLoading || runActive}
    >
      <div className="wbc-thread" role="log" aria-live="polite" aria-relevant="additions">
        {prelude}
        {isLoading && messages.length === 0 && (
          <div className="wbc-skeleton" role="status" aria-label="正在载入对话">
            <span className="wbc-skel is-bubble" />
            <span className="wbc-skel is-line" />
            <span className="wbc-skel is-line is-long" />
            <span className="wbc-skel is-line is-short" />
            <span className="wbc-skel is-card" />
          </div>
        )}
        {showEmpty && emptyState}

        {(hiddenCount > 0 || hasMoreHistory) && (
          <div className="wbc-history">
            {isLoadingHistory ? (
              <span className="wbc-history-loading"><WorkbenchSpinner size={14} />正在载入更早的消息</span>
            ) : hiddenCount > 0 ? (
              <button type="button" className="wbc-history-button" onClick={onShowEarlier}>
                <History size={14} aria-hidden="true" />显示更早的 {hiddenCount} 条
              </button>
            ) : (
              <button type="button" className="wbc-history-button" onClick={onLoadAllHistory}>
                <History size={14} aria-hidden="true" />载入全部历史
              </button>
            )}
          </div>
        )}

        {items.map((item, index) => {
          const animateIn = seenKeys !== null && !seenKeys.has(item.key);
          return (
            <LazyMessageRow
              key={item.key}
              lazyRows={lazyRows}
              timestamp={'message' in item ? item.message.timestamp : 'messages' in item ? item.messages[0]?.timestamp : undefined}
              initiallyNearViewport={index >= items.length - INITIAL_MOUNTED_TAIL_ROWS}
            >
              <m.div
                className={`wbc-item is-${item.kind}`}
                initial={animateIn ? ENTER : false}
                animate={SETTLED}
                transition={ENTER_SPRING}
              >
                {renderItem(item)}
              </m.div>
            </LazyMessageRow>
          );
        })}

        <AnimatePresence>
          {showTyping && (
            <m.div
              key="typing"
              className="wbc-typing"
              role="status"
              aria-label="正在回复"
              initial={{ opacity: 0, y: 8, scale: 0.92 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.14 } }}
              transition={ENTER_SPRING}
            >
              <span /><span /><span />
            </m.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
});
