import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactNode, RefObject, SyntheticEvent } from 'react';
import NumberFlow from '@number-flow/react';
import { AnimatePresence, m } from 'motion/react';
import { ArrowDownRight, ArrowUpRight, Eye, EyeOff, Minus } from 'lucide-react';
import { createPortal } from 'react-dom';
import { DndContext, DragOverlay, useDndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';

import { api, readApiJson } from '@/shared/api';
import type { StudioGitHubInbox, StudioQuotaSnapshot, StudioQuotaWindow, StudioSnr, T212Overview, T212Point } from '@/shared/types';
import { StudioTileIcon } from '@/modules/studio/StudioTileIcon';
import { useGitHubReading } from '@/modules/studio/hooks/useGitHubReading';
import { useHomeSortableItem, useHomeSortableList } from '@/modules/studio/hooks/useHomeSortable';
import '@/modules/studio/studio-home.css';
import '@/modules/studio/studio-github.css';

export type WidgetType = 'claude' | 'codex' | 'deepseek' | 'trading212' | 'snr' | 'github';
// iPadOS widget sizes: small is one grid cell, medium two cells wide, large two wide and two tall.
type WidgetSize = 'small' | 'medium' | 'large';
type WidgetConfig = { id: string; type: WidgetType; size: WidgetSize };
const SIZES: WidgetSize[] = ['small', 'medium', 'large'];
const SIZE_LABEL: Record<WidgetSize, string> = { small: '小', medium: '中', large: '大' };

// Per-device widget layout, like iPadOS (each device arranges its own home screen).
const STORAGE_KEY = 'studio-widgets-v1';
// Whether the Trading 212 widget hides its amounts; per device, like the layout (someone may be looking at this screen).
const MASK_STORAGE_KEY = 'studio-widgets-hide-amounts';
const MASKED = '••••••';
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
    return saved.filter(item => item && CATALOG.some(entry => entry.type === item.type) && SIZES.includes(item.size))
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
  // `usage-api` is what Claude's own /usage shows, read live with the machine's Claude login.
  official: '官方', 'usage-api': '官方', statusline: '官方快照', 'sdk-event': '会话快照', 'local-log': '本地记录', unavailable: '未接入',
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

// How long a quota window is ("5 小时", "每周"), for the large widget's detail rows.
function windowLength(minutes: number | null) {
  if (!minutes) return null;
  if (minutes === 10_080) return '每周';
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

const resetClock = new Intl.DateTimeFormat('zh-CN', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const shortClock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' });

function money(value: number, currency: string, digits = 2) {
  try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: currency || 'GBP', maximumFractionDigits: digits }).format(value); }
  catch { return value.toFixed(digits); }
}

function QuotaWidget({ snapshot, size, title, tone, glyph, still }: { snapshot: StudioQuotaSnapshot | undefined; size: WidgetSize; title: string; tone: string; glyph: string; still: boolean }) {
  const now = useNow(30_000);
  const windows = (snapshot?.windows ?? []).slice(0, size === 'small' ? 1 : 3);
  return <>
    <header className="widget-head">
      <StudioTileIcon tone={tone} glyph={glyph} size={14} variant="small" />
      <span>{title}</span>
      {snapshot && <span className={`widget-source ${snapshot.stale ? 'is-stale' : ''}`}>{snapshot.stale ? '可能过期' : SOURCE_LABEL[snapshot.source]}</span>}
    </header>
    {!snapshot ? <div className="widget-loading" aria-label="读取中"><span /><span /></div>
      : !snapshot.available || !windows.length ? <p className="widget-note" title={snapshot.note}>{snapshot.note ?? '暂时没有额度数据'}</p>
        : <>
          <div className="widget-rings">{windows.map(window => <Ring key={window.id} window={window} now={now} size={size === 'small' ? 58 : size === 'medium' ? 64 : 76} still={still} />)}</div>
          {/* Large: what is left in each window, how long the window is and the exact time it resets. */}
          {size === 'large' && <ul className="widget-rows">
            {windows.map(window => <li key={window.id}>
              <span>{window.label}{windowLength(window.windowMinutes) ? ` · ${windowLength(window.windowMinutes)}` : ''}</span>
              <small>{window.resetsAt ? `${resetClock.format(new Date(window.resetsAt))} 重置` : '重置时间未知'}</small>
              <strong>剩余 {Math.max(0, 100 - Math.round(window.usedPercent))}%</strong>
            </li>)}
          </ul>}
          {size === 'large' && snapshot.observedAt && <p className="widget-footnote">更新于 {shortClock.format(new Date(snapshot.observedAt))}</p>}
        </>}
  </>;
}

