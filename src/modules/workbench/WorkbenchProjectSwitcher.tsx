import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, m } from 'motion/react';
import { Archive, Check, ChevronsUpDown, Folder, LayoutGrid, Search, Trash2 } from 'lucide-react';

import type { WorkbenchProjectActivity, WorkbenchProjectEntry } from '@/shared/types';
import { StudioTileIcon } from '@/modules/studio';
import { WorkbenchPopover } from '@/modules/workbench/WorkbenchPopover';
import { WorkbenchSwipeRow } from '@/modules/workbench/WorkbenchSwipeRow';

// The search field appears once the list is long enough to scan slowly.
const SEARCH_THRESHOLD = 7;
// A row archived or deleted folds away; one the search hides goes at once (AnimatePresence passes `searching`).
const ROW_VARIANTS = {
  gone: (searching: boolean) => ({ opacity: 0, height: 0, transition: { duration: searching ? 0 : 0.2 } }),
};
// A running spinner or a red dot pops in and fades out; MotionConfig drops the scale for reduced motion.
const MARK_MOTION = {
  initial: { opacity: 0, scale: 0.4 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.4, transition: { duration: 0.14 } },
  transition: { type: 'spring', stiffness: 520, damping: 30 },
} as const;
// Press-and-slide: movement before a press counts as a slide onto the list (less is a tap).
const SLIDE_SLOP_PX = 6;
// Within this distance of the list's top or bottom edge a sliding finger scrolls it, faster the closer it gets.
const AUTO_SCROLL_ZONE_PX = 44;
const AUTO_SCROLL_MAX_PX_PER_FRAME = 14;

// The finger (or mouse button) that pressed the trigger and may slide onto a row.
type Press = { pointerId: number; startX: number; startY: number; x: number; y: number; sliding: boolean };

function ProjectIcon({ entry }: { entry: WorkbenchProjectEntry }) {
  if (entry.hub) return <StudioTileIcon tone={entry.hub.tone} glyph={entry.hub.glyph} size={17} variant="small" />;
  return <span className="home-icon small tone-stone" aria-hidden="true"><Folder size={16} strokeWidth={1.7} /></span>;
}

// The hub project's name when the directory belongs to one, otherwise the IDE project's own name.
function nameOf(entry: WorkbenchProjectEntry) {
  return entry.hub?.name ?? entry.project.displayName;
}

// The spoken state of a project's marks, appended to its name ("正在运行", "需要你处理").
function marksLabel(activity: WorkbenchProjectActivity | undefined) {
  const parts = [activity?.running ? '正在运行' : '', activity?.attention ? '需要你处理' : ''].filter(Boolean);
  return parts.length ? `，${parts.join('，')}` : '';
}

/** A project's live marks, left of the ✓: a spinner while something runs, a red dot while it needs the owner. */
function ProjectMarks({ activity }: { activity: WorkbenchProjectActivity | undefined }) {
  return <span className="wb-project-marks" aria-hidden="true">
    <AnimatePresence initial={false}>
      {Boolean(activity?.running) && <m.span key="running" className="wb-activity-spinner" data-testid="project-running" title="正在运行" {...MARK_MOTION} />}
      {Boolean(activity?.attention) && <m.span key="attention" className="wb-activity-dot" data-testid="project-attention" title="需要你处理" {...MARK_MOTION} />}
    </AnimatePresence>
  </span>;
}

/**
 * Used by the workbench sidebar to show the current project (with its Studio icon and name when the directory
 * belongs to a hub project) and to switch to another IDE project. Directory paths are never shown. A row swipes
 * left (or opens with its "…" button) to archive or delete its project; the shell does the work and asks first.
 * Rows carry live marks (`activity`): a spinner while an agent runs there, a red dot when it needs the owner; the
 * closed switcher's ⌃⌄ carries one combined mark for the other projects. Like an iOS menu, pressing the trigger
 * opens the list at once and the finger can slide onto a row and lift to switch; a tap opens it as before.
 */
