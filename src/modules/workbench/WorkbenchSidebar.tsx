import type { ComponentProps, RefObject } from 'react';
import { ChevronLeft, LayoutGrid, PanelLeftClose, Search, X } from 'lucide-react';

import type { StudioQuotaSnapshot, WorkbenchNewChatChoice, WorkbenchNewProvider, WorkbenchProjectEntry, WorkbenchViewport } from '@/shared/types';
import { WorkbenchNewSession } from '@/modules/workbench/WorkbenchNewSession';
import { WorkbenchProjectSwitcher } from '@/modules/workbench/WorkbenchProjectSwitcher';
import { WorkbenchQuotaBars } from '@/modules/workbench/WorkbenchQuotaBars';
import { WorkbenchSessionList } from '@/modules/workbench/WorkbenchSessionList';

type WorkbenchSidebarProps = {
  viewport: WorkbenchViewport;
  // ⌘ on Apple keyboards, Ctrl elsewhere; null on touch-only devices, which show no shortcut hints.
  modifier: string | null;
  entries: WorkbenchProjectEntry[] | null;
  current: WorkbenchProjectEntry | null;
  // The agents "+ 新会话" offers in this project (the shared new-chat rule).
  newChatChoices: WorkbenchNewChatChoice[];
  lastProvider: WorkbenchNewProvider;
  query: string;
  searchRef: RefObject<HTMLInputElement>;
  quota: StudioQuotaSnapshot[] | null;
  // The history column; absent while no project is open.
  list: Omit<ComponentProps<typeof WorkbenchSessionList>, 'query' | 'onClearQuery'> | null;
  onQueryChange: (query: string) => void;
  onSelectProject: (projectId: string) => void;
  // A switcher row's swipe actions: archive at once (undoable), delete after the shell's confirmation.
  onArchiveProject: (entry: WorkbenchProjectEntry) => void;
  onDeleteProject: (entry: WorkbenchProjectEntry) => void;
  onNewChat: (provider: WorkbenchNewProvider) => void;
  // The Studio app the back control returns to (the workbench was opened from inside it), or null for home.
  backTitle: string | null;
  onBack: () => void;
  onHide: () => void;
  onOpenSettings: () => void;
};

/**
 * Used by the workbench shell as its left column (a sheet on phones): back to the Studio, the project switcher,
 * "+ 新会话", the searchable history and the model quota bars.
 */
export function WorkbenchSidebar({
  viewport, modifier, entries, current, newChatChoices, lastProvider, query, searchRef, quota, list,
  onQueryChange, onSelectProject, onArchiveProject, onDeleteProject, onNewChat, backTitle, onBack, onHide, onOpenSettings,
}: WorkbenchSidebarProps) {
  return <div className="wb-sidebar">
    <header className="wb-sidebar-head">
      <button type="button" className="navbar-back ios-press" onClick={onBack} aria-label={backTitle ? `返回 ${backTitle}` : '返回 Studio 主屏幕'}>
        <ChevronLeft size={24} aria-hidden="true" />
        {backTitle ? <span className="wb-back-title">{backTitle}</span> : <LayoutGrid size={17} aria-hidden="true" />}
      </button>
      <span className="wb-sidebar-title">工作台</span>
      <button type="button" className="icon-button plain" onClick={onHide}
        aria-label={viewport === 'phone' ? '关闭会话列表' : '隐藏侧栏'} title={viewport === 'phone' ? '关闭' : `隐藏侧栏${modifier ? `（${modifier}\\）` : ''}`}>
        {viewport === 'phone' ? <X size={20} aria-hidden="true" /> : <PanelLeftClose size={19} aria-hidden="true" />}
      </button>
    </header>

    <div className="wb-sidebar-top">
      <WorkbenchProjectSwitcher entries={entries} current={current} onSelect={onSelectProject} onArchive={onArchiveProject} onDelete={onDeleteProject} />
      {current && <WorkbenchNewSession choices={newChatChoices} lastProvider={lastProvider} onStart={onNewChat}
        shortcut={modifier ? `${modifier}N` : null} />}
      {current && <label className="ios-search wb-search">
        <Search size={15} aria-hidden="true" />
        <input ref={searchRef} type="search" value={query} onChange={event => onQueryChange(event.target.value)} placeholder="搜索会话" aria-label="搜索会话"
          autoComplete="off" autoCorrect="off" spellCheck={false}
          onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); onQueryChange(''); } }} />
        {modifier && !query && <kbd aria-hidden="true">{modifier}K</kbd>}
      </label>}
    </div>

    <nav className="wb-history" aria-label="会话历史">
      {list && <WorkbenchSessionList {...list} query={query} onClearQuery={() => onQueryChange('')} />}
    </nav>

    <WorkbenchQuotaBars snapshots={quota} onOpenSettings={onOpenSettings} />
  </div>;
}
