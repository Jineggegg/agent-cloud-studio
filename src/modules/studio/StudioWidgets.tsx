import { forwardRef, useCallback, useEffect, useMemo, useState } from 'react';
import type { MouseEvent, ReactNode, RefObject, SyntheticEvent } from 'react';
import NumberFlow from '@number-flow/react';
import { AnimatePresence, m } from 'motion/react';
import { ArrowDownRight, ArrowUpRight, ChevronLeft, ChevronRight, Maximize2, Minimize2, Minus } from 'lucide-react';
import { createPortal } from 'react-dom';
import { DndContext, DragOverlay, useDndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';

import { api, readApiJson } from '@/shared/api';
import { readableErrorMessage } from '@/shared/utils';
import type { StudioGitHubInbox, StudioQuotaSnapshot, StudioQuotaWindow, StudioSnr, T212Overview, T212Point } from '@/shared/types';
import { StudioTileIcon } from '@/modules/studio/StudioTileIcon';
import { useHomeSortableItem, useHomeSortableList } from '@/modules/studio/hooks/useHomeSortable';
import '@/modules/studio/studio-home.css';
import '@/modules/studio/studio-github.css';

type WidgetType = 'claude' | 'codex' | 'deepseek' | 'trading212' | 'snr' | 'github';
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
  { type: 'github', name: 'GitHub', caption: '开放的 PR 与 CI 状态', tone: 'graphite', glyph: 'pull-request' },
];
const QUOTA_REFRESH_MS = 60_000;
const T212_REFRESH_MS = 5 * 60_000;
// The server caches the inbox for 45 s, so a two-minute poll costs GitHub at most one search per poll.
const GITHUB_REFRESH_MS = 2 * 60_000;
// Enter and exit of a whole widget (added from the gallery or removed in edit mode).
const PRESENCE_SPRING = { type: 'spring', stiffness: 260, damping: 26 } as const;

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

// `still` draws a widget at its current values with no entrance animation: the copy lifted into the drag overlay
// must look exactly like the card it was picked up from, not refill its rings from zero.
function Ring({ window: quota, now, size = 64, still }: { window: StudioQuotaWindow; now: number; size?: number; still: boolean }) {
  const radius = size / 2 - 5;
  const circumference = 2 * Math.PI * radius;
  const used = Math.min(100, Math.max(0, quota.usedPercent));
  const high = used >= 90;
  return <div className={`quota-ring ${high ? 'is-high' : ''}`}>
    <span className="quota-ring-dial" style={{ width: size, height: size }}>
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="quota-ring-track" cx={size / 2} cy={size / 2} r={radius} />
      <m.circle className="quota-ring-fill" cx={size / 2} cy={size / 2} r={radius}
        strokeDasharray={circumference} initial={still ? false : { strokeDashoffset: circumference }}
        animate={{ strokeDashoffset: circumference * (1 - used / 100) }}
        transition={{ type: 'spring', stiffness: 62, damping: 16 }}
        transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
    <span className="quota-ring-value"><NumberFlow value={Math.round(used)} suffix="%" animated={!still} /></span>
    </span>
    <span className="quota-ring-label">{quota.label}</span>
    <span className="quota-ring-reset">{high ? '接近上限 · ' : ''}{countdown(quota.resetsAt, now)}</span>
  </div>;
}

function QuotaWidget({ snapshot, size, title, tone, glyph, still }: { snapshot: StudioQuotaSnapshot | undefined; size: WidgetSize; title: string; tone: string; glyph: string; still: boolean }) {
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
        : <div className="widget-rings">{windows.map(window => <Ring key={window.id} window={window} now={now} size={size === 'medium' ? 64 : 58} still={still} />)}</div>}
  </>;
}