function DeepSeekWidget({ snapshot, size, still }: { snapshot: StudioQuotaSnapshot | undefined; size: WidgetSize; still: boolean }) {
  const balance = snapshot?.balances[0];
  return <>
    <header className="widget-head"><StudioTileIcon tone="slate" glyph="sparkles" size={14} variant="small" /><span>DeepSeek</span></header>
    {!snapshot ? <div className="widget-loading" aria-label="读取中"><span /><span /></div>
      : !snapshot.available || !balance ? <p className="widget-note" title={snapshot.note}>{snapshot.note ?? '在设置里保存 API 密钥后显示余额'}</p>
        : <>
          <div className="widget-figure">
            <strong><NumberFlow value={balance.total} format={{ style: 'currency', currency: balance.currency, maximumFractionDigits: 2 }} locales="zh-CN" animated={!still} /></strong>
            <small>{size === 'small' && balance.granted > 0 ? `含赠送 ${balance.granted.toFixed(2)}` : 'API 余额'}</small>
          </div>
          {/* Medium and large split the balance into what was topped up and what was granted. */}
          {size !== 'small' && <ul className="widget-rows">
            <li><span>充值余额</span><strong>{money(balance.toppedUp, balance.currency)}</strong></li>
            <li><span>赠送余额</span><strong>{money(balance.granted, balance.currency)}</strong></li>
          </ul>}
          {size === 'large' && snapshot.observedAt && <p className="widget-footnote">更新于 {shortClock.format(new Date(snapshot.observedAt))}</p>}
        </>}
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

function TradingWidget({ size, reading: { overview, points }, still, masked, onToggleMask }: {
  size: WidgetSize; reading: TradingReading; still: boolean;
  // Amounts replaced by dots; the curve stays, as it shows no figures.
  masked: boolean; onToggleMask: () => void;
}) {
  const change = overview && overview !== 'off' ? overview.changes.today : null;
  const hide = (text: string) => masked ? MASKED : text;
  return <>
    <header className="widget-head"><StudioTileIcon tone="moss" glyph="candles" size={14} variant="small" /><span>Trading 212</span>
      {overview && overview !== 'off' && <button type="button" className="widget-eye" aria-pressed={masked} aria-label={masked ? '显示金额' : '隐藏金额'}
        tabIndex={still ? -1 : undefined} onClick={onToggleMask} {...stopDragStart}>
        {masked ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}</button>}
    </header>
    {overview === null ? <div className="widget-loading" aria-label="读取中"><span /><span /></div>
      : overview === 'off' ? <p className="widget-note">未接入账户</p>
        : <>
          <div className="widget-figure">
            {masked ? <strong className="widget-masked">{money(0, overview.currency, 0).replace(/[\d.,\s]/g, '')} {MASKED}</strong>
              : <strong><NumberFlow value={overview.totalValue} format={{ style: 'currency', currency: overview.currency || 'GBP', maximumFractionDigits: size === 'small' ? 0 : 2 }} locales="zh-CN" animated={!still} /></strong>}
            {masked ? <small>金额已隐藏</small> : change ? <small className={`widget-delta ${change.amount >= 0 ? 'gain' : 'loss'}`}>{change.amount >= 0 ? <ArrowUpRight size={13} aria-hidden="true" /> : <ArrowDownRight size={13} aria-hidden="true" />}
              {change.amount >= 0 ? '+' : '−'}{Math.abs(change.amount).toFixed(2)}（{Math.abs(change.percent).toFixed(2)}%）今日</small> : <small>今日变化记录中</small>}
            {size !== 'small' && <Sparkline points={points} />}
          </div>
          {/* Large adds where the money sits and the biggest positions. */}
          {size === 'large' && <>
            <dl className="widget-stats">
              <div><dt>可用现金</dt><dd>{hide(money(overview.cash.available, overview.currency, 0))}</dd></div>
              <div><dt>持仓市值</dt><dd>{hide(money(overview.investments.value, overview.currency, 0))}</dd></div>
              <div><dt>未实现盈亏</dt><dd className={masked ? undefined : `widget-delta ${overview.investments.unrealized >= 0 ? 'gain' : 'loss'}`}>{hide(money(overview.investments.unrealized, overview.currency, 0))}</dd></div>
            </dl>
            {overview.positions.length > 0 && <ul className="widget-rows">
              {[...overview.positions].sort((a, b) => b.value - a.value).slice(0, 3).map(position => <li key={position.ticker}>
                <span>{position.name || position.ticker}</span>
                <strong className={masked ? undefined : `widget-delta ${position.pnl >= 0 ? 'gain' : 'loss'}`}>{hide(`${position.pnl >= 0 ? '+' : '−'}${money(Math.abs(position.pnl), overview.currency)}`)}</strong>
              </li>)}
            </ul>}
          </>}
        </>}
  </>;
}

const CI_LABEL: Record<StudioGitHubInbox['pulls'][number]['checks']['state'], string> = { passing: '检查通过', failing: '检查失败', pending: '检查中', none: '没有检查' };

function GitHubWidget({ size, reading: { inbox, problem }, still }: { size: WidgetSize; reading: ReturnType<typeof useGitHubReading>; still: boolean }) {
  const pulls = inbox?.pulls ?? [];
  const failing = pulls.filter(pull => pull.checks.state === 'failing').length;
  const pending = pulls.filter(pull => pull.checks.state === 'pending').length;
  const checked = pulls.filter(pull => pull.checks.state !== 'none').length;
  const review = pulls.filter(pull => pull.reasons.includes('review')).length;
  const ci = failing ? { tone: 'failing', text: `${failing} 个 PR 检查失败` }
    : pending ? { tone: 'pending', text: `${pending} 个 PR 检查中` }
      : checked ? { tone: 'passing', text: '检查都已通过' }
        : { tone: 'none', text: pulls.length ? '没有 CI 检查' : '没有待处理的 PR' };
  const figure = <div className="widget-figure">
    <strong><NumberFlow value={pulls.length} animated={!still} /><span className="gh-widget-unit">个 PR</span></strong>
    <small className="gh-widget-ci"><span className={`gh-dot ci-${ci.tone}`} aria-hidden="true" />{ci.text}</small>
  </div>;
  // Medium lists the first three PRs; large keeps the count and CI summary on top of the first four.
  const list = (count: number) => <ul className="gh-widget-list">
    {pulls.slice(0, count).map(pull => <li key={pull.id}>
      <span className={`gh-dot ci-${pull.checks.state}`} role="img" aria-label={CI_LABEL[pull.checks.state]} />
      <span className="gh-widget-pull"><strong>{pull.title}</strong><small>{pull.repo} #{pull.number}{pull.isDraft ? ' · 草稿' : ''}</small></span>
    </li>)}
  </ul>;
  return <>
    <header className="widget-head">
      <StudioTileIcon tone="graphite" glyph="pull-request" size={14} variant="small" /><span>GitHub</span>
      {inbox && problem ? <span className="widget-source is-stale" title={problem}>可能过期</span>
        : size === 'medium' && pulls.length ? <span className="widget-source">共 {pulls.length} 个</span>
          : review > 0 && <span className="widget-source">{review} 个待审</span>}
    </header>
    {!inbox ? (problem ? <p className="widget-note" title={problem}>{problem}</p> : <div className="widget-loading" aria-label="读取中"><span /><span /></div>)
      : size === 'medium' && pulls.length ? list(3)
        : size === 'large' && pulls.length ? <>{figure}{list(4)}</>
          : figure}
  </>;
}

function SnrWidget({ snr, size }: { snr: StudioSnr | null; size: WidgetSize }) {
  const online = Boolean(snr?.connected);
  const capabilities = snr?.manifest?.capabilities ?? [];
  return <>
    <header className="widget-head"><StudioTileIcon tone="sage" glyph="activity" size={14} variant="small" /><span>SNR 实验室</span></header>
    <div className="widget-figure">
      <strong className="widget-status"><span className={`status-dot ${online ? 'good' : ''}`} aria-hidden="true" />{online ? '在线' : '离线'}</strong>
      <small>{snr?.phase ? `Phase ${snr.phase}` : '研究阶段未知'}{snr?.manifest?.version ? ` · v${snr.manifest.version}` : ''}</small>
    </div>
    {size !== 'small' && <ul className="widget-rows">
      <li><span>数据集</span><strong>{snr?.datasetCount ?? '—'}</strong></li>
      {size === 'large' && <>
        <li><span>交易</span><strong>{snr?.tradingEnabled ? '已开启' : '未开启'}</strong></li>
        <li><span>规则</span><strong>{snr?.rulesApproved ? '已批准' : '待批准'}</strong></li>
      </>}
    </ul>}
    {size === 'large' && capabilities.length > 0 && <p className="widget-chips">{capabilities.slice(0, 6).map(item => <span key={item}>{item}</span>)}</p>}
  </>;
}

function nameOf(type: WidgetType) {
  return CATALOG.find(entry => entry.type === type)?.name ?? type;
}

// Edit controls sit inside the sortable widget; pressing them must not start a drag of the widget.
const stopDragStart = { onPointerDown: (event: SyntheticEvent) => event.stopPropagation(), onTouchStart: (event: SyntheticEvent) => event.stopPropagation() };
const preventContextMenu = (event: MouseEvent) => event.preventDefault();

// Grid cells a widget covers. iPadOS has no tall narrow widget, so two rows is always the large size.
const sizeForSpan = (columns: number, rows: number): WidgetSize => rows > 1 ? 'large' : columns > 1 ? 'medium' : 'small';

/**
 * The resize corner of a widget in edit mode, as on iPadOS: dragging it snaps the card between small, medium and
 * large as soon as the corner passes half a grid cell, so the grid reflows under the finger. It is also a slider
 * for the keyboard and assistive technology (arrow keys step through the sizes).
 */
function WidgetResizeHandle({ name, size, onResize }: { name: string; size: WidgetSize; onResize: (size: WidgetSize) => void }) {
  // Where the drag started and the card's grid cell, measured once at the start.
  const drag = useRef<{ x: number; y: number; width: number; height: number; cell: number; row: number; gap: number; rowGap: number } | null>(null);
  // The size last asked for, so a drag asks only once per change even before the new size renders.
  const asked = useRef(size);
  const [active, setActive] = useState(false);

  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const card = event.currentTarget.closest('.widget');
    const grid = card?.closest('.widget-grid');
    if (!card || !grid) return;
    const rect = card.getBoundingClientRect();
    const style = getComputedStyle(grid);
    const gap = parseFloat(style.columnGap) || 0;
    const rowGap = parseFloat(style.rowGap) || gap;
    const columns = size === 'small' ? 1 : 2;
    const rows = size === 'large' ? 2 : 1;
    drag.current = {
      x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, gap, rowGap,
      cell: (rect.width - gap * (columns - 1)) / columns, row: (rect.height - rowGap * (rows - 1)) / rows,
    };
    asked.current = size;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setActive(true);
  };
  const follow = (event: PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    if (!from) return;
    const columns = from.width + event.clientX - from.x > from.cell * 1.5 + from.gap / 2 ? 2 : 1;
    const rows = from.height + event.clientY - from.y > from.row * 1.5 + from.rowGap / 2 ? 2 : 1;
    const next = sizeForSpan(columns, rows);
    if (next === asked.current) return;
    asked.current = next;
    onResize(next);
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    setActive(false);
  };
  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = SIZES.indexOf(size);
    const target = { ArrowRight: index + 1, ArrowUp: index + 1, ArrowLeft: index - 1, ArrowDown: index - 1, Home: 0, End: SIZES.length - 1 }[event.key];
    if (target === undefined) return;
    // The card's own keyboard handler would otherwise pick the widget up.
    event.preventDefault();
    event.stopPropagation();
    const next = SIZES[Math.min(SIZES.length - 1, Math.max(0, target))];
    if (next !== size) onResize(next);
  };
  return <div role="slider" tabIndex={0} className={`widget-resize ${active ? 'is-active' : ''}`} aria-label={`调整 ${name} 大小`}
    aria-valuemin={1} aria-valuemax={SIZES.length} aria-valuenow={SIZES.indexOf(size) + 1} aria-valuetext={SIZE_LABEL[size]}
    onPointerDown={start} onPointerMove={follow} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} onKeyDown={step}>
    <svg viewBox="0 0 44 44" aria-hidden="true"><path d="M38 12A26 26 0 0 1 12 38" /></svg>
  </div>;
}

