import { memo, useMemo, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { m } from 'motion/react';
import { History } from 'lucide-react';

import { LazyMessageRow, useLazyRowObserver } from '@/modules/chat';
import type {
  ChatMessage, DiffCalculator, PendingPermissionRequest, Project, WorkbenchPermissionDecision, WorkbenchTranscriptRow,
} from '@/shared/types';
import { WorkbenchSessionHistoryContext } from '@/modules/workbench/context/WorkbenchSessionHistoryContext';
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
import { buildWorkbenchTranscriptRows } from '@/modules/workbench/chat/utils/workbenchTranscriptRows';
import { readToolInput } from '@/modules/workbench/chat/utils/workbenchToolSummary';

// Rows nearest the end mount with real content on first paint so the opening scroll measures real heights.
const INITIAL_MOUNTED_TAIL_ROWS = 30;

// Live rows rise a short way while fading in. Opacity and transform only: a blur would leave a filter (and a
// compositing layer) on every settled row of a long transcript.
const ENTER = { opacity: 0, y: 14 };
const SETTLED = { opacity: 1, y: 0 };
const ENTER_SPRING = { type: 'spring', stiffness: 260, damping: 30, mass: 0.9 } as const;

/** The plan text of an ExitPlanMode call, with literal `\n` sequences some transcripts carry turned into newlines. */
function readPlan(message: ChatMessage): string {
  const plan = readToolInput(message.toolInput).plan;
  return typeof plan === 'string' ? plan.replace(/\\n/g, '\n') : '';
}

type WorkbenchTranscriptItemProps = {
  item: WorkbenchTranscriptRow;
  provider: string;
  project: Project;
  // A tool call without a result is still running only while a run is active; otherwise it shows as unfinished.
  runActive: boolean;
  createDiff: DiffCalculator;
  onOpenFile: (path: string) => void;
  // The ExitPlanMode prompt awaiting an answer when this item is the plan it belongs to; null otherwise.
  pendingPlanRequest: PendingPermissionRequest | null;
  onDecision: WorkbenchPermissionDecision;
  // Present when the provider can re-run from the owner's turn and the session is idle.
  onEditMessage?: (message: ChatMessage) => void;
};

/**
 * Used by WorkbenchTranscript for each row of the open session, and by WorkbenchHandoffPrelude for the rows of an
 * earlier stretch (read-only: never running, no pending plan, no edit), so both draw a turn the same way.
 */
export function WorkbenchTranscriptItem({
  item, provider, project, runActive, createDiff, onOpenFile, pendingPlanRequest, onDecision, onEditMessage,
}: WorkbenchTranscriptItemProps): ReactNode {
  switch (item.kind) {
    case 'user':
      return <WorkbenchUserMessage message={item.message} projectId={project.projectId} onEdit={onEditMessage} />;
    case 'turn':
      return <WorkbenchTurnLabel provider={provider} model={item.model} />;
    case 'assistant':
      return <WorkbenchAssistantMessage message={item.message} provider={provider} turnStart={false} />;
    case 'tools':
      return <WorkbenchToolStack messages={item.messages} runActive={runActive} createDiff={createDiff} onOpenFile={onOpenFile} />;
    case 'plan':
      return (
        <WorkbenchPlanCard
          plan={readPlan(item.message)}
          pendingRequest={pendingPlanRequest}
          onDecision={onDecision}
          isWriting={runActive && !item.message.toolResult && !pendingPlanRequest}
        />
      );
    case 'question':
      return <WorkbenchAnsweredQuestion message={item.message} />;
    case 'agent':
      return <WorkbenchAgentPanel message={item.message} createDiff={createDiff} onOpenFile={onOpenFile} project={project} />;
    default:
      return <WorkbenchNoticeRow message={item.message} />;
  }
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
  // Earlier stretches of a conversation handed between providers, drawn above this session's own rows once those
  // are shown from the first (WorkbenchSessionHistoryContext tells the prelude when).
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
  const items = useMemo(() => buildWorkbenchTranscriptRows(messages), [messages]);
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

  const showEmpty = !isLoading && messages.length === 0;
  // Earlier stretches belong above this session's first row: until that row is on screen they wait.
  const olderRowsPending = (isLoading && messages.length === 0) || hasMoreHistory || hiddenCount > 0;
  const sessionHistory = useMemo(() => ({ olderRowsPending }), [olderRowsPending]);

  return (
    <div
      ref={scrollRef}
      className="wbc-scroll is-agent"
      onWheel={onScrollIntent}
      onTouchMove={onScrollIntent}
      aria-busy={isLoading || runActive}
    >
      <div className="wbc-thread" role="log" aria-live="polite" aria-relevant="additions">
        {prelude && <WorkbenchSessionHistoryContext.Provider value={sessionHistory}>{prelude}</WorkbenchSessionHistoryContext.Provider>}
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
                <WorkbenchTranscriptItem
                  item={item}
                  provider={provider}
                  project={project}
                  runActive={runActive}
                  createDiff={createDiff}
                  onOpenFile={onOpenFile}
                  pendingPlanRequest={item.key === lastPlanKey ? pendingPlanRequest : null}
                  onDecision={onDecision}
                  onEditMessage={onEditMessage}
                />
              </m.div>
            </LazyMessageRow>
          );
        })}
      </div>
    </div>
  );
});
