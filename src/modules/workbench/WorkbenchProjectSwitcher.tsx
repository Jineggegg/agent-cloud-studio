import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronsUpDown, Folder, LayoutGrid, Search } from 'lucide-react';

import type { WorkbenchProjectEntry } from '@/shared/types';
import { StudioTileIcon } from '@/modules/studio';
import { WorkbenchPopover } from '@/modules/workbench/WorkbenchPopover';

// The search field appears once the list is long enough to scan slowly.
const SEARCH_THRESHOLD = 7;

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
 * belongs to a hub project) and to switch to another IDE project.
 */
export function WorkbenchProjectSwitcher({ entries, current, onSelect }: {
  entries: WorkbenchProjectEntry[] | null; current: WorkbenchProjectEntry | null; onSelect: (projectId: string) => void;
}) {
  // The trigger button, which anchors the popover (a callback ref, so the popover re-measures once it exists).
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  // The project list popover.
  const [open, setOpen] = useState(false);
  // Filters the list by name or directory while it is open.
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const words = query.trim().toLocaleLowerCase();
    if (!entries || !words) return entries ?? [];
    return entries.filter(entry => `${nameOf(entry)} ${entry.project.displayName} ${entry.project.fullPath}`.toLocaleLowerCase().includes(words));
  }, [entries, query]);

  if (!entries) {
    return <div className="wb-switcher is-loading" role="status" aria-label="正在加载项目"><span className="skeleton-block" /><span className="skeleton-block" /></div>;
  }

  const close = () => { setOpen(false); setQuery(''); };

  return <>
    <button ref={setTrigger} type="button" className="wb-switcher ios-press" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}
      aria-label={current ? `当前项目：${nameOf(current)}，切换项目` : '选择项目'}>
      {current ? <ProjectIcon entry={current} /> : <span className="home-icon small tone-ghost" aria-hidden="true"><Folder size={16} /></span>}
      <span className="wb-switcher-text">
        <strong>{current ? nameOf(current) : '选择项目'}</strong>
        <small className="mono">{current?.project.fullPath ?? `${entries.length} 个项目`}</small>
      </span>
      <ChevronsUpDown size={16} className="wb-switcher-chevron" aria-hidden="true" />
    </button>

    <WorkbenchPopover open={open} anchor={trigger} onClose={close} label="切换项目" role="dialog" width={320}>
      {entries.length >= SEARCH_THRESHOLD && <label className="wb-popover-search">
        <Search size={15} aria-hidden="true" />
        <input type="search" data-autofocus value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索项目" aria-label="搜索项目"
          autoComplete="off" autoCorrect="off" spellCheck={false} />
      </label>}
      <div className="wb-popover-list" role="listbox" aria-label="项目">
        {visible.map(entry => {
          const selected = entry.project.projectId === current?.project.projectId;
          return <button type="button" role="option" aria-selected={selected} key={entry.project.projectId} className="wb-popover-item"
            onClick={() => { close(); if (!selected) onSelect(entry.project.projectId); }}>
            <ProjectIcon entry={entry} />
            <span className="wb-popover-item-text"><strong>{nameOf(entry)}</strong><small className="mono">{entry.project.fullPath}</small></span>
            {selected && <Check size={16} className="wb-popover-check" aria-hidden="true" />}
          </button>;
        })}
        {!visible.length && <p className="wb-popover-empty">{entries.length ? `没有名称或路径包含「${query.trim()}」的项目` : '还没有项目'}</p>}
      </div>
      <Link to="/" className="wb-popover-footer" onClick={close}><LayoutGrid size={15} aria-hidden="true" />在 Studio 中管理项目</Link>
    </WorkbenchPopover>
  </>;
}
