import { useEffect, useRef, useState } from 'react';
import type { ComponentType, MouseEvent, PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, CandlestickChart, Check, GraduationCap, LogOut, Mail, MessagesSquare, Minus, Plug, Plus,
  RefreshCw, SlidersHorizontal, SquareTerminal,
} from 'lucide-react';
import type { LucideProps } from 'lucide-react';
import { createPortal } from 'react-dom';

import type { StudioAppId } from '@/shared/types';

// Long-pressing a tile for this long enters edit mode, like the iPadOS home screen.
const LONG_PRESS_MS = 520;
// Per-device layout preferences (hidden tiles, labels, icon size).
const LAYOUT_STORAGE_KEY = 'studio-home-layout-v1';

type Tile = {
  id: StudioAppId; name: string; caption: string; tone: string;
  icon: ComponentType<LucideProps>;
};
// Products in their default home-screen order.
const TILES: Tile[] = [
  { id: 'snr', name: 'SNR 3.0', caption: '策略研究实验室', tone: 'sage', icon: Activity },
  { id: 'professor', name: '超级教授', caption: 'Super Professor', tone: 'clay', icon: GraduationCap },
  { id: 'deepseek', name: 'DeepSeek', caption: '通用对话', tone: 'slate', icon: MessagesSquare },
  { id: 'workspace', name: '开发工具', caption: 'Claude Code · Codex', tone: 'graphite', icon: SquareTerminal },
  { id: 'connections', name: '连接', caption: '密钥与订阅', tone: 'sand', icon: Plug },
];
// Integrations the user plans to add; shown as not yet available, never as working apps.
const PLANNED = [
  { name: '股票看板', caption: '盈亏、曲线与持仓 · 需要券商 API', tone: 'moss', icon: CandlestickChart },
  { name: '邮件整合', caption: 'Gmail 与 Outlook · 需要 OAuth 授权', tone: 'rose', icon: Mail },
];

type Layout = { hidden: StudioAppId[]; labels: boolean; large: boolean };
const DEFAULT_LAYOUT: Layout = { hidden: [], labels: true, large: false };

function readLayout(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? 'null') as Partial<Layout> | null;
    if (!saved) return DEFAULT_LAYOUT;
    return {
      hidden: Array.isArray(saved.hidden) ? saved.hidden.filter(id => TILES.some(tile => tile.id === id)) : [],
      labels: saved.labels !== false,
      large: saved.large === true,
    };
  } catch { return DEFAULT_LAYOUT; }
}

function TileIcon({ tone, icon: Icon, size, small = false }: { tone: string; icon: ComponentType<LucideProps>; size: number; small?: boolean }) {
  return <span className={`home-icon ${small ? 'small ' : ''}tone-${tone}`} aria-hidden="true"><Icon size={size} strokeWidth={1.6} /></span>;
}