/**
 * One widget on the grid. The outer cell carries the enter/exit animation (and is what AnimatePresence pops
 * out of the layout on removal, hence the forwarded ref); the inner card is the sortable item, so the drop
 * glide, the jiggle and motion's scale each live on their own element and never overwrite one another.
 * While the card is dragged it stays in the grid as an empty placeholder (its copy rides in the drag overlay),
 * so the grid around it always shows the layout a drop will keep.
 */
const SortableWidget = forwardRef<HTMLDivElement, {
  widget: WidgetConfig; name: string; editing: boolean; children: ReactNode;
  onRemove: () => void; onResize: (size: WidgetSize) => void;
  // Opens the widget's app; the card's rectangle is where the app zooms out of.
  onOpen: (card: DOMRect) => void;
}>(function SortableWidget({ widget, name, editing, children, onRemove, onResize, onOpen }, ref) {
  const { attributes, isDragging, itemAttributes, listeners, setActivatorNodeRef, setNodeRef, style } = useHomeSortableItem(widget.id);
  const setCardRef = useCallback((node: HTMLElement | null) => { setNodeRef(node); setActivatorNodeRef(node); }, [setNodeRef, setActivatorNodeRef]);
  // Focusable and described as sortable only in edit mode, where the keyboard can move it.
  const editAttributes = editing ? { tabIndex: 0, 'aria-roledescription': attributes['aria-roledescription'], 'aria-describedby': attributes['aria-describedby'] } : {};
  return <m.div ref={ref} className={`widget-slot widget-slot-${widget.size}`}
    initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }} transition={PRESENCE_SPRING}>
    <article ref={setCardRef} {...itemAttributes} {...editAttributes} {...listeners} style={style} onContextMenu={preventContextMenu}
      className={`widget widget-${widget.size} ${isDragging ? 'is-placeholder' : ''}`} aria-label={name}>
      {/* A tap anywhere on the card opens its app: this button covers the card under its own controls. A long press
          still lifts the card (the card's listeners see the press), and the click that ends a drag is swallowed. */}
      {!editing && <button type="button" className="widget-open" aria-label={`打开 ${name}`}
        onClick={event => onOpen((event.currentTarget.parentElement ?? event.currentTarget).getBoundingClientRect())} />}
      {children}
      {editing && <div className="widget-edit" role="group" aria-label={`调整 ${name}`} {...stopDragStart}>
        <button type="button" className="home-remove widget-remove" aria-label={`移除 ${name}`} onClick={onRemove}><Minus size={14} strokeWidth={3} aria-hidden="true" /></button>
        <WidgetResizeHandle name={name} size={widget.size} onResize={onResize} />
      </div>}
    </article>
  </m.div>;
});

