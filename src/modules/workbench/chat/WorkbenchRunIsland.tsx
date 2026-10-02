import { useEffect, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { Check, ChevronDown, Hand, Square } from 'lucide-react';

import type { WorkbenchTodoItem } from '@/shared/types';
import { WorkbenchSpinner } from '@/modules/workbench/chat/WorkbenchSpinner';
import { WorkbenchTodoList } from '@/modules/workbench/chat/WorkbenchTodoList';

const ISLAND_SPRING = { type: 'spring', stiffness: 380, damping: 32, mass: 0.8 } as const;
// How long the finished state lingers before the island tucks away.
const FINISHED_LINGER_MS = 2600;

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
}

type WorkbenchRunIslandProps = {
  active: boolean;
  // What the agent is doing now: `正在运行 npm test`, the provider's status line, or 正在思考.
  activity: string;
  // The run is paused on the owner (a permission, question or plan sheet is open), so the glyph stops spinning.
  waiting?: boolean;
  startedAt: number | null;
  // The run's newest checklist, when the agent keeps one.
  todos: WorkbenchTodoItem[] | null;
  canStop: boolean;
  onStop: () => void;
};

/**
 * Used by WorkbenchAgentChat as the column's signature: a glass capsule pinned under the header for as long as a
 * run lasts — what the agent is doing, for how long, how far through its checklist (a bar that fills with a spring)
 * and a stop button. Tapping it unfolds the checklist. When the run ends it says so briefly, then tucks away.
 */
export function WorkbenchRunIsland({ active, activity, waiting = false, startedAt, todos, canStop, onStop }: WorkbenchRunIslandProps) {
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
  const total = todos?.length ?? 0;
  const done = todos?.filter((todo) => todo.status === 'completed').length ?? 0;
  const ratio = total ? done / total : 0;
  const elapsed = active && startedAt ? formatElapsed(now - startedAt) : null;
  const text = finished && !active ? finished : activity;

  return (
    <AnimatePresence>
      {visible && (
        <m.div
          key="island"
          layout
          className={`wbc-island${finished && !active ? ' is-finished' : ''}${active && waiting ? ' is-waiting' : ''}${expanded ? ' is-expanded' : ''}`}
          initial={{ opacity: 0, y: -14, scale: 0.88 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.92, transition: { duration: 0.22 } }}
          transition={ISLAND_SPRING}
          style={{ borderRadius: 22 }}
        >
          <m.div layout="position" className="wbc-island-bar">
            <button
              type="button"
              className="wbc-island-main"
              aria-expanded={total ? expanded : undefined}
              aria-label={total ? `${text}，清单 ${done}/${total}，${expanded ? '收起' : '展开'}清单` : text}
              disabled={!total}
              onClick={() => setExpanded((value) => !value)}
            >
              <span className="wbc-island-glyph" aria-hidden="true">
                {!active ? <Check size={16} strokeWidth={2.8} />
                  : waiting ? <Hand size={16} strokeWidth={2.2} />
                    : <WorkbenchSpinner size={16} />}
              </span>
              <span className="wbc-island-text" aria-live="polite">{text}</span>
              {total > 0 && <span className="wbc-island-count">{done}/{total}</span>}
              {elapsed && <span className="wbc-island-time">{elapsed}</span>}
              {total > 0 && <ChevronDown className="wbc-island-chevron" size={15} strokeWidth={2.4} aria-hidden="true" />}
            </button>
            {active && canStop && (
              <button
                type="button"
                className="wbc-island-stop"
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
            <div className="wbc-island-progress" aria-hidden="true">
              <m.span initial={false} animate={{ scaleX: ratio }} transition={{ type: 'spring', stiffness: 120, damping: 20 }} />
            </div>
          )}
          <AnimatePresence initial={false}>
            {expanded && todos && (
              <m.div
                key="todos"
                className="wbc-island-todos"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={ISLAND_SPRING}
              >
                <WorkbenchTodoList todos={todos} />
              </m.div>
            )}
          </AnimatePresence>
        </m.div>
      )}
    </AnimatePresence>
  );
}
