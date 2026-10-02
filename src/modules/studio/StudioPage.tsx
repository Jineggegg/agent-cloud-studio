import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, UIEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, ChevronLeft, ExternalLink, GraduationCap, LayoutGrid, MessagesSquare, RefreshCw, Search,
  ShieldCheck, SquarePen, SquareTerminal, Trash2,
} from 'lucide-react';

import { useAuth } from '@/modules/auth';
import { api } from '@/shared/api';
import type { StudioAppId, StudioChatSpace, StudioConversation } from '@/shared/types';
import { useStudio } from '@/modules/studio/hooks/useStudio';
import { StudioChat } from '@/modules/studio/StudioChat';
import { StudioConfirmSheet } from '@/modules/studio/StudioConfirmSheet';
import { StudioConnections } from '@/modules/studio/StudioConnections';
import { StudioHomeScreen } from '@/modules/studio/StudioHomeScreen';
import { StudioSnrView } from '@/modules/studio/StudioSnrView';
import '@/modules/studio/studio.css';

type OpenApp = Exclude<StudioAppId, 'workspace'>;
// Apps that open inside Studio; chat apps carry their own conversation space and persona.
const APPS: Record<OpenApp, { title: string; space?: StudioChatSpace; assistant?: string }> = {
  snr: { title: 'SNR 实验室' },
  professor: { title: '超级教授', space: 'super-professor', assistant: '超级教授' },
  deepseek: { title: 'DeepSeek', space: 'deepseek', assistant: 'DeepSeek' },
  connections: { title: '连接' },
};
// Durations match the zoom keyframes in studio.css.
const APP_OPEN_MS = 560;
const APP_CLOSE_MS = 420;
// Scrolling past the large title collapses it into the glass navigation bar.
const LARGE_TITLE_COLLAPSE_AT = 28;
const RESEARCH_AREAS = ['行情回放与图表标注', 'HPA / EL / SNR AOI', '纠正记录与样本库', 'Wiki 规则审核'];