/**
 * The lifted widget, drawn above the grid while it is dragged and following the pointer. It is a still copy of
 * the card (no entrance animations, no controls, hidden from screen readers, which keep the real card).
 * The overlay is a fixed box; inside the home screen's sliding pages (a transformed ancestor) a fixed box is
 * placed against the pages, not the screen, so it is portaled into `container` when one is given.
 */
function WidgetDragOverlay({ widgets, cardRef, renderBody, container }: {
  widgets: WidgetConfig[]; cardRef: RefObject<HTMLElement>;
  renderBody: (widget: WidgetConfig, still: boolean) => ReactNode;
  container: Element | null;
}) {
  const { active } = useDndContext();
  const widget = active ? widgets.find(item => item.id === active.id) : undefined;
  // No dnd-kit drop animation: on drop the real card glides from here into its slot (useHomeSortableList).
  const overlay = <DragOverlay dropAnimation={null} className="widget-drag-overlay">
    {widget && <article ref={cardRef} className={`widget widget-${widget.size} is-lifted`} aria-hidden="true">{renderBody(widget, true)}</article>}
  </DragOverlay>;
  return container ? createPortal(overlay, container) : overlay;
}

/**
 * Used by StudioHomeScreen for the customizable widget row above the app icons, on the first page. Long-pressing a widget lifts it
 * and asks the home screen to enter edit mode; in edit mode widgets jiggle, drag to a new place (the grid
 * reflows live, so what you see while dragging is where the widget lands, or move with the keyboard) and resize
 * between small, medium and large by dragging their corner.
 */
