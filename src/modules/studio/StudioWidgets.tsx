import { useCallback, useEffect, useState } from 'react';
import NumberFlow from '@number-flow/react';
import { AnimatePresence, m } from 'motion/react';
import { ArrowDownRight, ArrowUpRight, ChevronLeft, ChevronRight, Maximize2, Minimize2, Minus, Plus } from 'lucide-react';
import { createPortal } from 'react-dom';

import { api, readApiJson } from '@/shared/api';
import type { StudioQuotaSnapshot, StudioQuotaWindow, StudioSnr, T212Overview, T212Point } from '@/shared/types';
import { StudioTileIcon } from '@/modules/studio/StudioTileIcon';

type WidgetType = 'claude' | 'codex' | 'deepseek' | 'trading212' | 'snr';
type WidgetSize = 'small' | 'medium';
type WidgetConfig = { id: string; type: WidgetType; size: WidgetSize };

// Per-device widget layout, like iPadOS (each device arranges its own home screen).
const STORAGE_KEY = 'studio-widgets-v1';
const DEFAULT_WIDGETS: WidgetConfig[] = [
  { id: 'w-claude', type: 'claude', size: 'medium' },
  { id: 'w-codex', type: 'codex', size: 'small' },
  { id: 'w-deepseek', type: 'deepseek', size: 'small' },
  { id: 'w-t212', type: 'trading212', size: 'medium' },
];
const CATALOG: { type: WidgetType; name: string; caption: string; tone: string; glyph: string }[] = [
  { type: 'claude', name: 'Claude 额度', caption: '5 小时与每周用量、重置倒计时', tone: 'clay', glyph: 'sparkles' },
  { type: 'codex', name: 'Codex 额度', caption: 'ChatGPT 套餐用量与重置时间', tone: 'graphite', glyph: 'terminal' },
  { type: 'deepseek', name: 'DeepSeek 余额', caption: 'API 账户余额', tone: 'slate', glyph: 'sparkles' },
  { type: 'trading212', name: 'Trading 212', caption: '总资产、今日盈亏与走势', tone: 'moss', glyph: 'candles' },
  { type: 'snr', name: 'SNR 实验室', caption: '在线状态与研究阶段', tone: 'sage', glyph: 'activity' },
];
const QUOTA_REFRESH_MS = 60_000;
const T212_REFRESH_MS = 5 * 60_000;