function formatDay(value: string) {
  const date = new Date(value);
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

/** Used by App as the landing launcher: a home screen of product icons, each opening its own environment. */
export function StudioPage() {
  // The chat app whose history is loaded; it changes only when another chat app opens.
  const [chatSpace, setChatSpace] = useState<StudioChatSpace>('deepseek');
  const studio = useStudio(chatSpace);
  const { logout } = useAuth();
  // The open app, or null while the home screen is showing.
  const [app, setApp] = useState<OpenApp | null>(null);
  // Zoom phase: an app grows out of its icon and shrinks back into it.
  const [transition, setTransition] = useState<'opening' | 'closing' | null>(null);
  // Screen point of the tapped icon, used as the zoom's transform origin.
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  // History filtering is local and never changes saved conversation titles.
  const [search, setSearch] = useState('');
  // Phones push from the conversation list to a thread; wider layouts show both side by side.
  const [threadOpen, setThreadOpen] = useState(false);
  // The navigation bar turns into translucent glass once the large title scrolls away.
  const [compact, setCompact] = useState(false);
  // Manual refreshes show the progress line until every status request settles.
  const [refreshing, setRefreshing] = useState(false);
  // Deleting a conversation waits for an explicit confirmation in the alert.
  const [pendingDelete, setPendingDelete] = useState<StudioConversation | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!transition) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(() => {
      if (transition === 'closing') setApp(null);
      setTransition(null);
    }, reduced ? 0 : transition === 'opening' ? APP_OPEN_MS : APP_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [transition]);

  const signOut = () => { void api.studio.closeSnr().finally(logout).catch(() => {}); };
  const openApp = (id: StudioAppId, icon: DOMRect | null) => {
    if (id === 'workspace' || transition) return;
    const space = APPS[id].space;
    if (space) setChatSpace(space);
    setOrigin(icon ? { x: icon.left + icon.width / 2, y: icon.top + icon.height / 2 } : null);
    setSearch('');
    setThreadOpen(false);
    setCompact(false);
    setApp(id);
    setTransition('opening');
  };
  // Home works even mid-zoom: the closing animation simply replaces the opening one.
  const goHome = () => { if (transition !== 'closing') setTransition('closing'); };
  const openChat = async (id?: string) => {
    if (studio.sending) return;
    if (id) await studio.select(id); else studio.startNew();
    setThreadOpen(true);
  };
  const refresh = async () => {
    setRefreshing(true);
    try { await studio.refresh(); } finally { setRefreshing(false); }
  };
  const onScroll = (event: UIEvent<HTMLDivElement>) => setCompact(event.currentTarget.scrollTop > LARGE_TITLE_COLLAPSE_AT);

  const configured = Boolean(studio.status?.deepseek.configured);
  const snrOnline = Boolean(studio.snr?.connected);
  const chatApp = app ? APPS[app].space !== undefined : false;
  const history = studio.history.filter(item => item.title.toLowerCase().includes(search.toLowerCase()));
  const navTitle = !app ? '' : chatApp
    ? (threadOpen || studio.active ? studio.active?.title ?? '新对话' : APPS[app].title)
    : APPS[app].title;
  const busy = studio.loading || refreshing || studio.sending;
  const statusLine: Partial<Record<StudioAppId, string>> = studio.loading ? {} : {
    snr: snrOnline ? '在线' : '离线',
    deepseek: configured ? undefined : '待配置',
    professor: configured ? undefined : '待配置',
    connections: configured ? undefined : '1 项待配置',
  };
  const appStyle = (origin ? { '--origin-x': `${origin.x}px`, '--origin-y': `${origin.y}px` } : {}) as CSSProperties;

  return <div className="studio" data-thread={chatApp && threadOpen ? 'true' : 'false'} data-transition={transition ?? undefined}>
    {busy && <div className="studio-progress" role="progressbar" aria-label={studio.sending ? '正在回复' : '正在同步'} />}
    {studio.error && <div className="studio-alert" role="alert"><span>{studio.error}</span><button type="button" className="ios-button tinted" onClick={() => void refresh()}>重试</button></div>}

    {/* The home screen stays mounted under an open app so its entrance animation and edit state persist. */}
    <div className={`home-layer ${app && !transition ? 'is-covered' : ''}`} aria-hidden={app ? true : undefined}>
      <StudioHomeScreen onOpen={openApp} onRefresh={() => void refresh()} onSignOut={signOut} refreshing={refreshing} statusLine={statusLine} />
    </div>

    {app && <div className={`studio-app ${transition ?? ''}`} style={appStyle} role="region" aria-label={APPS[app].title}>
      <main className="studio-main">
        <header className="studio-navbar" data-compact={chatApp || compact ? 'true' : 'false'}>
          <div className="navbar-leading">
            {chatApp && threadOpen
              ? <button type="button" className="navbar-back ios-press studio-phone-only" onClick={() => setThreadOpen(false)}><ChevronLeft size={26} aria-hidden="true" />{APPS[app].title}</button>
              : null}
            <button type="button" className={`navbar-back ios-press ${chatApp && threadOpen ? 'studio-wide-only' : ''}`} onClick={goHome} aria-label="返回主屏幕"><ChevronLeft size={26} aria-hidden="true" /><LayoutGrid size={18} aria-hidden="true" /></button>
          </div>
          <div className="navbar-title" aria-hidden={!chatApp && !compact}>
            {navTitle}
            {chatApp && (threadOpen || studio.active) && <small>{APPS[app].assistant} · {studio.active?.model ?? '新建'}</small>}
          </div>
          <div className="navbar-trailing">
            <span className="studio-private"><ShieldCheck size={15} aria-hidden="true" />私有工作空间</span>
            {app === 'professor' && <Link to="/workspace" className="icon-button" aria-label="在开发工具中用 Claude 或 Codex 打开" title="在开发工具中用 Claude / Codex 打开"><SquareTerminal size={19} aria-hidden="true" /></Link>}
            {chatApp ? <>
              {studio.active && <button type="button" className="icon-button danger" aria-label="删除当前对话" title="删除当前对话" disabled={studio.sending} onClick={() => setPendingDelete(studio.active)}><Trash2 size={19} aria-hidden="true" /></button>}
              <button type="button" className="icon-button" aria-label="新建对话" title="新建对话" disabled={studio.sending} onClick={() => void openChat()}><SquarePen size={21} aria-hidden="true" /></button>
            </> : <button type="button" className={`icon-button ${refreshing ? 'refreshing' : ''}`} aria-label="刷新状态" title="刷新状态"
              disabled={studio.loading || refreshing} onClick={() => void refresh()}><RefreshCw size={19} className="refresh-icon" aria-hidden="true" /></button>}
          </div>
        </header>

        {chatApp ? <div className="studio-chat-layout">
          <aside className="studio-chat-list" aria-label="对话列表">
            <div className="chat-list-search">
              <label className="ios-search"><Search size={17} aria-hidden="true" />
                <input type="search" aria-label="搜索对话" placeholder="搜索" value={search} onChange={event => setSearch(event.target.value)} />
              </label>
            </div>
            <div className="chat-list-scroll">
              {history.length > 0 && <div className="chat-list-group studio-stagger">
                {history.map(item => <div className={`chat-list-item ${studio.active?.id === item.id ? 'selected' : ''}`} key={item.id}>
                  <button type="button" className="ios-row" disabled={studio.sending} aria-current={studio.active?.id === item.id ? 'true' : undefined} onClick={() => void openChat(item.id)}>
                    <span className={`home-icon small tone-${app === 'professor' ? 'clay' : 'slate'}`} aria-hidden="true">{app === 'professor' ? <GraduationCap size={16} strokeWidth={1.6} /> : <MessagesSquare size={16} strokeWidth={1.6} />}</span>
                    <span className="ios-row-body"><strong>{item.title}</strong><small>{item.model}</small></span>
                    <time dateTime={item.updated_at}>{formatDay(item.updated_at)}</time>
                  </button>
                  <button type="button" className="icon-button" title="删除对话" aria-label={`删除 ${item.title}`} disabled={studio.sending} onClick={() => setPendingDelete(item)}><Trash2 size={17} aria-hidden="true" /></button>
                </div>)}
              </div>}
              {!history.length && <div className="ios-empty"><MessagesSquare size={30} strokeWidth={1.5} aria-hidden="true" /><span>{search ? '没有匹配的对话' : `${APPS[app].title} 还没有对话`}</span>
                {!search && <button type="button" className="ios-button tinted" onClick={() => void openChat()}>新建对话</button>}</div>}
            </div>
          </aside>
          <StudioChat key={chatSpace} assistant={APPS[app].assistant} tone={app === 'professor' ? 'clay' : 'slate'} active={studio.active} models={studio.status?.deepseek.models ?? ['deepseek-flash', 'deepseek-v4-pro']} sending={studio.sending} onSend={studio.send} onStop={studio.stop} />
        </div> : <div className="studio-scroll" ref={scroller} onScroll={onScroll}>
          <div className="studio-content">
            <div className="studio-large-title"><h1>{APPS[app].title}</h1></div>
            {studio.loading ? <div className="studio-skeleton" role="status" aria-label="正在连接工作台">
              <div className="skeleton-block" style={{ height: 96 }} />
              <div className="skeleton-block" style={{ height: 220 }} />
            </div> : <>
              {app === 'snr' && <div className="studio-stagger">
                <div className="snr-hero">
                  <span className="home-icon tone-sage" aria-hidden="true"><Activity size={30} strokeWidth={1.6} /></span>
                  <div><h2>SNR 3.0</h2><p>Strategy Laboratory · 本机</p></div>
                  <span className={`status-badge ${snrOnline ? 'good' : ''}`}>{snrOnline ? '在线' : '离线'}</span>
                </div>
                {!snrOnline && <p className="snr-offline-note" role="status">{studio.snr?.reason ?? '未连接'}</p>}
                <div className="snr-facts">
                  <div className="snr-fact"><span>研究阶段</span><strong>{studio.snr?.phase ? `Phase ${studio.snr.phase}` : '未知'}</strong></div>
                  <div className="snr-fact"><span>数据集</span><strong>{snrOnline ? studio.snr?.datasetCount ?? 0 : '–'}</strong></div>
                  <div className="snr-fact"><span>策略规则</span><strong>{snrOnline ? studio.snr?.rulesApproved ? '已批准' : '待审核' : '未知'}</strong></div>
                  <div className="snr-fact"><span>交易</span><strong>{snrOnline ? studio.snr?.tradingEnabled ? '已启用' : '未启用' : '未知'}</strong></div>
                </div>
                <div className="snr-actions">
                  <StudioSnrView connected={snrOnline} />
                  {studio.status?.snrRemoteUrl && <a className="ios-button tinted" href={studio.status.snrRemoteUrl} target="_blank" rel="noreferrer">独立入口<ExternalLink size={16} aria-hidden="true" /></a>}
                </div>
                <section className="ios-section" aria-labelledby="studio-research-heading">
                  <div className="ios-section-header"><h2 id="studio-research-heading">研究工作区</h2><span className="caption">登录保护</span></div>
                  <div className="ios-list">
                    {RESEARCH_AREAS.map((label, index) => <div className="ios-row" key={label}>
                      <span className="ios-row-number">0{index + 1}</span>
                      <span className="ios-row-body"><strong>{label}</strong></span>
                      <span className="status-badge">开发中</span>
                    </div>)}
                  </div>
                </section>
                <p className="studio-boundary"><ShieldCheck size={16} aria-hidden="true" />规则未审批 · 不自动训练 · 不执行交易</p>
              </div>}
              {app === 'connections' && <StudioConnections status={studio.status} onChange={studio.refresh} />}
            </>}
          </div>
        </div>}
      </main>
    </div>}

    {pendingDelete && <StudioConfirmSheet title="删除此对话？" message={`“${pendingDelete.title}”及全部消息将被删除，此操作无法撤销。`} confirmLabel="删除"
      onCancel={() => setPendingDelete(null)}
      onConfirm={() => {
        const target = pendingDelete;
        setPendingDelete(null);
        // Deleting the open thread on a phone returns to the list instead of an empty thread.
        if (target.id === studio.active?.id) setThreadOpen(false);
        void studio.remove(target.id);
      }} />}
  </div>;
}
