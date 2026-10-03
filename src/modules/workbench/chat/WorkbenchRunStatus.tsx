import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { Check, Hand } from 'lucide-react';

import type { WorkbenchTodoItem } from '@/shared/types';
import { WorkbenchSpinner } from '@/modules/workbench/chat/WorkbenchSpinner';
import { WorkbenchTodoList } from '@/modules/workbench/chat/WorkbenchTodoList';

// The pill's own iOS-like spring: quick to settle, a touch of give, no visible bounce.
const PILL_SPRING = { type: 'spring', stiffness: 460, damping: 36, mass: 0.7 } as const;
// The steps popover blooms from the pill a little livelier, like the composer's other popovers.
const POPOVER_SPRING = { type: 'spring', stiffness: 520, damping: 36, mass: 0.7 } as const;
// How long the finished state lingers before the pill tucks away.
const FINISHED_LINGER_MS = 2600;

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
}

/**
 * What the run is doing, which picks the pill's glyph: the model composing (the typing dots that used to sit alone
 * at the end of the transcript), a tool running (the spinner) or the run paused on the owner (a raised hand).
 */
type WorkbenchRunPhase = 'composing' | 'working' | 'waiting';

type WorkbenchRunStatusProps = {
  active: boolean;
  // What the agent is doing now: `正在运行 npm test`, the provider's status line, or 正在思考.
  activity: string;
  phase: WorkbenchRunPhase;
  startedAt: number | null;
  // The run's newest checklist, when the agent keeps one.
  todos: WorkbenchTodoItem[] | null;
  // How many times the owner has asked to stop a run in this chat (the send disc or Esc); a count that rose during
  // the run makes its summary say 已停止 rather than 本轮完成.
  stopRequests: number;
};

/**
 * Used by WorkbenchAgentChat, which hands it to WorkbenchComposer for the toolbar's right end, just left of the
 * send/stop disc: a compact pill for as long as a run lasts — what the agent is doing, how far through its
 * checklist (tap to unfold the steps upwards in a popover anchored to the pill) and for how long. The disc beside it
 * is the one stop control. When the run ends the pill says so briefly, then tucks away. As the toolbar narrows the
 * pill sheds its words, then its step count, keeping the glyph and the time (see the `wbc-bar` container queries).
 */
