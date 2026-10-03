import { useEffect, useState } from 'react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { Check, ChevronDown, Hand, Square } from 'lucide-react';

import type { WorkbenchTodoItem } from '@/shared/types';
import { WorkbenchSpinner } from '@/modules/workbench/chat/WorkbenchSpinner';
import { WorkbenchTodoList } from '@/modules/workbench/chat/WorkbenchTodoList';

// The row's own iOS-like spring: quick to settle, a touch of give, no visible bounce.
const ROW_SPRING = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 } as const;
// How long the finished state lingers before the row tucks away.
const FINISHED_LINGER_MS = 2600;

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
}

/**
 * What the run is doing, which picks the row's glyph: the model composing (the typing dots that used to sit alone
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
  canStop: boolean;
  onStop: () => void;
};

/**
 * Used by WorkbenchAgentChat at the top of its dock, so it reads as the transcript's last line and sits right above
 * the composer (or the sheet standing in for it): one row for as long as a run lasts — what the agent is doing, how
 * far through its checklist (tap to unfold the steps above the row), for how long, and a stop button. Being outside
 * the scroller it stays in view while the transcript scrolls and never covers a message. When the run ends it says
 * so briefly, then tucks away.
 */
export function WorkbenchRunStatus({ active, activity, phase, startedAt, todos, canStop, onStop }: WorkbenchRunStatusProps) {
  const reduceMotion = useReducedMotion();
  // Clock for the elapsed time; ticks once a second only while a run is active.
  const [now, setNow] = useState(() => Date.now());
  // Whether the checklist is unfolded.
  const [expanded, setExpanded] = useState(false);
  // The just-finished run's summary line, shown for a moment after `active` drops.
  const [finished, setFinished] = useState<string | null>(null);
  // Whether the owner pressed stop during this run, so the summary says 已停止 rather than 本轮完成.
  const [stopped, setStopped] = useState(false);
  // When the current run started; kept past its end, when the activity entry (and its start time) is gone.
  const [runStartedAt, setRunStartedAt] = useState(startedAt);
  // `active` as of the last render, to catch the run starting and ending (state adjusted during render).
  const [wasActive, setWasActive] = useState(active);

  if (startedAt && startedAt !== runStartedAt) setRunStartedAt(startedAt);
  if (active !== wasActive) {
    setWasActive(active);
    if (active) {
      setStopped(false);
      setFinished(null);
    } else {
      const took = runStartedAt ? formatElapsed(now - runStartedAt) : null;
      setFinished(`${stopped ? '已停止' : '本轮完成'}${took ? ` · 用时 ${took}` : ''}`);
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

  const visible = active || finished !== null;
  const isFinished = !active && finished !== null;
  const total = todos?.length ?? 0;
  const done = todos?.filter((todo) => todo.status === 'completed').length ?? 0;
  const ratio = total ? done / total : 0;
  const elapsed = active && startedAt ? formatElapsed(now - startedAt) : null;
  const text = isFinished ? finished : activity;
  // The slot's height carries the dock (and so the transcript's bottom edge) smoothly; with reduced motion it snaps.
  const slotTransition = reduceMotion ? { duration: 0 } : ROW_SPRING;

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <m.div
          key="run-status"
          className="wbc-run-slot"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0, transition: reduceMotion ? { duration: 0 } : { ...ROW_SPRING, opacity: { duration: 0.16 } } }}
          transition={slotTransition}
        >
          <m.div
            layout
            role="group"
            aria-label="本轮运行状态"
            className={`wbc-run is-${isFinished ? 'finished' : phase}${expanded ? ' is-expanded' : ''}`}
            initial={{ y: 10, scale: 0.94 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 6, scale: 0.96 }}
            transition={ROW_SPRING}
            style={{ borderRadius: 20, transformOrigin: 'left bottom' }}
          >
            {/* The steps unfold above the row, growing away from the composer. */}
            <AnimatePresence initial={false}>
              {expanded && todos && (
                <m.div
                  key="todos"
                  className="wbc-run-todos"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={slotTransition}
                >
                  <WorkbenchTodoList todos={todos} />
                </m.div>
              )}
            </AnimatePresence>
            <m.div layout="position" className="wbc-run-bar">
              <button
                type="button"
                className="wbc-run-main"
                aria-expanded={total ? expanded : undefined}
                aria-label={total ? `${text}，步骤 ${done}/${total}，${expanded ? '收起' : '展开'}步骤` : text}
                disabled={!total}
                onClick={() => setExpanded((value) => !value)}
              >
                <span className="wbc-run-glyph" aria-hidden="true">
                  {isFinished ? <Check size={16} strokeWidth={2.8} />
                    : phase === 'waiting' ? <Hand size={16} strokeWidth={2.2} />
                      : phase === 'working' ? <WorkbenchSpinner size={16} />
                        : <span className="wbc-run-dots"><i /><i /><i /></span>}
                </span>
                <span className="wbc-run-text" aria-live="polite">{text}</span>
                {total > 0 && <span className="wbc-run-count">{done}/{total}</span>}
                {elapsed && <span className="wbc-run-time">{elapsed}</span>}
                {total > 0 && <ChevronDown className="wbc-run-chevron" size={15} strokeWidth={2.4} aria-hidden="true" />}
              </button>
              {active && canStop && (
                <button
                  type="button"
                  className="wbc-run-stop"
                  aria-label="停止这一轮"
                  title="停止（Esc）"
                  onClick={() => {
                    setStopped(true);
                    onStop();
                  }}
                >
                  <Square size={11} fill="currentColor" strokeWidth={0} />
                </button>
              )}
            </m.div>
            {total > 0 && (
              <div className="wbc-run-progress" aria-hidden="true">
                <m.span initial={false} animate={{ scaleX: ratio }} transition={{ type: 'spring', stiffness: 120, damping: 20 }} />
              </div>
            )}
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
