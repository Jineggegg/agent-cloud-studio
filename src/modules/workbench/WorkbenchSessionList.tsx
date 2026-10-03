import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, m } from 'motion/react';
import { Archive, MessageSquareDashed, MoreHorizontal, Pencil, SearchX, Trash2 } from 'lucide-react';

import type { WorkbenchSessionItem } from '@/shared/types';
import { StudioSpinner } from '@/modules/studio';
import { WorkbenchPopover } from '@/modules/workbench/WorkbenchPopover';
import { WorkbenchProviderMark } from '@/modules/workbench/WorkbenchProviderMark';
import { WorkbenchSwipeRow } from '@/modules/workbench/WorkbenchSwipeRow';
import { filterSessions, formatSessionTime, groupSessionsByDay } from '@/modules/workbench/utils/workbenchSessionGroups';
import { providerMeta, workbenchPath } from '@/modules/workbench/utils/workbenchRoutes';

// Rows rise in one after another when a project's history first appears; later rows (and long lists) do not wait.
const rowVariants = {
  hidden: { opacity: 0, y: 8 },
  show: (index: number) => ({ opacity: 1, y: 0, transition: { delay: Math.min(index, 12) * 0.022, type: 'spring' as const, stiffness: 380, damping: 32 } }),
};
// The active-row highlight glides between rows like an iPadOS sidebar selection.
const HIGHLIGHT_SPRING = { type: 'spring', stiffness: 520, damping: 42 } as const;

// A conversation handed between providers is archived only when every one of its sessions is an agent's (DeepSeek
// conversations cannot be archived).
function canArchive(item: WorkbenchSessionItem) {
  return item.thread ? item.thread.segments.every(segment => segment.kind === 'agent') : item.kind === 'agent';
}

type WorkbenchSessionListProps = {
  projectId: string;
  // Rows with their running and attention flags; null while the project's history loads.
  items: WorkbenchSessionItem[] | null;
  activeId: string | null;
  query: string;
  error: string;
  hasMore: boolean;
  loadingMore: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
  onClearQuery: () => void;
  // Called after a row is opened (the phone sheet closes).
  onNavigate: () => void;
  // Resolves false when the rename failed, keeping the field open.
  onRename: (item: WorkbenchSessionItem, title: string) => Promise<boolean>;
  onArchive: (item: WorkbenchSessionItem) => void;
  onDelete: (item: WorkbenchSessionItem) => void;
};

function RenameField({ item, onDone, onRename }: {
  item: WorkbenchSessionItem; onDone: () => void; onRename: (item: WorkbenchSessionItem, title: string) => Promise<boolean>;
}) {
  // The title being typed; saved on Enter or when the field loses focus.
  const [draft, setDraft] = useState(item.title);
  // A save is in flight, so blur and Enter do not send it twice.
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.select(); }, []);

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (saving) return;
    const title = draft.trim();
    if (!title || title === item.title) { onDone(); return; }
    setSaving(true);
    const saved = await onRename(item, title);
    setSaving(false);
    if (saved) onDone(); else input.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); onDone(); }
  };

  return <form className="wb-row-rename" onSubmit={save}>
    <WorkbenchProviderMark provider={item.provider} />
    <input ref={input} value={draft} onChange={event => setDraft(event.target.value)} onBlur={() => void save()} onKeyDown={onKeyDown}
      aria-label="会话名称" maxLength={200} disabled={saving} autoComplete="off" spellCheck={false} />
    {saving && <StudioSpinner size={14} label="正在保存" />}
  </form>;
}

/**
 * Used by the workbench sidebar for the project's history: rows grouped 今天 / 昨天 / 本周 / 更早, filtered by the
 * search field, with a breathing badge on running sessions, a red dot on sessions that need the owner, a gliding
 * highlight on the open one, a menu per row (rename, archive, delete) and the same archive / delete on a swipe to
 * the left. Honest loading, empty, no-match and error states.
 */
