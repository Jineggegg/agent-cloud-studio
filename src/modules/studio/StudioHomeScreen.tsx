import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft, ChevronRight, LayoutGrid, LogOut, Minus, Moon, Plus, RefreshCw, SlidersHorizontal, Sun } from 'lucide-react';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';

import { useTheme } from '@/shared/context/ThemeContext';
import type { StudioHomeTile, StudioSnr } from '@/shared/types';
import { StudioFluidBackground } from '@/modules/studio/StudioFluidBackground';
import { StudioTileIcon } from '@/modules/studio/StudioTileIcon';
import { StudioWidgets } from '@/modules/studio/StudioWidgets';
import { useHomeSortableItem, useHomeSortableList } from '@/modules/studio/hooks/useHomeSortable';
import '@/modules/studio/studio-home.css';

// Per-device layout preferences (hidden tiles, labels, icon size, icon order).
const LAYOUT_STORAGE_KEY = 'studio-home-layout-v1';
// Integrations that are planned but not built; listed honestly as not connected.
const PLANNED = [
  { name: 'Outlook 邮件', caption: '需要注册 Microsoft OAuth 应用', tone: 'rose', glyph: 'mail' },
];
// Taps on these keep edit mode; a tap anywhere else (the wallpaper, gaps between icons) ends it, as on iPadOS.
// `.studio-layer` covers the sheets, whose clicks bubble here through their React portals.
const KEEPS_EDITING = '.home-tile-slot, .widget-slot, button, a, input, label, .home-edit-bar, .studio-layer';

// `order` is absent until the icons are first rearranged on this device; layouts saved before it existed still load.
type Layout = { hidden: string[]; labels: boolean; large: boolean; order?: string[] };
const DEFAULT_LAYOUT: Layout = { hidden: [], labels: true, large: false };

// Switch theme with a circular reveal from the button, like Super Professor; instant where View Transitions are missing.
function revealTheme(apply: () => void, origin: HTMLElement) {
  const doc = document as Document & { startViewTransition?: (update: () => void) => { ready: Promise<void>; finished: Promise<void> } };
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!doc.startViewTransition || reduced) { apply(); return; }
  const box = origin.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const root = document.documentElement;
  root.classList.add('theme-revealing');
  const transition = doc.startViewTransition(apply);
  void transition.finished.finally(() => root.classList.remove('theme-revealing'));
  void transition.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 560, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' },
    );
  }).catch(() => {});
}

function readLayout(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? 'null') as Partial<Layout> | null;
    if (!saved) return DEFAULT_LAYOUT;
    return {
      hidden: Array.isArray(saved.hidden) ? saved.hidden.filter(id => typeof id === 'string') : [],
      labels: saved.labels !== false,
      large: saved.large === true,
      ...(Array.isArray(saved.order) ? { order: saved.order.filter(id => typeof id === 'string') } : {}),
    };
  } catch { return DEFAULT_LAYOUT; }
}

// Tiles this device has placed come first, in its order; new ones (a project created since) follow in their natural order.
function orderTiles(tiles: StudioHomeTile[], order: string[] | undefined) {
  if (!order?.length) return tiles;
  const rank = new Map(order.map((id, index) => [id, index]));
  return tiles.map((tile, index) => ({ tile, rank: rank.get(tile.id) ?? order.length + index }))
    .sort((a, b) => a.rank - b.rank)
    .map(entry => entry.tile);
}

const preventContextMenu = (event: MouseEvent) => event.preventDefault();

