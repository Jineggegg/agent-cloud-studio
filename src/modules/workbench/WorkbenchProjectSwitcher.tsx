import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, m } from 'motion/react';
import { Archive, Check, ChevronsUpDown, Folder, LayoutGrid, Search, Trash2 } from 'lucide-react';

import type { WorkbenchProjectEntry } from '@/shared/types';
import { StudioTileIcon } from '@/modules/studio';
import { WorkbenchPopover } from '@/modules/workbench/WorkbenchPopover';
import { WorkbenchSwipeRow } from '@/modules/workbench/WorkbenchSwipeRow';

// The search field appears once the list is long enough to scan slowly.
const SEARCH_THRESHOLD = 7;
// A row archived or deleted folds away; one the search hides goes at once (AnimatePresence passes `searching`).
const ROW_VARIANTS = {
  gone: (searching: boolean) => ({ opacity: 0, height: 0, transition: { duration: searching ? 0 : 0.2 } }),
};

function ProjectIcon({ entry }: { entry: WorkbenchProjectEntry }) {
  if (entry.hub) return <StudioTileIcon tone={entry.hub.tone} glyph={entry.hub.glyph} size={17} variant="small" />;
  return <span className="home-icon small tone-stone" aria-hidden="true"><Folder size={16} strokeWidth={1.7} /></span>;
}

// The hub project's name when the directory belongs to one, otherwise the IDE project's own name.
function nameOf(entry: WorkbenchProjectEntry) {
  return entry.hub?.name ?? entry.project.displayName;
}

/**
 * Used by the workbench sidebar to show the current project (with its Studio icon and name when the directory
 * belongs to a hub project) and to switch to another IDE project. Directory paths are never shown. A row swipes
 * left (or opens with its "…" button) to archive or delete its project; the shell does the work and asks first.
 */
export function WorkbenchProjectSwitcher({ entries, current, onSelect, onArchive, onDelete }: {
  entries: WorkbenchProjectEntry[] | null; current: WorkbenchProjectEntry | null; onSelect: (projectId: string) => void;
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

  const visible = useMemo(() => {
    const words = query.trim().toLocaleLowerCase();
    if (!entries || !words) return entries ?? [];
    // Names only (the hub name and the folder's): paths are not shown, so a match on one would look like noise.
    return entries.filter(entry => `${nameOf(entry)} ${entry.project.displayName}`.toLocaleLowerCase().includes(words));
  }, [entries, query]);

  if (!entries) {
    return <div className="wb-switcher is-loading" role="status" aria-label="正在加载项目"><span className="skeleton-block" /><span className="skeleton-block" /></div>;
  }

  const close = () => { setOpen(false); setQuery(''); setSwipedId(null); };

  return <>
    <button ref={setTrigger} type="button" className="wb-switcher ios-press" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}
      aria-label={current ? `当前项目：${nameOf(current)}，切换项目` : '选择项目'}>
      {current ? <ProjectIcon entry={current} /> : <span className="home-icon small tone-ghost" aria-hidden="true"><Folder size={16} /></span>}
      <strong className="wb-switcher-name">{current ? nameOf(current) : '选择项目'}</strong>
      <ChevronsUpDown size={16} className="wb-switcher-chevron" aria-hidden="true" />
    </button>

    <WorkbenchPopover open={open} anchor={trigger} onClose={close} label="切换项目" role="dialog" width={320}>
      {entries.length >= SEARCH_THRESHOLD && <label className="wb-popover-search">
        <Search size={15} aria-hidden="true" />
        <input type="search" data-autofocus value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索项目" aria-label="搜索项目"
          autoComplete="off" autoCorrect="off" spellCheck={false} />
      </label>}
      <ul className="wb-popover-list" role="list" aria-label="项目">
        <AnimatePresence initial={false} custom={Boolean(query.trim())}>
          {visible.map(entry => {
            const projectId = entry.project.projectId;
            const selected = projectId === current?.project.projectId;
            const name = nameOf(entry);
            return <m.li key={projectId} className="wb-project-row" variants={ROW_VARIANTS} exit="gone">
              <WorkbenchSwipeRow open={swipedId === projectId} revealLabel={`「${name}」的更多操作`}
                onOpenChange={next => setSwipedId(previous => (next ? projectId : previous === projectId ? null : previous))}
                actions={[
                  { label: '归档', icon: Archive, onSelect: () => onArchive(entry) },
                  { label: '删除', icon: Trash2, destructive: true, onSelect: () => onDelete(entry) },
                ]}>
                <button type="button" className="wb-popover-item" data-popover-item aria-current={selected || undefined}
                  onClick={() => { close(); if (!selected) onSelect(projectId); }}>
                  <ProjectIcon entry={entry} />
                  <strong className="wb-project-name">{name}</strong>
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