export function WorkbenchSessionList({
  projectId, items, activeId, query, error, hasMore, loadingMore,
  onRetry, onLoadMore, onClearQuery, onNavigate, onRename, onArchive, onDelete,
}: WorkbenchSessionListProps) {
  // The row the menu belongs to, with the button that anchors it; kept after closing so the menu fades out intact.
  const [menu, setMenu] = useState<{ item: WorkbenchSessionItem; anchor: HTMLElement } | null>(null);
  // Whether that row menu is showing.
  const [menuOpen, setMenuOpen] = useState(false);
  // The row whose title is being edited in place.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // The row whose swipe actions are showing (kind:id); one at a time, like iOS Mail.
  const [swipedKey, setSwipedKey] = useState<string | null>(null);
  // Whether the rows rise in one after another when the list mounts: on when a project's rows first replace the
  // skeleton, off once the list has given way to a no-match or empty state, so clearing a search does not replay it.
  // Adjusted during render, so the very render that mounts the list (and its AnimatePresence) already sees it.
  const [entrance, setEntrance] = useState<{ projectId: string; play: boolean } | null>(null);
  const filtered = useMemo(() => (items ? filterSessions(items, query) : null), [items, query]);
  const groups = useMemo(() => (filtered ? groupSessionsByDay(filtered) : []), [filtered]);
  const listShown = Boolean(filtered?.length);
  if (listShown && entrance?.projectId !== projectId) setEntrance({ projectId, play: true });
  else if (!listShown && items !== null && entrance?.projectId === projectId && entrance.play) setEntrance({ projectId, play: false });
  const playEntrance = entrance?.projectId !== projectId || entrance.play;
  const now = new Date();

  if (items === null) {
    return <div className="wb-list-skeleton" role="status" aria-label="正在加载会话">
      {[72, 58, 84, 64, 76].map((width, index) => <span key={index} className="skeleton-block" style={{ width: `${width}%` }} />)}
    </div>;
  }
  if (error && !items.length) {
    return <div className="wb-list-empty" role="alert">
      <p>{error}</p>
      <button type="button" className="ios-button tinted" onClick={onRetry}>重试</button>
    </div>;
  }
  if (!items.length) {
    return <div className="wb-list-empty">
      <MessageSquareDashed size={28} strokeWidth={1.5} aria-hidden="true" />
      <strong>这个项目还没有会话</strong>
      <p>用「新会话」开始，Claude Code 和 Codex 会在项目目录里工作。</p>
    </div>;
  }
  if (!filtered?.length) {
    return <div className="wb-list-empty">
      <SearchX size={26} strokeWidth={1.5} aria-hidden="true" />
      <p>没有标题包含「{query.trim()}」的会话{hasMore ? '（更早的会话还没有载入）' : ''}</p>
      <div className="wb-list-empty-actions">
        <button type="button" className="ios-button tinted" onClick={onClearQuery}>清除搜索</button>
        {hasMore && <button type="button" className="ios-button" disabled={loadingMore} onClick={onLoadMore}>载入更早的会话</button>}
      </div>
    </div>;
  }

  let rowIndex = 0;
  return <div className="wb-list" key={projectId}>
    {groups.map(group => <section key={group.id} className="wb-group" aria-labelledby={`wb-group-${group.id}`}>
      <h3 id={`wb-group-${group.id}`} className="wb-group-title">{group.label}</h3>
      <ul role="list">
        <AnimatePresence initial={playEntrance}>
          {group.items.map(item => {
            const active = item.id === activeId;
            const index = rowIndex++;
            const meta = providerMeta(item.provider);
            const rowKey = `${item.kind}:${item.id}`;
            const renaming = renamingId === item.id;
            return <m.li key={rowKey} className="wb-row" data-active={active || undefined} data-running={item.running || undefined}
              data-attention={item.attention || undefined}
              custom={index} variants={rowVariants} initial="hidden" animate="show" layout="position"
              exit={{ opacity: 0, height: 0, transition: { duration: 0.2 } }}>
              <WorkbenchSwipeRow open={swipedKey === rowKey} disabled={renaming}
                onOpenChange={next => setSwipedKey(previous => (next ? rowKey : previous === rowKey ? null : previous))}
                actions={[
                  ...(canArchive(item) ? [{ label: '归档', icon: Archive, onSelect: () => onArchive(item) }] : []),
                  { label: '删除', icon: Trash2, destructive: true, onSelect: () => onDelete(item) },
                ]}>
                {active && <m.span layoutId="wb-active-row" className="wb-row-highlight" transition={HIGHLIGHT_SPRING} aria-hidden="true" />}
                {renaming
                  ? <RenameField item={item} onRename={onRename} onDone={() => setRenamingId(null)} />
                  : <Link to={workbenchPath(projectId, item)} className="wb-row-link" aria-current={active ? 'page' : undefined} onClick={onNavigate}
                    aria-label={`${item.title}，${meta.name}${item.thread ? `，交接过 ${item.thread.segments.length - 1} 次` : ''}${item.running ? '，运行中' : ''}${item.attention ? '，需要查看' : ''}`}>
                    <span className="wb-row-mark">
                      <WorkbenchProviderMark provider={item.provider} running={item.running} />
                      {item.attention && <span className="wb-attention-dot" aria-hidden="true" />}
                    </span>
                    <span className="wb-row-title">{item.title}</span>
                    {item.running
                      ? <span className="wb-row-live">运行中</span>
                      : <time className="wb-row-time" dateTime={item.updatedAt ?? undefined}>{formatSessionTime(item.updatedAt, now)}</time>}
                  </Link>}
                {!renaming && <button type="button" className="wb-row-more" aria-label={`「${item.title}」的更多操作`} aria-haspopup="menu"
                  aria-expanded={menuOpen && menu?.item.id === item.id} onClick={event => { setMenu({ item, anchor: event.currentTarget }); setMenuOpen(true); }}>
                  <MoreHorizontal size={17} aria-hidden="true" />
                </button>}
              </WorkbenchSwipeRow>
            </m.li>;
          })}
        </AnimatePresence>
      </ul>
    </section>)}
    {hasMore && <button type="button" className="wb-load-more" disabled={loadingMore} onClick={onLoadMore}>
      {loadingMore ? <StudioSpinner size={14} /> : null}{loadingMore ? '正在载入' : '显示更早的会话'}
    </button>}

    <WorkbenchPopover open={menuOpen && menu !== null} anchor={menu?.anchor ?? null} onClose={() => setMenuOpen(false)} label="会话操作" align="end" width={200}>
      {/* A conversation handed between providers is renamed as a whole (DeepSeek conversations alone cannot be). */}
      {menu && (menu.item.thread || menu.item.kind === 'agent') && <button type="button" role="menuitem" className="wb-popover-item is-compact"
        onClick={() => { const target = menu.item; setMenuOpen(false); setRenamingId(target.id); }}>
        <Pencil size={16} aria-hidden="true" />重命名
      </button>}
      {menu && canArchive(menu.item)
        && <button type="button" role="menuitem" className="wb-popover-item is-compact" onClick={() => { const target = menu.item; setMenuOpen(false); onArchive(target); }}>
          <Archive size={16} aria-hidden="true" />归档
        </button>}
      {menu && <button type="button" role="menuitem" className="wb-popover-item is-compact is-destructive" onClick={() => { const target = menu.item; setMenuOpen(false); onDelete(target); }}>
        <Trash2 size={16} aria-hidden="true" />删除
      </button>}
    </WorkbenchPopover>
  </div>;
}