/** One sortable app icon; the slot moves (with its hide badge), the tile itself is what is pressed and dragged. */
function SortableTile({ tile, index, last, editing, labels, iconSize, onActivate, onHide, onMove }: {
  tile: StudioHomeTile; index: number; editing: boolean; labels: boolean; iconSize: number;
  // Whether the icon is the last visible one, where its 后移 button has nowhere to go.
  last: boolean;
  onActivate: (tile: StudioHomeTile, event: MouseEvent<HTMLElement>) => void;
  onHide: () => void;
  onMove: (step: -1 | 1) => void;
}) {
  const { attributes, isDragging, itemAttributes, listeners, setActivatorNodeRef, setNodeRef, style } = useHomeSortableItem(tile.id);
  const label = `${tile.name}${tile.status ? `，${tile.status}` : ''}`;
  const body = <>
    <StudioTileIcon tone={tile.tone} glyph={tile.glyph} size={iconSize} />
    <span className="home-label">{tile.name}</span>
    {tile.status && <span className="home-status">{tile.status}</span>}
  </>;
  // Links and buttons are focusable already; edit mode only adds the sortable description for screen readers.
  const shared = {
    ref: setActivatorNodeRef,
    className: 'home-tile', style: { animationDelay: `${index * 45}ms` }, title: labels ? undefined : tile.name, 'aria-label': label,
    ...(editing ? { 'aria-roledescription': attributes['aria-roledescription'], 'aria-describedby': attributes['aria-describedby'] } : {}),
    ...listeners,
    onContextMenu: preventContextMenu,
  };
  return <div ref={setNodeRef} {...itemAttributes} style={style} className={`home-tile-slot ${isDragging ? 'is-lifted' : ''}`}>
    {tile.href
      ? <Link to={tile.href} {...shared} onClick={event => onActivate(tile, event)}>{body}</Link>
      : <button type="button" {...shared} onClick={event => onActivate(tile, event)}>{body}</button>}
    {editing && <button type="button" className="home-remove" aria-label={`从主屏幕隐藏 ${tile.name}`} onClick={onHide}><Minus size={14} strokeWidth={3} aria-hidden="true" /></button>}
    {/* VoiceOver and Switch Control cannot drag, so edit mode also offers move buttons. They stay out of sight
        (the grid keeps its clean iPadOS look) until focused, when they appear under the icon. aria-disabled,
        not disabled, keeps a button focused when its icon reaches an end. */}
    {editing && <span className="home-move" role="group" aria-label={`调整 ${tile.name} 的位置`}>
      <button type="button" aria-label={`前移 ${tile.name}`} aria-disabled={index === 0} onClick={() => { if (index > 0) onMove(-1); }}>
        <ChevronLeft size={16} aria-hidden="true" /></button>
      <button type="button" aria-label={`后移 ${tile.name}`} aria-disabled={last} onClick={() => { if (!last) onMove(1); }}>
        <ChevronRight size={16} aria-hidden="true" /></button>
    </span>}
  </div>;
}

/**
 * Used by StudioPage as the launcher: one large icon per project or app, plus + to create a project. A long press
 * on any icon or widget enters edit mode (jiggling, drag to rearrange, hide), like the iPadOS home screen; move
 * buttons give VoiceOver and Switch Control the same rearranging.
 */