/** Used by StudioPage as the launcher: one large icon per product, each opening its own environment. */
export function StudioHomeScreen({ onOpen, onRefresh, onSignOut, refreshing, statusLine }: {
  onOpen: (id: StudioAppId, origin: DOMRect | null) => void;
  onRefresh: () => void; onSignOut: () => void; refreshing: boolean;
  statusLine: Partial<Record<StudioAppId, string>>;
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

  const visible = TILES.filter(tile => !layout.hidden.includes(tile.id));
  const hidden = TILES.filter(tile => layout.hidden.includes(tile.id));
  const update = (patch: Partial<Layout>) => setLayout(previous => ({ ...previous, ...patch }));

  const startPress = (event: PointerEvent) => {
    // Only the primary pointer starts a long press; secondary buttons keep their own behaviour.
    if (editing || event.button > 0) return;
    longPressed.current = false;
    pressTimer.current = window.setTimeout(() => { longPressed.current = true; setEditing(true); }, LONG_PRESS_MS);
  };
  const cancelPress = () => { if (pressTimer.current) window.clearTimeout(pressTimer.current); pressTimer.current = null; };
  const activate = (tile: Tile, event: MouseEvent<HTMLElement>) => {
    // The click that ends a long press only enters edit mode; it must not also open the app.
    if (longPressed.current || editing) { event.preventDefault(); longPressed.current = false; return; }
    if (tile.id === 'workspace') return;
    const icon = event.currentTarget.querySelector('.home-icon');
    onOpen(tile.id, icon ? icon.getBoundingClientRect() : null);
  };
  const today = new Date();

  return <div className={`home-screen ${layout.large ? 'large-icons' : ''} ${layout.labels ? '' : 'no-labels'} ${editing ? 'editing' : ''}`}>
    <div className="home-wallpaper" aria-hidden="true"><span /><span /><span /></div>
    <header className="home-top">
      <div className="home-date">
        <span className="home-weekday">{new Intl.DateTimeFormat('zh-CN', { weekday: 'long', timeZone: 'Europe/London' }).format(today)}</span>
        <h1>{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Europe/London' }).format(today)}</h1>
      </div>
      <div className="home-actions">
        {editing ? <>
          <button type="button" className="glass-button" onClick={() => setLibraryOpen(true)}><Plus size={17} aria-hidden="true" />添加</button>
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

    <nav className="home-grid" aria-label="应用">
      {visible.map((tile, index) => {
        const label = `${tile.name}${statusLine[tile.id] ? `，${statusLine[tile.id]}` : ''}`;
        const body = <>
          <TileIcon tone={tile.tone} icon={tile.icon} size={layout.large ? 52 : 40} />
          <span className="home-label">{tile.name}</span>
          {statusLine[tile.id] && <span className="home-status">{statusLine[tile.id]}</span>}
        </>;
        const shared = {
          className: 'home-tile', style: { animationDelay: `${index * 45}ms` }, title: layout.labels ? undefined : tile.name,
          onPointerDown: startPress, onPointerUp: cancelPress, onPointerLeave: cancelPress, onPointerCancel: cancelPress,
          onContextMenu: (event: MouseEvent) => event.preventDefault(),
        };
        return <div className="home-tile-slot" key={tile.id}>
          {tile.id === 'workspace'
            ? <Link to="/workspace" {...shared} aria-label={label} onClick={event => activate(tile, event)}>{body}</Link>
            : <button type="button" {...shared} aria-label={label} onClick={event => activate(tile, event)}>{body}</button>}
          {editing && <button type="button" className="home-remove" aria-label={`从主屏幕隐藏 ${tile.name}`} onClick={() => update({ hidden: [...layout.hidden, tile.id] })}><Minus size={14} strokeWidth={3} aria-hidden="true" /></button>}
        </div>;
      })}
      {editing && <div className="home-tile-slot">
        <button type="button" className="home-tile add" aria-label="添加应用" onClick={() => setLibraryOpen(true)}>
          <span className="home-icon tone-ghost" aria-hidden="true"><Plus size={34} strokeWidth={1.4} /></span>
          <span className="home-label">添加</span>
        </button>
      </div>}
    </nav>
    {!visible.length && !editing && <p className="home-empty">主屏幕是空的。轻点右上角的调节按钮，再选「添加」恢复应用。</p>}

    {libraryOpen && createPortal(<div className="studio-layer" onKeyDown={event => { if (event.key === 'Escape') setLibraryOpen(false); }}>
      <div className="sheet-scrim" aria-hidden="true" onClick={() => setLibraryOpen(false)} />
      <div className="library-sheet" role="dialog" aria-modal="true" aria-labelledby="studio-library-title">
        <div className="library-grabber" aria-hidden="true" />
        <header><h2 id="studio-library-title">App 资源库</h2><button type="button" className="ios-button tinted" autoFocus onClick={() => setLibraryOpen(false)}>完成</button></header>
        <h3>已隐藏</h3>
        <div className="ios-list">
          {hidden.map(tile => <div className="ios-row" key={tile.id}>
            <TileIcon tone={tile.tone} icon={tile.icon} size={17} small />
            <span className="ios-row-body"><strong>{tile.name}</strong><small>{tile.caption}</small></span>
            <button type="button" className="ios-button tinted" onClick={() => update({ hidden: layout.hidden.filter(id => id !== tile.id) })}>添加到主屏幕</button>
          </div>)}
          {!hidden.length && <div className="ios-row no-icon"><span className="ios-row-body"><small>所有应用都在主屏幕上</small></span></div>}
        </div>
        <h3>规划中的接入</h3>
        <div className="ios-list">
          {PLANNED.map(item => <div className="ios-row" key={item.name} aria-disabled="true">
            <TileIcon tone={item.tone} icon={item.icon} size={17} small />
            <span className="ios-row-body"><strong>{item.name}</strong><small>{item.caption}</small></span>
            <span className="status-badge">未接入</span>
          </div>)}
        </div>
        <p className="ios-section-footer">规划中的应用接入真实 API 前不会显示数据。可以在「开发工具」里让 Claude 或 Codex 搭建它们的界面。</p>
      </div>
    </div>, document.body)}
  </div>;
}
