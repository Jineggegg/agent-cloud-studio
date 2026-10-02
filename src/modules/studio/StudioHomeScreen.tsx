import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { Check, LogOut, Minus, Plus, RefreshCw, SlidersHorizontal } from 'lucide-react';

import type { StudioHomeTile } from '@/shared/types';
import { StudioTileIcon } from '@/modules/studio/StudioTileIcon';

// Long-pressing a tile for this long enters edit mode, like the iPadOS home screen.
const LONG_PRESS_MS = 520;
// Per-device layout preferences (hidden tiles, labels, icon size).
const LAYOUT_STORAGE_KEY = 'studio-home-layout-v1';
// Integrations that are planned but not built; listed honestly as not connected.
const PLANNED = [
  { name: 'Outlook 邮件', caption: '需要注册 Microsoft OAuth 应用', tone: 'rose', glyph: 'mail' },
];

type Layout = { hidden: string[]; labels: boolean; large: boolean };
const DEFAULT_LAYOUT: Layout = { hidden: [], labels: true, large: false };

function readLayout(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? 'null') as Partial<Layout> | null;
    if (!saved) return DEFAULT_LAYOUT;
    return {
      hidden: Array.isArray(saved.hidden) ? saved.hidden.filter(id => typeof id === 'string') : [],
      labels: saved.labels !== false,
      large: saved.large === true,
    };
  } catch { return DEFAULT_LAYOUT; }
}

/** Used by StudioPage as the launcher: one large icon per project or app, plus + to create a project. */
export function StudioHomeScreen({ tiles, loading, onOpen, onCreate, onRefresh, onSignOut, refreshing }: {
  tiles: StudioHomeTile[]; loading: boolean;
  onOpen: (tile: StudioHomeTile, icon: DOMRect | null) => void;
  onCreate: () => void; onRefresh: () => void; onSignOut: () => void; refreshing: boolean;
}) {
  // Layout choices are per device so an iPad and a MacBook can arrange tiles differently.
  const [layout, setLayout] = useState<Layout>(readLayout);
  // Edit mode wiggles tiles and exposes hide controls, as on the iPadOS home screen.
  const [editing, setEditing] = useState(false);
  // The app library sheet lists hidden apps and planned integrations.
  const [libraryOpen, setLibraryOpen] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);

  useEffect(() => {
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout)); } catch { /* Private mode keeps the layout for this visit only. */ }
  }, [layout]);
  useEffect(() => () => { if (pressTimer.current) window.clearTimeout(pressTimer.current); }, []);

  const visible = tiles.filter(tile => !layout.hidden.includes(tile.id));
  const hidden = tiles.filter(tile => layout.hidden.includes(tile.id));
  const update = (patch: Partial<Layout>) => setLayout(previous => ({ ...previous, ...patch }));

  const startPress = (event: PointerEvent) => {
    // Only the primary pointer starts a long press; secondary buttons keep their own behaviour.
    if (editing || event.button > 0) return;
    longPressed.current = false;
    pressTimer.current = window.setTimeout(() => { longPressed.current = true; setEditing(true); }, LONG_PRESS_MS);
  };
  const cancelPress = () => { if (pressTimer.current) window.clearTimeout(pressTimer.current); pressTimer.current = null; };
  const activate = (tile: StudioHomeTile, event: MouseEvent<HTMLElement>) => {
    // The click that ends a long press only enters edit mode; it must not also open the app.
    if (longPressed.current || editing) { event.preventDefault(); longPressed.current = false; return; }
    if (tile.href) return;
    const icon = event.currentTarget.querySelector('.home-icon');
    onOpen(tile, icon ? icon.getBoundingClientRect() : null);
  };
  const today = new Date();
  const iconSize = layout.large ? 52 : 40;

  return <div className={`home-screen ${layout.large ? 'large-icons' : ''} ${layout.labels ? '' : 'no-labels'} ${editing ? 'editing' : ''}`}>
    <div className="home-wallpaper" aria-hidden="true"><span /><span /><span /></div>
    <header className="home-top">
      <div className="home-date">
        <span className="home-weekday">{new Intl.DateTimeFormat('zh-CN', { weekday: 'long', timeZone: 'Europe/London' }).format(today)}</span>
        <h1>{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Europe/London' }).format(today)}</h1>
      </div>
      <div className="home-actions">
        {editing ? <>
          <button type="button" className="glass-button" onClick={() => setLibraryOpen(true)}><Plus size={17} aria-hidden="true" />资源库</button>
          <button type="button" className="glass-button strong" onClick={() => setEditing(false)}><Check size={17} aria-hidden="true" />完成</button>
        </> : <>
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

    <nav className="home-grid" aria-label="应用" aria-busy={loading}>
      {visible.map((tile, index) => {
        const label = `${tile.name}${tile.status ? `，${tile.status}` : ''}`;
        const body = <>
          <StudioTileIcon tone={tile.tone} glyph={tile.glyph} size={iconSize} />
          <span className="home-label">{tile.name}</span>
          {tile.status && <span className="home-status">{tile.status}</span>}
        </>;
        const shared = {
          className: 'home-tile', style: { animationDelay: `${index * 45}ms` }, title: layout.labels ? undefined : tile.name, 'aria-label': label,
          onPointerDown: startPress, onPointerUp: cancelPress, onPointerLeave: cancelPress, onPointerCancel: cancelPress,
          onContextMenu: (event: MouseEvent) => event.preventDefault(),
        };
        return <div className="home-tile-slot" key={tile.id}>
          {tile.href
            ? <Link to={tile.href} {...shared} onClick={event => activate(tile, event)}>{body}</Link>
            : <button type="button" {...shared} onClick={event => activate(tile, event)}>{body}</button>}
          {editing && <button type="button" className="home-remove" aria-label={`从主屏幕隐藏 ${tile.name}`} onClick={() => update({ hidden: [...layout.hidden, tile.id] })}><Minus size={14} strokeWidth={3} aria-hidden="true" /></button>}
        </div>;
      })}
      {loading && !visible.length && [0, 1, 2].map(index => <div className="home-tile-slot" key={`placeholder-${index}`} aria-hidden="true"><span className="home-tile placeholder"><span className="home-icon tone-ghost" /></span></div>)}
      <div className="home-tile-slot">
        <button type="button" className="home-tile add" style={{ animationDelay: `${visible.length * 45}ms` }} aria-label="新建项目" title={layout.labels ? undefined : '新建项目'} onClick={onCreate}>
          <span className="home-icon tone-ghost" aria-hidden="true"><Plus size={layout.large ? 44 : 34} strokeWidth={1.4} /></span>
          <span className="home-label">新建</span>
        </button>
      </div>
    </nav>

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