export function StudioHomeScreen({ tiles, loading, covered, snr, onOpen, onCreate, onRefresh, onSignOut, refreshing }: {
  tiles: StudioHomeTile[]; loading: boolean;
  // True while an app fully covers the home screen; the wallpaper animation pauses to save battery.
  covered: boolean;
  snr: StudioSnr | null;
  onOpen: (tile: StudioHomeTile, icon: DOMRect | null) => void;
  onCreate: () => void; onRefresh: () => void; onSignOut: () => void; refreshing: boolean;
}) {
  const { isDarkMode, setThemeMode } = useTheme();
  // Layout choices are per device so an iPad and a MacBook can arrange tiles differently.
  const [layout, setLayout] = useState<Layout>(readLayout);
  // Edit mode jiggles tiles and widgets, lets them be dragged and exposes hide controls, as on the iPadOS home screen.
  const [editing, setEditing] = useState(false);
  // The app library sheet lists hidden apps and planned integrations.
  const [libraryOpen, setLibraryOpen] = useState(false);
  // The widget gallery, opened from the edit-mode toolbar (a toolbar button never shifts the grid mid-drag).
  const [widgetGalleryOpen, setWidgetGalleryOpen] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout)); } catch { /* Private mode keeps the layout for this visit only. */ }
  }, [layout]);

  const ordered = useMemo(() => orderTiles(tiles, layout.order), [tiles, layout.order]);
  const visible = useMemo(() => ordered.filter(tile => !layout.hidden.includes(tile.id)), [ordered, layout.hidden]);
  const hidden = tiles.filter(tile => layout.hidden.includes(tile.id));
  const update = (patch: Partial<Layout>) => setLayout(previous => ({ ...previous, ...patch }));

  const visibleIds = useMemo(() => visible.map(tile => tile.id), [visible]);
  const enterEdit = useCallback(() => setEditing(true), []);
  const labelOf = useCallback((id: string) => tiles.find(tile => tile.id === id)?.name ?? id, [tiles]);
  const reorder = useCallback((ids: string[]) => setLayout(previous => {
    // Hidden tiles keep their place after the visible ones, so the saved order always covers every tile.
    const placed = new Set(ids);
    return { ...previous, order: [...ids, ...orderTiles(tiles, previous.order).map(tile => tile.id).filter(id => !placed.has(id))] };
  }), [tiles]);
  const { containerRef, glide, move, moveMessage, dndProps, sortableProps } = useHomeSortableList({ ids: visibleIds, editing, onEnterEdit: enterEdit, onReorder: reorder, labelOf });

  const activate = (tile: StudioHomeTile, event: MouseEvent<HTMLElement>) => {
    // In edit mode a tap never opens an app (the click that ends a long press is swallowed before it gets here).
    if (editing) { event.preventDefault(); return; }
    if (tile.href) return;
    const icon = event.currentTarget.querySelector('.home-icon');
    onOpen(tile, icon ? icon.getBoundingClientRect() : null);
  };
  const leaveEditOnEmptyTap = (event: MouseEvent<HTMLDivElement>) => {
    if (editing && !(event.target as Element).closest(KEEPS_EDITING)) setEditing(false);
  };
  const today = new Date();
  const iconSize = layout.large ? 52 : 40;

  return <div className={`home-screen ${layout.large ? 'large-icons' : ''} ${layout.labels ? '' : 'no-labels'} ${editing ? 'editing' : ''}`} onClick={leaveEditOnEmptyTap}>
    <StudioFluidBackground paused={covered} />
    <header className="home-top">
      <div className="home-date">
        <span className="home-weekday">{new Intl.DateTimeFormat('zh-CN', { weekday: 'long', timeZone: 'Europe/London' }).format(today)}</span>
        <h1>{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Europe/London' }).format(today)}</h1>
      </div>
      <div className="home-actions">
        {editing ? <>
          <button type="button" className="glass-button home-action-compact" aria-label="添加小组件" title="添加小组件" onClick={() => setWidgetGalleryOpen(true)}><Plus size={17} aria-hidden="true" /><span className="studio-wide-only">小组件</span></button>
          <button type="button" className="glass-button home-action-compact" aria-label="资源库" title="App 资源库" onClick={() => setLibraryOpen(true)}><LayoutGrid size={17} aria-hidden="true" /><span className="studio-wide-only">资源库</span></button>
          <button type="button" className="glass-button strong" onClick={() => setEditing(false)}><Check size={17} aria-hidden="true" />完成</button>
        </> : <>
          <button type="button" className="glass-icon theme-toggle" aria-label={isDarkMode ? '切换到浅色模式' : '切换到深色模式'} title={isDarkMode ? '浅色模式' : '深色模式'}
            onClick={event => revealTheme(() => setThemeMode(isDarkMode ? 'light' : 'dark'), event.currentTarget)}>
            {isDarkMode ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}</button>
          <button type="button" className={`glass-icon ${refreshing ? 'refreshing' : ''}`} aria-label="刷新状态" title="刷新状态" disabled={refreshing} onClick={onRefresh}><RefreshCw size={18} className="refresh-icon" aria-hidden="true" /></button>
          <button type="button" className="glass-icon" aria-label="编辑主屏幕" title="编辑主屏幕" onClick={() => setEditing(true)}><SlidersHorizontal size={18} aria-hidden="true" /></button>
          <button type="button" className="glass-icon" aria-label="退出登录" title="退出登录" onClick={onSignOut}><LogOut size={18} aria-hidden="true" /></button>
        </>}
      </div>
    </header>

    {editing && <div className="home-edit-bar" role="group" aria-label="主屏幕外观">
      <label className="ios-switch-label">显示名称
        <input type="checkbox" role="switch" className="ios-switch" checked={layout.labels} onChange={event => update({ labels: event.target.checked })} />
      </label>
      <label className="ios-switch-label">大图标
        <input type="checkbox" role="switch" className="ios-switch" checked={layout.large} onChange={event => update({ large: event.target.checked })} />
      </label>
    </div>}

    <StudioWidgets editing={editing} snr={snr} paused={covered} onEnterEdit={enterEdit}
      galleryOpen={widgetGalleryOpen} onGalleryClose={() => setWidgetGalleryOpen(false)} />

    <DndContext {...dndProps}>
      <nav ref={containerRef} className="home-grid" aria-label="应用" aria-busy={loading}>
        <SortableContext {...sortableProps}>
          {visible.map((tile, index) => <SortableTile key={tile.id} tile={tile} index={index} last={index === visible.length - 1} editing={editing}
            labels={layout.labels} iconSize={iconSize} onActivate={activate} onHide={() => glide(() => update({ hidden: [...layout.hidden, tile.id] }))}
            onMove={step => move(tile.id, step)} />)}
        </SortableContext>
        {loading && !visible.length && [0, 1, 2].map(index => <div className="home-tile-slot" key={`placeholder-${index}`} aria-hidden="true"><span className="home-tile placeholder"><span className="home-icon tone-ghost" /></span></div>)}
        <div className="home-tile-slot">
          <button type="button" className="home-tile add" style={{ animationDelay: `${visible.length * 45}ms` }} aria-label="新建项目" title={layout.labels ? undefined : '新建项目'} onClick={onCreate}>
            <span className="home-icon tone-ghost" aria-hidden="true"><Plus size={layout.large ? 44 : 34} strokeWidth={1.4} /></span>
            <span className="home-label">新建</span>
          </button>
        </div>
      </nav>
      <p className="studio-visually-hidden" aria-live="polite">{moveMessage}</p>
    </DndContext>

    {libraryOpen && createPortal(<div className="studio-layer" onKeyDown={event => { if (event.key === 'Escape') setLibraryOpen(false); }}>
      <div className="sheet-scrim" aria-hidden="true" onClick={() => setLibraryOpen(false)} />
      <div className="library-sheet" role="dialog" aria-modal="true" aria-labelledby="studio-library-title">
        <div className="library-grabber" aria-hidden="true" />
        <header><h2 id="studio-library-title">App 资源库</h2><button type="button" className="ios-button tinted" autoFocus onClick={() => setLibraryOpen(false)}>完成</button></header>
        <h3>已隐藏</h3>
        <div className="ios-list">
          {hidden.map(tile => <div className="ios-row" key={tile.id}>
            <StudioTileIcon tone={tile.tone} glyph={tile.glyph} size={17} variant="small" />
            <span className="ios-row-body"><strong>{tile.name}</strong></span>
            <button type="button" className="ios-button tinted" onClick={() => update({ hidden: layout.hidden.filter(id => id !== tile.id) })}>添加到主屏幕</button>
          </div>)}
          {!hidden.length && <div className="ios-row no-icon"><span className="ios-row-body"><small>所有应用都在主屏幕上</small></span></div>}
        </div>
        <h3>规划中的接入</h3>
        <div className="ios-list">
          {PLANNED.map(item => <div className="ios-row" key={item.name} aria-disabled="true">
            <StudioTileIcon tone={item.tone} glyph={item.glyph} size={17} variant="small" />
            <span className="ios-row-body"><strong>{item.name}</strong><small>{item.caption}</small></span>
            <span className="status-badge">未接入</span>
          </div>)}
        </div>
        <p className="ios-section-footer">新项目请用主屏幕上的「新建」。规划中的接入在接好真实 API 之前不会显示任何数据。</p>
      </div>
    </div>, document.body)}
  </div>;
}