export function WorkbenchProjectSwitcher({ entries, current, activity = null, onSelect, onArchive, onDelete }: {
  entries: WorkbenchProjectEntry[] | null; current: WorkbenchProjectEntry | null;
  // Running / needs-you marks per IDE project id; null until the first read.
  activity?: Record<string, WorkbenchProjectActivity> | null;
  onSelect: (projectId: string) => void;
  onArchive: (entry: WorkbenchProjectEntry) => void; onDelete: (entry: WorkbenchProjectEntry) => void;
}) {
  // The trigger button, which anchors the popover (a callback ref, so the popover re-measures once it exists).
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  // The project list popover.
  const [open, setOpen] = useState(false);
  // Filters the list by project name while it is open.
  const [query, setQuery] = useState('');
  // The row whose swipe actions are showing; one at a time, like iOS Mail.
  const [swipedId, setSwipedId] = useState<string | null>(null);
  // The row under a sliding finger, highlighted until the finger lifts (a project id).
  const [slideTarget, setSlideTarget] = useState<string | null>(null);
  // The list was opened by a finger (or pen) press: focus stays on the panel, so sliding never raises the keyboard.
  const [openedByTouch, setOpenedByTouch] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const press = useRef<Press | null>(null);
  // Set as a press ends, so the click the browser sends after it does not toggle the list a second time.
  const swallowClick = useRef(false);
  const scrollFrame = useRef<number | null>(null);

  const visible = useMemo(() => {
    const words = query.trim().toLocaleLowerCase();
    if (!entries || !words) return entries ?? [];
    // Names only (the hub name and the folder's): paths are not shown, so a match on one would look like noise.
    return entries.filter(entry => `${nameOf(entry)} ${entry.project.displayName}`.toLocaleLowerCase().includes(words));
  }, [entries, query]);

  // The other projects' marks, combined on the closed switcher so the owner knows to open it.
  const elsewhere = useMemo(() => {
    let running = 0;
    let attention = 0;
    for (const entry of entries ?? []) {
      if (entry.project.projectId === current?.project.projectId) continue;
      const marks = activity?.[entry.project.projectId];
      if (marks?.running) running += 1;
      if (marks?.attention) attention += 1;
    }
    return { running, attention };
  }, [entries, current, activity]);

  // The switcher row under a point, or null (outside the list, on the trigger, on the search field).
  const rowAt = useCallback((x: number, y: number): string | null => {
    const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
    const row = hit?.closest<HTMLElement>('[data-project-id]');
    return row && list.current?.contains(row) ? row.dataset.projectId ?? null : null;
  }, []);

  const stopAutoScroll = () => {
    if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
  };
  useEffect(() => stopAutoScroll, []);

  // While the finger rests near the list's top or bottom edge the list scrolls under it, and the row now under the
  // finger is highlighted.
  const autoScroll = useCallback(() => {
    const step = () => {
      scrollFrame.current = null;
      const current = press.current;
      const element = list.current;
      if (!current?.sliding || !element) return;
      const rect = element.getBoundingClientRect();
      if (current.x < rect.left || current.x > rect.right || current.y < rect.top || current.y > rect.bottom) return;
      const nearTop = current.y - rect.top;
      const nearBottom = rect.bottom - current.y;
      const depth = nearTop < AUTO_SCROLL_ZONE_PX ? -(1 - nearTop / AUTO_SCROLL_ZONE_PX)
        : nearBottom < AUTO_SCROLL_ZONE_PX ? 1 - nearBottom / AUTO_SCROLL_ZONE_PX : 0;
      if (!depth) return;
      const before = element.scrollTop;
      element.scrollTop = before + Math.sign(depth) * Math.max(1, Math.round(Math.abs(depth) * AUTO_SCROLL_MAX_PX_PER_FRAME));
      if (element.scrollTop === before) return;
      setSlideTarget(rowAt(current.x, current.y));
      scrollFrame.current = window.requestAnimationFrame(step);
    };
    step();
  }, [rowAt]);

  if (!entries) {
    return <div className="wb-switcher is-loading" role="status" aria-label="正在加载项目"><span className="skeleton-block" /><span className="skeleton-block" /></div>;
  }

  const close = () => { setOpen(false); setQuery(''); setSwipedId(null); setSlideTarget(null); };
  const choose = (projectId: string) => {
    close();
    if (projectId !== current?.project.projectId) onSelect(projectId);
  };
  const endPress = () => {
    press.current = null;
    stopAutoScroll();
    setSlideTarget(null);
    swallowClick.current = true;
    // The click (if any) follows in the same task; one that never comes must not swallow a later one.
    window.setTimeout(() => { swallowClick.current = false; }, 0);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || open || press.current) return;
    press.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, sliding: false };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* the pointer is already gone */ }
    setOpenedByTouch(event.pointerType !== 'mouse');
    setOpen(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = press.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.x = event.clientX;
    current.y = event.clientY;
    if (!current.sliding && Math.hypot(current.x - current.startX, current.y - current.startY) < SLIDE_SLOP_PX) return;
    current.sliding = true;
    setSlideTarget(rowAt(current.x, current.y));
    if (scrollFrame.current === null) scrollFrame.current = window.requestAnimationFrame(autoScroll);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = press.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const target = current.sliding ? rowAt(event.clientX, event.clientY) : null;
    endPress();
    // Lifted on a row: switch. Anywhere else (the trigger, outside the list): the list stays open, as after a tap.
    if (target) choose(target);
  };
  const onPointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (press.current?.pointerId === event.pointerId) endPress();
  };

  const othersLabel = [elsewhere.running ? `${elsewhere.running} 个正在运行` : '', elsewhere.attention ? `${elsewhere.attention} 个需要你处理` : '']
    .filter(Boolean).join('，');
  const triggerLabel = `${current ? `当前项目：${nameOf(current)}，切换项目` : '选择项目'}${othersLabel ? `（其他项目：${othersLabel}）` : ''}`;

  return <>
    <button ref={setTrigger} type="button" className="wb-switcher ios-press" aria-haspopup="dialog" aria-expanded={open} aria-label={triggerLabel}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
      onClick={() => {
        if (swallowClick.current) { swallowClick.current = false; return; }
        // Keyboard (Enter / Space) and assistive technology arrive here without a press.
        setOpenedByTouch(false);
        if (open) close(); else setOpen(true);
      }}>
      {current ? <ProjectIcon entry={current} /> : <span className="home-icon small tone-ghost" aria-hidden="true"><Folder size={16} /></span>}
      <strong className="wb-switcher-name">{current ? nameOf(current) : '选择项目'}</strong>
      <span className="wb-switcher-control">
        <ChevronsUpDown size={16} className="wb-switcher-chevron" aria-hidden="true" />
        <AnimatePresence initial={false}>
          {elsewhere.attention > 0 ? <m.span key="attention" className="wb-switcher-badge is-attention" data-testid="switcher-attention" aria-hidden="true" {...MARK_MOTION} />
            : elsewhere.running > 0 ? <m.span key="running" className="wb-switcher-badge is-running" data-testid="switcher-running" aria-hidden="true" {...MARK_MOTION} />
              : null}
        </AnimatePresence>
      </span>
    </button>

    <WorkbenchPopover open={open} anchor={trigger} onClose={close} label="切换项目" role="dialog" width={320} initialFocus={openedByTouch ? 'panel' : 'auto'}>
      {entries.length >= SEARCH_THRESHOLD && <label className="wb-popover-search">
        <Search size={15} aria-hidden="true" />
        <input type="search" data-autofocus value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索项目" aria-label="搜索项目"
          autoComplete="off" autoCorrect="off" spellCheck={false} />
      </label>}
      <ul ref={list} className="wb-popover-list" role="list" aria-label="项目" data-sliding={slideTarget !== null || undefined}>
        <AnimatePresence initial={false} custom={Boolean(query.trim())}>
          {visible.map(entry => {
            const projectId = entry.project.projectId;
            const selected = projectId === current?.project.projectId;
            const name = nameOf(entry);
            const marks = activity?.[projectId];
            const highlighted = slideTarget === projectId;
            return <m.li key={projectId} className="wb-project-row" variants={ROW_VARIANTS} exit="gone">
              <WorkbenchSwipeRow open={swipedId === projectId} revealLabel={`「${name}」的更多操作`}
                onOpenChange={next => setSwipedId(previous => (next ? projectId : previous === projectId ? null : previous))}
                actions={[
                  { label: '归档', icon: Archive, onSelect: () => onArchive(entry) },
                  { label: '删除', icon: Trash2, destructive: true, onSelect: () => onDelete(entry) },
                ]}>
                <button type="button" className="wb-popover-item" data-popover-item data-project-id={projectId} aria-current={selected || undefined}
                  data-slide-active={highlighted || undefined} aria-label={`${name}${marksLabel(marks)}`}
                  onClick={() => choose(projectId)}>
                  {highlighted && <m.span layoutId="wb-slide-highlight" className="wb-slide-highlight" aria-hidden="true"
                    transition={{ type: 'spring', stiffness: 640, damping: 42 }} />}
                  <ProjectIcon entry={entry} />
                  <strong className="wb-project-name">{name}</strong>
                  <ProjectMarks activity={marks} />
                  {selected && <Check size={16} className="wb-popover-check" aria-hidden="true" />}
                </button>
              </WorkbenchSwipeRow>
            </m.li>;
          })}
        </AnimatePresence>
      </ul>
      {!visible.length && <p className="wb-popover-empty">{entries.length ? `没有名称包含「${query.trim()}」的项目` : '还没有项目'}</p>}
      <Link to="/" className="wb-popover-footer" onClick={close}><LayoutGrid size={15} aria-hidden="true" />在 Studio 中管理项目</Link>
    </WorkbenchPopover>
  </>;
}