function newWidgetId(type: WidgetType) {
  return `w-${type}-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function readWidgets(): WidgetConfig[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as WidgetConfig[] | null;
    if (!Array.isArray(saved)) return DEFAULT_WIDGETS;
    const seen = new Set<string>();
    // Ids are React keys and edit targets, so a missing or repeated id (older layouts) gets a fresh one.
    return saved.filter(item => item && CATALOG.some(entry => entry.type === item.type) && (item.size === 'small' || item.size === 'medium'))
      .map(item => {
        const id = typeof item.id === 'string' && item.id && !seen.has(item.id) ? item.id : newWidgetId(item.type);
        seen.add(id);
        return { id, type: item.type, size: item.size };
      });
  } catch { return DEFAULT_WIDGETS; }
}

// Re-renders every `interval` ms so countdowns stay current without per-widget timers.
function useNow(interval: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(timer);
  }, [interval]);
  return now;
}

function countdown(resetsAt: string | null, now: number) {
  if (!resetsAt) return '重置时间未知';
  // Rounded up, so a window with seconds left never reads as already reset.
  const minutes = Math.max(0, Math.ceil((Date.parse(resetsAt) - now) / 60_000));
  if (minutes <= 0) return '已重置';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days) return `${days} 天 ${hours} 小时后重置`;
  if (hours) return `${hours} 小时 ${rest} 分后重置`;
  return `${rest} 分钟后重置`;
}

const SOURCE_LABEL: Record<StudioQuotaSnapshot['source'], string> = {
  official: '官方', statusline: '官方快照', 'sdk-event': '会话快照', 'local-log': '本地记录', unavailable: '未接入',
};

function Ring({ window: quota, now, size = 64 }: { window: StudioQuotaWindow; now: number; size?: number }) {
  const radius = size / 2 - 5;
  const circumference = 2 * Math.PI * radius;
  const used = Math.min(100, Math.max(0, quota.usedPercent));
  const high = used >= 90;
  return <div className={`quota-ring ${high ? 'is-high' : ''}`}>
    <span className="quota-ring-dial" style={{ width: size, height: size }}>
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="quota-ring-track" cx={size / 2} cy={size / 2} r={radius} />
      <m.circle className="quota-ring-fill" cx={size / 2} cy={size / 2} r={radius}
        strokeDasharray={circumference} initial={{ strokeDashoffset: circumference }}
        animate={{ strokeDashoffset: circumference * (1 - used / 100) }}
        transition={{ type: 'spring', stiffness: 62, damping: 16 }}
        transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
    <span className="quota-ring-value"><NumberFlow value={Math.round(used)} suffix="%" /></span>
    </span>
    <span className="quota-ring-label">{quota.label}</span>
    <span className="quota-ring-reset">{high ? '接近上限 · ' : ''}{countdown(quota.resetsAt, now)}</span>
  </div>;
}

function QuotaWidget({ snapshot, size, title, tone, glyph }: { snapshot: StudioQuotaSnapshot | undefined; size: WidgetSize; title: string; tone: string; glyph: string }) {
  const now = useNow(30_000);
  const windows = (snapshot?.windows ?? []).slice(0, size === 'medium' ? 3 : 1);
  return <>
    <header className="widget-head">
      <StudioTileIcon tone={tone} glyph={glyph} size={14} variant="small" />
      <span>{title}</span>
      {snapshot && <span className={`widget-source ${snapshot.stale ? 'is-stale' : ''}`}>{snapshot.stale ? '可能过期' : SOURCE_LABEL[snapshot.source]}</span>}
    </header>
    {!snapshot ? <div className="widget-loading" aria-label="读取中"><span /><span /></div>
      : !snapshot.available || !windows.length ? <p className="widget-note" title={snapshot.note}>{snapshot.note ?? '暂时没有额度数据'}</p>
        : <div className="widget-rings">{windows.map(window => <Ring key={window.id} window={window} now={now} size={size === 'medium' ? 64 : 58} />)}</div>}
  </>;
}

function DeepSeekWidget({ snapshot }: { snapshot: StudioQuotaSnapshot | undefined }) {
  const balance = snapshot?.balances[0];
  return <>
    <header className="widget-head"><StudioTileIcon tone="slate" glyph="sparkles" size={14} variant="small" /><span>DeepSeek</span></header>
    {!snapshot ? <div className="widget-loading" aria-label="读取中"><span /><span /></div>
      : !snapshot.available || !balance ? <p className="widget-note" title={snapshot.note}>{snapshot.note ?? '在设置里保存 API 密钥后显示余额'}</p>
        : <div className="widget-figure">
          <strong><NumberFlow value={balance.total} format={{ style: 'currency', currency: balance.currency, maximumFractionDigits: 2 }} locales="zh-CN" /></strong>
          <small>{balance.granted > 0 ? `含赠送 ${balance.granted.toFixed(2)}` : 'API 余额'}</small>
        </div>}
  </>;
}

function Sparkline({ points }: { points: T212Point[] }) {
  if (points.length < 2) return null;
  const values = points.map(point => point.value);
  const min = Math.min(...values); const max = Math.max(...values);
  const path = values.map((value, index) => `${index ? 'L' : 'M'}${(index / (values.length - 1) * 100).toFixed(2)},${(28 - (value - min) / (max - min || 1) * 24 - 2).toFixed(2)}`).join(' ');
  return <svg className={`widget-spark ${values.at(-1)! >= values[0] ? 'gain' : 'loss'}`} viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><path d={path} /></svg>;
}

function TradingWidget({ size }: { size: WidgetSize }) {
  // Account overview and a week of balance snapshots; null until loaded, 'off' when no key is configured.
  const [overview, setOverview] = useState<T212Overview | null | 'off'>(null);
  // Points for the small trend line.
  const [points, setPoints] = useState<T212Point[]>([]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const status = await api.studio.trading212.status().then(readApiJson<{ env: 'live' | 'demo'; configured: boolean }[]>).catch(() => []);
      const env = status.find(item => item.env === 'live' && item.configured)?.env ?? status.find(item => item.configured)?.env;
      if (!env) { if (active) setOverview('off'); return; }
      const [next, history] = await Promise.all([
        api.studio.trading212.overview(env).then(readApiJson<T212Overview>).catch(() => null),
        api.studio.trading212.history(env, 7).then(readApiJson<T212Point[]>).catch(() => []),
      ]);
      if (active) { setOverview(next ?? 'off'); setPoints(history); }
    };
    void load();
    const timer = window.setInterval(() => void load(), T212_REFRESH_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const change = overview && overview !== 'off' ? overview.changes.today : null;
  return <>
    <header className="widget-head"><StudioTileIcon tone="moss" glyph="candles" size={14} variant="small" /><span>Trading 212</span></header>
    {overview === null ? <div className="widget-loading" aria-label="读取中"><span /><span /></div>
      : overview === 'off' ? <p className="widget-note">未接入账户</p>
        : <div className="widget-figure">
          <strong><NumberFlow value={overview.totalValue} format={{ style: 'currency', currency: overview.currency || 'GBP', maximumFractionDigits: size === 'medium' ? 2 : 0 }} locales="zh-CN" /></strong>
          {change ? <small className={`widget-delta ${change.amount >= 0 ? 'gain' : 'loss'}`}>{change.amount >= 0 ? <ArrowUpRight size={13} aria-hidden="true" /> : <ArrowDownRight size={13} aria-hidden="true" />}
            {change.amount >= 0 ? '+' : '−'}{Math.abs(change.amount).toFixed(2)}（{Math.abs(change.percent).toFixed(2)}%）今日</small> : <small>今日变化记录中</small>}
          {size === 'medium' && <Sparkline points={points} />}
        </div>}
  </>;
}

function SnrWidget({ snr }: { snr: StudioSnr | null }) {
  const online = Boolean(snr?.connected);
  return <>
    <header className="widget-head"><StudioTileIcon tone="sage" glyph="activity" size={14} variant="small" /><span>SNR 实验室</span></header>
    <div className="widget-figure">
      <strong className="widget-status"><span className={`status-dot ${online ? 'good' : ''}`} aria-hidden="true" />{online ? '在线' : '离线'}</strong>
      <small>{snr?.phase ? `Phase ${snr.phase}` : '研究阶段未知'}{snr?.manifest?.version ? ` · v${snr.manifest.version}` : ''}</small>
    </div>
  </>;
}

/** Used by StudioHomeScreen for the customizable widget row above the app icons. */
export function StudioWidgets({ editing, snr, paused = false }: { editing: boolean; snr: StudioSnr | null; paused?: boolean }) {
  // The widgets this device shows, in order, with their sizes.
  const [widgets, setWidgets] = useState<WidgetConfig[]>(readWidgets);
  // Quota snapshots for Claude / Codex / DeepSeek; null until the first response.
  const [quota, setQuota] = useState<StudioQuotaSnapshot[] | null>(null);
  // The widget gallery sheet opened from edit mode.
  const [gallery, setGallery] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(widgets)); } catch { /* Private mode keeps the layout for this visit only. */ }
  }, [widgets]);
  const needsQuota = widgets.some(widget => widget.type === 'claude' || widget.type === 'codex' || widget.type === 'deepseek');
  const loadQuota = useCallback(async () => {
    const next = await api.studio.quota().then(readApiJson<StudioQuotaSnapshot[]>).catch(() => null);
    // A failed poll keeps the last reading (the per-snapshot "stale" flag still ages it); only a first failure shows the fallback.
    setQuota(previous => next ?? previous ?? []);
  }, []);
  useEffect(() => {
    // Each poll can start a Codex app-server on the host, so polling stops while an app covers the home screen or the tab is hidden.
    if (!needsQuota || paused) return;
    const tick = () => { if (!document.hidden) void loadQuota(); };
    tick();
    const timer = window.setInterval(tick, QUOTA_REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [needsQuota, paused, loadQuota]);

  const find = (provider: StudioQuotaSnapshot['provider']) => quota === null ? undefined
    : quota.find(item => item.provider === provider) ?? { provider, available: false, windows: [], balances: [], source: 'unavailable', observedAt: null, stale: false, note: '额度服务暂不可用' };
  const move = (index: number, step: number) => setWidgets(previous => {
    const next = [...previous];
    const target = index + step;
    if (target < 0 || target >= next.length) return previous;
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
  const add = (type: WidgetType, size: WidgetSize) => {
    setWidgets(previous => [...previous, { id: newWidgetId(type), type, size }]);
    setGallery(false);
  };

  if (!widgets.length && !editing) return null;
  return <section className={`widget-grid ${editing ? 'editing' : ''}`} aria-label="小组件">
    <AnimatePresence initial={false}>
      {widgets.map((widget, index) => {
        const entry = CATALOG.find(item => item.type === widget.type)!;
        return <m.article key={widget.id} layout className={`widget widget-${widget.size}`} aria-label={entry.name}
          initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }}
          transition={{ type: 'spring', stiffness: 260, damping: 26 }}>
          {widget.type === 'claude' && <QuotaWidget snapshot={find('claude')} size={widget.size} title="Claude Code" tone="clay" glyph="sparkles" />}
          {widget.type === 'codex' && <QuotaWidget snapshot={find('codex')} size={widget.size} title="Codex" tone="graphite" glyph="terminal" />}
          {widget.type === 'deepseek' && <DeepSeekWidget snapshot={find('deepseek')} />}
          {widget.type === 'trading212' && <TradingWidget size={widget.size} />}
          {widget.type === 'snr' && <SnrWidget snr={snr} />}
          {editing && <div className="widget-edit" role="group" aria-label={`调整 ${entry.name}`}>
            <button type="button" className="home-remove widget-remove" aria-label={`移除 ${entry.name}`} onClick={() => setWidgets(previous => previous.filter(item => item.id !== widget.id))}><Minus size={14} strokeWidth={3} aria-hidden="true" /></button>
            <div className="widget-edit-bar">
              <button type="button" aria-label="前移" disabled={index === 0} onClick={() => move(index, -1)}><ChevronLeft size={16} aria-hidden="true" /></button>
              <button type="button" aria-label={widget.size === 'small' ? '放大' : '缩小'} onClick={() => setWidgets(previous => previous.map(item => item.id === widget.id ? { ...item, size: item.size === 'small' ? 'medium' : 'small' } : item))}>
                {widget.size === 'small' ? <Maximize2 size={14} aria-hidden="true" /> : <Minimize2 size={14} aria-hidden="true" />}</button>
              <button type="button" aria-label="后移" disabled={index === widgets.length - 1} onClick={() => move(index, 1)}><ChevronRight size={16} aria-hidden="true" /></button>
            </div>
          </div>}
        </m.article>;
      })}
    </AnimatePresence>
    {editing && <m.button layout type="button" className="widget widget-small widget-add" onClick={() => setGallery(true)} aria-label="添加小组件">
      <Plus size={26} strokeWidth={1.5} aria-hidden="true" /><span>添加小组件</span>
    </m.button>}

    {gallery && createPortal(<div className="studio-layer" onKeyDown={event => { if (event.key === 'Escape') setGallery(false); }}>
      <div className="sheet-scrim" aria-hidden="true" onClick={() => setGallery(false)} />
      <div className="library-sheet" role="dialog" aria-modal="true" aria-labelledby="studio-widget-gallery">
        <div className="library-grabber" aria-hidden="true" />
        <header><h2 id="studio-widget-gallery">小组件</h2><button type="button" className="ios-button tinted" autoFocus onClick={() => setGallery(false)}>完成</button></header>
        <div className="ios-list">
          {CATALOG.map(entry => <div className="ios-row" key={entry.type}>
            <StudioTileIcon tone={entry.tone} glyph={entry.glyph} size={17} variant="small" />
            <span className="ios-row-body"><strong>{entry.name}</strong><small>{entry.caption}</small></span>
            <button type="button" className="ios-button tinted" onClick={() => add(entry.type, 'small')}>小</button>
            <button type="button" className="ios-button tinted" onClick={() => add(entry.type, 'medium')}>中</button>
          </div>)}
        </div>
        <p className="ios-section-footer">额度来自各模型的官方接口或快照；标注「可能过期」时表示最近没有新数据。</p>
      </div>
    </div>, document.body)}
  </section>;
}