export function WorkbenchRunStatus({ active, activity, phase, startedAt, todos, stopRequests }: WorkbenchRunStatusProps) {
  const reduceMotion = useReducedMotion();
  const popoverId = useId();
  const anchorRef = useRef<HTMLDivElement>(null);
  // Clock for the elapsed time; ticks once a second only while a run is active.
  const [now, setNow] = useState(() => Date.now());
  // Whether the steps popover is open.
  const [expanded, setExpanded] = useState(false);
  // The just-finished run's summary (已停止 or 本轮完成, and how long it took), shown for a moment after `active` drops.
  const [finished, setFinished] = useState<{ label: string; took: string | null } | null>(null);
  // The stop count when the current run began, to tell a stopped run from a completed one when it ends.
  const [stopRequestsAtStart, setStopRequestsAtStart] = useState(stopRequests);
  // When the current run started; kept past its end, when the activity entry (and its start time) is gone.
  const [runStartedAt, setRunStartedAt] = useState(startedAt);
  // `active` as of the last render, to catch the run starting and ending (state adjusted during render).
  const [wasActive, setWasActive] = useState(active);

  if (startedAt && startedAt !== runStartedAt) setRunStartedAt(startedAt);
  if (active !== wasActive) {
    setWasActive(active);
    if (active) {
      setStopRequestsAtStart(stopRequests);
      setFinished(null);
    } else {
      setFinished({
        label: stopRequests > stopRequestsAtStart ? '已停止' : '本轮完成',
        took: runStartedAt ? formatElapsed(now - runStartedAt) : null,
      });
      setExpanded(false);
    }
  }

  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (!finished) return undefined;
    const timer = window.setTimeout(() => setFinished(null), FINISHED_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [finished]);

  // A tap anywhere outside the pill and its popover folds the steps away.
  useEffect(() => {
    if (!expanded) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setExpanded(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [expanded]);

  const visible = active || finished !== null;
  const isFinished = !active && finished !== null;
  const total = todos?.length ?? 0;
  const done = todos?.filter((todo) => todo.status === 'completed').length ?? 0;
  const ratio = total ? done / total : 0;
  const showSteps = total > 0 && !isFinished;
  const text = isFinished ? finished.label : activity;
  const time = isFinished ? finished.took : active && startedAt ? formatElapsed(now - startedAt) : null;
  const label = [text, showSteps ? `步骤 ${done}/${total}` : null, time ? `${isFinished ? '用时 ' : '已用 '}${time}` : null]
    .filter(Boolean)
    .join('，');
  const snap = { duration: 0 } as const;

  // Esc with the steps open folds them away; it must not also reach the column, where Esc stops the run.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !expanded) return;
    event.preventDefault();
    setExpanded(false);
  };

  return (
    <AnimatePresence initial={false}>
      {visible && (
        // The anchor's width springs open and shut, so the chips to its left slide aside rather than jump.
        <m.div
          key="run-status"
          ref={anchorRef}
          className="wbc-run-anchor"
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 'auto', opacity: 1 }}
          exit={{ width: 0, opacity: 0, transition: reduceMotion ? snap : { ...PILL_SPRING, opacity: { duration: 0.14 } } }}
          transition={reduceMotion ? snap : PILL_SPRING}
          onKeyDown={onKeyDown}
        >
          <AnimatePresence>
            {expanded && showSteps && todos && (
              <m.div
                key="steps"
                id={popoverId}
                className="wbc-run-pop"
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.94 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reduceMotion ? { opacity: 0, transition: snap } : { opacity: 0, y: 6, scale: 0.97, transition: { duration: 0.12 } }}
                transition={reduceMotion ? snap : POPOVER_SPRING}
              >
                <div className="wbc-run-pop-head">
                  <span>本轮步骤</span>
                  <span className="wbc-run-pop-count">{done}/{total}</span>
                </div>
                <div className="wbc-run-progress" aria-hidden="true">
                  <m.span initial={false} animate={{ scaleX: ratio }} transition={reduceMotion ? snap : { type: 'spring', stiffness: 120, damping: 20 }} />
                </div>
                <WorkbenchTodoList todos={todos} />
              </m.div>
            )}
          </AnimatePresence>
          <m.div
            role="group"
            aria-label="本轮运行状态"
            className={`wbc-run is-${isFinished ? 'finished' : phase}${expanded ? ' is-expanded' : ''}`}
            initial={reduceMotion ? false : { scale: 0.7 }}
            animate={{ scale: 1 }}
            exit={reduceMotion ? undefined : { scale: 0.7 }}
            transition={reduceMotion ? snap : PILL_SPRING}
          >
            <button
              type="button"
              className="wbc-run-main"
              aria-label={showSteps ? `${label}，${expanded ? '收起' : '展开'}步骤` : label}
              aria-expanded={showSteps ? expanded : undefined}
              aria-controls={showSteps && expanded ? popoverId : undefined}
              title={text}
              disabled={!showSteps}
              onClick={() => setExpanded((value) => !value)}
            >
              <span className="wbc-run-glyph" aria-hidden="true">
                {isFinished ? <Check size={15} strokeWidth={2.8} />
                  : phase === 'waiting' ? <Hand size={15} strokeWidth={2.2} />
                    : phase === 'working' ? <WorkbenchSpinner size={15} />
                      : <span className="wbc-run-dots"><i /><i /><i /></span>}
              </span>
              {/* The button's label names everything; the words still announce each change of state. */}
              <span className="wbc-run-text" aria-live="polite">{text}</span>
              {showSteps && <span className="wbc-run-count">{done}/{total}</span>}
              {time && <span className="wbc-run-time">{time}</span>}
            </button>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