export function StudioWidgets({ editing, snr, paused = false, onEnterEdit, onOpen, galleryOpen, onGalleryClose, overlayContainer = null, onDragActiveChange }: {
  editing: boolean; snr: StudioSnr | null; paused?: boolean;
  // Called when a widget is tapped outside edit mode, with the card's rectangle for the zoom.
  onOpen: (type: WidgetType, card: DOMRect) => void;
  // Called when a long press lifts a widget outside edit mode.
  onEnterEdit: () => void;
  // The widget gallery is opened from the home screen's edit-mode toolbar, as on iPadOS.
  galleryOpen: boolean; onGalleryClose: () => void;
  // Where the lifted card is drawn while dragged: outside the home screen's sliding pages (see WidgetDragOverlay).
  overlayContainer?: Element | null;
  // Told when a widget drag starts and ends, so the home screen does not turn pages under it.
  onDragActiveChange?: (active: boolean) => void;
}) {
  // The widgets this device shows, in order, with their sizes.
  const [widgets, setWidgets] = useState<WidgetConfig[]>(readWidgets);
  const [masked, setMasked] = useState(() => { try { return localStorage.getItem(MASK_STORAGE_KEY) === '1'; } catch { return false; } });
  const toggleMask = () => setMasked(previous => {
    try { localStorage.setItem(MASK_STORAGE_KEY, previous ? '0' : '1'); } catch { /* Private mode: hidden for this visit only. */ }
    return !previous;
  });
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
  const { containerRef, overlayRef, glide, moveMessage, dndProps, sortableProps } = useHomeSortableList({
    ids, editing, onEnterEdit, onReorder: reorder, labelOf, onDragActiveChange,
    // Widgets of three sizes share one grid, so only a real reorder previews where a drop lands.
    reorderWhileDragging: true,
  });

  const find = (provider: StudioQuotaSnapshot['provider']) => quota === null ? undefined
    : quota.find(item => item.provider === provider) ?? { provider, available: false, windows: [], balances: [], source: 'unavailable', observedAt: null, stale: false, note: '额度服务暂不可用' };
  // A widget's content, for its card in the grid and for the still copy lifted into the drag overlay.
  const renderBody = (widget: WidgetConfig, still: boolean) => <>
    {widget.type === 'claude' && <QuotaWidget snapshot={find('claude')} size={widget.size} title="Claude Code" tone="clay" glyph="sparkles" still={still} />}
    {widget.type === 'codex' && <QuotaWidget snapshot={find('codex')} size={widget.size} title="Codex" tone="graphite" glyph="terminal" still={still} />}
    {widget.type === 'deepseek' && <DeepSeekWidget snapshot={find('deepseek')} size={widget.size} still={still} />}
    {widget.type === 'trading212' && <TradingWidget size={widget.size} reading={trading} still={still} masked={masked} onToggleMask={toggleMask} />}
    {widget.type === 'snr' && <SnrWidget snr={snr} size={widget.size} />}
    {widget.type === 'github' && <GitHubWidget size={widget.size} reading={github} still={still} />}
  </>;
  const add = (type: WidgetType, size: WidgetSize) => {
    setWidgets(previous => [...previous, { id: newWidgetId(type), type, size }]);
    onGalleryClose();
  };
  // Removing or resizing reflows the grid; the neighbours glide into their new places.
  const remove = (id: string) => glide(() => setWidgets(previous => previous.filter(item => item.id !== id)));
  const resize = (id: string, size: WidgetSize) => glide(() => setWidgets(previous => previous.map(item => item.id === id ? { ...item, size } : item)));

  const gallery = galleryOpen && createPortal(<div className="studio-layer" onKeyDown={event => { if (event.key === 'Escape') onGalleryClose(); }}>
    <div className="sheet-scrim" aria-hidden="true" onClick={onGalleryClose} />
    <div className="library-sheet" role="dialog" aria-modal="true" aria-labelledby="studio-widget-gallery">
      <div className="library-grabber" aria-hidden="true" />
      <header><h2 id="studio-widget-gallery">小组件</h2><button type="button" className="ios-button tinted" autoFocus onClick={onGalleryClose}>完成</button></header>
      <div className="ios-list">
        {CATALOG.map(entry => <div className="ios-row" key={entry.type}>
          <StudioTileIcon tone={entry.tone} glyph={entry.glyph} size={17} variant="small" />
          <span className="ios-row-body"><strong>{entry.name}</strong><small>{entry.caption}</small></span>
          {SIZES.map(size => <button type="button" key={size} className="ios-button tinted" aria-label={`添加${SIZE_LABEL[size]}号 ${entry.name}`} onClick={() => add(entry.type, size)}>{SIZE_LABEL[size]}</button>)}
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
          {widgets.map(widget => <SortableWidget key={widget.id} widget={widget} name={nameOf(widget.type)} editing={editing}
            onRemove={() => remove(widget.id)} onResize={size => resize(widget.id, size)} onOpen={card => onOpen(widget.type, card)}>
            {renderBody(widget, false)}
          </SortableWidget>)}
        </AnimatePresence>
      </SortableContext>
    </section>
    <WidgetDragOverlay widgets={widgets} cardRef={overlayRef} renderBody={renderBody} container={overlayContainer} />
    <p className="studio-visually-hidden" aria-live="polite">{moveMessage}</p>
    {gallery}
  </DndContext>;
}