function DeepSeekWidget({ snapshot, still }: { snapshot: StudioQuotaSnapshot | undefined; still: boolean }) {
  const balance = snapshot?.balances[0];
  return <>
    <header className="widget-head"><StudioTileIcon tone="slate" glyph="sparkles" size={14} variant="small" /><span>DeepSeek</span></header>
    {!snapshot ? <div className="widget-loading" aria-label="读取中"><span /><span /></div>
      : !snapshot.available || !balance ? <p className="widget-note" title={snapshot.note}>{snapshot.note ?? '在设置里保存 API 密钥后显示余额'}</p>
        : <div className="widget-figure">
          <strong><NumberFlow value={balance.total} format={{ style: 'currency', currency: balance.currency, maximumFractionDigits: 2 }} locales="zh-CN" animated={!still} /></strong>
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

// Account overview (null until loaded, 'off' when no key is configured) and a week of balance snapshots.
type TradingReading = { overview: T212Overview | null | 'off'; points: T212Point[] };

/**
 * Loads the Trading 212 reading once for the whole grid while a Trading 212 widget is placed, so the copy of a
 * card lifted into the drag overlay (or a second Trading 212 widget) never fetches on its own.
 */
function useTradingReading(enabled: boolean): TradingReading {
  // The latest reading; it survives the widget being removed and re-added within one visit.
  const [reading, setReading] = useState<TradingReading>({ overview: null, points: [] });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const load = async () => {
      const status = await api.studio.trading212.status().then(readApiJson<{ env: 'live' | 'demo'; configured: boolean }[]>).catch(() => []);
      const env = status.find(item => item.env === 'live' && item.configured)?.env ?? status.find(item => item.configured)?.env;
      if (!env) { if (active) setReading({ overview: 'off', points: [] }); return; }
      const [next, history] = await Promise.all([
        api.studio.trading212.overview(env).then(readApiJson<T212Overview>).catch(() => null),
        api.studio.trading212.history(env, 7).then(readApiJson<T212Point[]>).catch(() => []),
      ]);
      if (active) setReading({ overview: next ?? 'off', points: history });
    };
    void load();
    const timer = window.setInterval(() => void load(), T212_REFRESH_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [enabled]);
  return reading;
}

function TradingWidget({ size, reading: { overview, points }, still }: { size: WidgetSize; reading: TradingReading; still: boolean }) {
  const change = overview && overview !== 'off' ? overview.changes.today : null;
  return <>
    <header className="widget-head"><StudioTileIcon tone="moss" glyph="candles" size={14} variant="small" /><span>Trading 212</span></header>
    {overview === null ? <div className="widget-loading" aria-label="读取中"><span /><span /></div>
      : overview === 'off' ? <p className="widget-note">未接入账户</p>
        : <div className="widget-figure">
          <strong><NumberFlow value={overview.totalValue} format={{ style: 'currency', currency: overview.currency || 'GBP', maximumFractionDigits: size === 'medium' ? 2 : 0 }} locales="zh-CN" animated={!still} /></strong>
          {change ? <small className={`widget-delta ${change.amount >= 0 ? 'gain' : 'loss'}`}>{change.amount >= 0 ? <ArrowUpRight size={13} aria-hidden="true" /> : <ArrowDownRight size={13} aria-hidden="true" />}
            {change.amount >= 0 ? '+' : '−'}{Math.abs(change.amount).toFixed(2)}（{Math.abs(change.percent).toFixed(2)}%）今日</small> : <small>今日变化记录中</small>}
          {size === 'medium' && <Sparkline points={points} />}
        </div>}
  </>;
}

// The PR inbox (null until it first loads) and why the latest read failed (gh signed out, GitHub unreachable).
type GitHubReading = { inbox: StudioGitHubInbox | null; problem: string };

/**
 * Loads the GitHub inbox once for the whole grid while a GitHub widget is placed. Polling stops while an app covers
 * the home screen or the tab is hidden; coming back reads again (a merge made in the app has already cleared the
 * server cache, so the widget catches up at once).
 */
function useGitHubReading(enabled: boolean, paused: boolean): GitHubReading {
  // The latest reading; a failed poll keeps the last inbox and only adds the problem.
  const [reading, setReading] = useState<GitHubReading>({ inbox: null, problem: '' });
  useEffect(() => {
    if (!enabled || paused) return;
    let active = true;
    const load = async () => {
      if (document.hidden) return;
      try {
        const inbox = await api.studio.github.pulls().then(readApiJson<StudioGitHubInbox>);
        if (active) setReading({ inbox, problem: '' });
      } catch (failure) {
        if (active) setReading(previous => ({ inbox: previous.inbox, problem: readableErrorMessage(failure, 'GitHub 暂时读不到') }));
      }
    };
    const tick = () => { void load(); };
    tick();
    const timer = window.setInterval(tick, GITHUB_REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [enabled, paused]);
  return reading;
}

const CI_LABEL: Record<StudioGitHubInbox['pulls'][number]['checks']['state'], string> = { passing: '检查通过', failing: '检查失败', pending: '检查中', none: '没有检查' };

function GitHubWidget({ size, reading: { inbox, problem }, still }: { size: WidgetSize; reading: GitHubReading; still: boolean }) {
  const pulls = inbox?.pulls ?? [];
  const failing = pulls.filter(pull => pull.checks.state === 'failing').length;
  const pending = pulls.filter(pull => pull.checks.state === 'pending').length;
  const checked = pulls.filter(pull => pull.checks.state !== 'none').length;
  const review = pulls.filter(pull => pull.reasons.includes('review')).length;
  const ci = failing ? { tone: 'failing', text: `${failing} 个 PR 检查失败` }
    : pending ? { tone: 'pending', text: `${pending} 个 PR 检查中` }
      : checked ? { tone: 'passing', text: '检查都已通过' }
        : { tone: 'none', text: pulls.length ? '没有 CI 检查' : '没有待处理的 PR' };
  return <>
    <header className="widget-head">
      <StudioTileIcon tone="graphite" glyph="pull-request" size={14} variant="small" /><span>GitHub</span>
      {inbox && problem ? <span className="widget-source is-stale" title={problem}>可能过期</span>
        : size === 'medium' && pulls.length ? <span className="widget-source">共 {pulls.length} 个</span>
          : review > 0 && <span className="widget-source">{review} 个待审</span>}
    </header>
    {!inbox ? (problem ? <p className="widget-note" title={problem}>{problem}</p> : <div className="widget-loading" aria-label="读取中"><span /><span /></div>)
      : size === 'medium' && pulls.length ? <ul className="gh-widget-list">
        {pulls.slice(0, 3).map(pull => <li key={pull.id}>
          <span className={`gh-dot ci-${pull.checks.state}`} role="img" aria-label={CI_LABEL[pull.checks.state]} />
          <span className="gh-widget-pull"><strong>{pull.title}</strong><small>{pull.repo} #{pull.number}{pull.isDraft ? ' · 草稿' : ''}</small></span>
        </li>)}
      </ul>
        : <div className="widget-figure">
          <strong><NumberFlow value={pulls.length} animated={!still} /><span className="gh-widget-unit">个 PR</span></strong>
          <small className="gh-widget-ci"><span className={`gh-dot ci-${ci.tone}`} aria-hidden="true" />{ci.text}</small>
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

function nameOf(type: WidgetType) {
  return CATALOG.find(entry => entry.type === type)?.name ?? type;
}

// Edit controls sit inside the sortable widget; pressing them must not start a drag of the widget.
const stopDragStart = { onPointerDown: (event: SyntheticEvent) => event.stopPropagation(), onTouchStart: (event: SyntheticEvent) => event.stopPropagation() };
const preventContextMenu = (event: MouseEvent) => event.preventDefault();

/**
 * One widget on the grid. The outer cell carries the enter/exit animation (and is what AnimatePresence pops
 * out of the layout on removal, hence the forwarded ref); the inner card is the sortable item, so the drop
 * glide, the jiggle and motion's scale each live on their own element and never overwrite one another.
 * While the card is dragged it stays in the grid as an empty placeholder (its copy rides in the drag overlay),
 * so the grid around it always shows the layout a drop will keep.
 */
const SortableWidget = forwardRef<HTMLDivElement, {
  widget: WidgetConfig; name: string; editing: boolean; children: ReactNode;
  // Whether the widget is already first or last, where its 前移 or 后移 button has nowhere to go.
  first: boolean; last: boolean;
  onRemove: () => void; onResize: () => void; onMove: (step: -1 | 1) => void;
}>(function SortableWidget({ widget, name, editing, children, first, last, onRemove, onResize, onMove }, ref) {
  const { attributes, isDragging, itemAttributes, listeners, setActivatorNodeRef, setNodeRef, style } = useHomeSortableItem(widget.id);
  const setCardRef = useCallback((node: HTMLElement | null) => { setNodeRef(node); setActivatorNodeRef(node); }, [setNodeRef, setActivatorNodeRef]);
  // Focusable and described as sortable only in edit mode, where the keyboard can move it.
  const editAttributes = editing ? { tabIndex: 0, 'aria-roledescription': attributes['aria-roledescription'], 'aria-describedby': attributes['aria-describedby'] } : {};
  return <m.div ref={ref} className={`widget-slot widget-slot-${widget.size}`}
    initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }} transition={PRESENCE_SPRING}>
    <article ref={setCardRef} {...itemAttributes} {...editAttributes} {...listeners} style={style} onContextMenu={preventContextMenu}
      className={`widget widget-${widget.size} ${isDragging ? 'is-placeholder' : ''}`} aria-label={name}>
      {children}
      {editing && <div className="widget-edit" role="group" aria-label={`调整 ${name}`} {...stopDragStart}>
        <button type="button" className="home-remove widget-remove" aria-label={`移除 ${name}`} onClick={onRemove}><Minus size={14} strokeWidth={3} aria-hidden="true" /></button>
        <div className="widget-edit-bar">
          {/* Moving with buttons is the path for VoiceOver and Switch Control, which cannot drag. aria-disabled
              (not disabled) keeps a button focused when its widget reaches an end. */}
          <button type="button" className="widget-move" aria-label={`前移 ${name}`} aria-disabled={first} onClick={() => { if (!first) onMove(-1); }}>
            <ChevronLeft size={15} aria-hidden="true" /></button>
          <button type="button" className="widget-move" aria-label={`后移 ${name}`} aria-disabled={last} onClick={() => { if (!last) onMove(1); }}>
            <ChevronRight size={15} aria-hidden="true" /></button>
          <button type="button" aria-label={widget.size === 'small' ? `放大 ${name}` : `缩小 ${name}`} onClick={onResize}>
            {widget.size === 'small' ? <Maximize2 size={14} aria-hidden="true" /> : <Minimize2 size={14} aria-hidden="true" />}</button>
        </div>
      </div>}
    </article>
  </m.div>;
});

/**
 * The lifted widget, drawn above the grid while it is dragged and following the pointer. It is a still copy of
 * the card (no entrance animations, no controls, hidden from screen readers, which keep the real card).
 */
function WidgetDragOverlay({ widgets, cardRef, renderBody }: {
  widgets: WidgetConfig[]; cardRef: RefObject<HTMLElement>;
  renderBody: (widget: WidgetConfig, still: boolean) => ReactNode;
}) {
  const { active } = useDndContext();
  const widget = active ? widgets.find(item => item.id === active.id) : undefined;
  // No dnd-kit drop animation: on drop the real card glides from here into its slot (useHomeSortableList).
  return <DragOverlay dropAnimation={null} className="widget-drag-overlay">
    {widget && <article ref={cardRef} className={`widget widget-${widget.size} is-lifted`} aria-hidden="true">{renderBody(widget, true)}</article>}
  </DragOverlay>;
}

/**
 * Used by StudioHomeScreen for the customizable widget row above the app icons. Long-pressing a widget lifts it
 * and asks the home screen to enter edit mode; in edit mode widgets jiggle, drag to a new place (the grid
 * reflows live, so what you see while dragging is where the widget lands) or move with their 前移/后移 buttons.
 */
export function StudioWidgets({ editing, snr, paused = false, onEnterEdit, galleryOpen, onGalleryClose }: {
  editing: boolean; snr: StudioSnr | null; paused?: boolean;
  // Called when a long press lifts a widget outside edit mode.
  onEnterEdit: () => void;
  // The widget gallery is opened from the home screen's edit-mode toolbar, as on iPadOS.
  galleryOpen: boolean; onGalleryClose: () => void;
}) {
  // The widgets this device shows, in order, with their sizes.
  const [widgets, setWidgets] = useState<WidgetConfig[]>(readWidgets);
  // Quota snapshots for Claude / Codex / DeepSeek; null until the first response.
  const [quota, setQuota] = useState<StudioQuotaSnapshot[] | null>(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(widgets)); } catch { /* Private mode keeps the layout for this visit only. */ }
  }, [widgets]);
  const needsQuota = widgets.some(widget => widget.type === 'claude' || widget.type === 'codex' || widget.type === 'deepseek');
  const trading = useTradingReading(widgets.some(widget => widget.type === 'trading212'));
  const github = useGitHubReading(widgets.some(widget => widget.type === 'github'), paused);
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

  const ids = useMemo(() => widgets.map(widget => widget.id), [widgets]);
  const labelOf = useCallback((id: string) => {
    const widget = widgets.find(item => item.id === id);
    return widget ? nameOf(widget.type) : id;
  }, [widgets]);
  const reorder = useCallback((order: string[]) => setWidgets(previous => {
    const byId = new Map(previous.map(widget => [widget.id, widget]));
    const next = order.flatMap(id => byId.get(id) ?? []);
    // A stale order (a widget was removed mid-drag) keeps the current layout rather than losing widgets.
    return next.length === previous.length ? next : previous;
  }), []);
  const { containerRef, overlayRef, glide, move, moveMessage, dndProps, sortableProps } = useHomeSortableList({
    ids, editing, onEnterEdit, onReorder: reorder, labelOf,
    // Small and medium widgets share one grid, so only a real reorder previews where a drop lands.
    reorderWhileDragging: true,
  });

  const find = (provider: StudioQuotaSnapshot['provider']) => quota === null ? undefined
    : quota.find(item => item.provider === provider) ?? { provider, available: false, windows: [], balances: [], source: 'unavailable', observedAt: null, stale: false, note: '额度服务暂不可用' };
  // A widget's content, for its card in the grid and for the still copy lifted into the drag overlay.
  const renderBody = (widget: WidgetConfig, still: boolean) => <>
    {widget.type === 'claude' && <QuotaWidget snapshot={find('claude')} size={widget.size} title="Claude Code" tone="clay" glyph="sparkles" still={still} />}
    {widget.type === 'codex' && <QuotaWidget snapshot={find('codex')} size={widget.size} title="Codex" tone="graphite" glyph="terminal" still={still} />}
    {widget.type === 'deepseek' && <DeepSeekWidget snapshot={find('deepseek')} still={still} />}
    {widget.type === 'trading212' && <TradingWidget size={widget.size} reading={trading} still={still} />}
    {widget.type === 'snr' && <SnrWidget snr={snr} />}
    {widget.type === 'github' && <GitHubWidget size={widget.size} reading={github} still={still} />}
  </>;
  const add = (type: WidgetType, size: WidgetSize) => {
    setWidgets(previous => [...previous, { id: newWidgetId(type), type, size }]);
    onGalleryClose();
  };
  // Removing or resizing reflows the grid; the neighbours glide into their new places.
  const remove = (id: string) => glide(() => setWidgets(previous => previous.filter(item => item.id !== id)));
  const resize = (id: string) => glide(() => setWidgets(previous => previous.map(item => item.id === id ? { ...item, size: item.size === 'small' ? 'medium' : 'small' } : item)));

  const gallery = galleryOpen && createPortal(<div className="studio-layer" onKeyDown={event => { if (event.key === 'Escape') onGalleryClose(); }}>
    <div className="sheet-scrim" aria-hidden="true" onClick={onGalleryClose} />
    <div className="library-sheet" role="dialog" aria-modal="true" aria-labelledby="studio-widget-gallery">
      <div className="library-grabber" aria-hidden="true" />
      <header><h2 id="studio-widget-gallery">小组件</h2><button type="button" className="ios-button tinted" autoFocus onClick={onGalleryClose}>完成</button></header>
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
  </div>, document.body);

  if (!widgets.length) return gallery || null;
  return <DndContext {...dndProps}>
    <section ref={containerRef} className={`widget-grid ${editing ? 'editing' : ''}`} aria-label="小组件">
      <SortableContext {...sortableProps}>
        {/* popLayout takes a removed widget out of the flow at once, so its neighbours can glide into the gap. */}
        <AnimatePresence initial={false} mode="popLayout">
          {widgets.map((widget, index) => <SortableWidget key={widget.id} widget={widget} name={nameOf(widget.type)} editing={editing}
            first={index === 0} last={index === widgets.length - 1}
            onRemove={() => remove(widget.id)} onResize={() => resize(widget.id)} onMove={step => move(widget.id, step)}>
            {renderBody(widget, false)}
          </SortableWidget>)}
        </AnimatePresence>
      </SortableContext>
    </section>
    <WidgetDragOverlay widgets={widgets} cardRef={overlayRef} renderBody={renderBody} />
    <p className="studio-visually-hidden" aria-live="polite">{moveMessage}</p>
    {gallery}
  </DndContext>;
}
