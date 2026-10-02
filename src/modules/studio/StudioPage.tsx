import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties, UIEvent } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AnimatePresence, LazyMotion, MotionConfig, m } from 'motion/react';
import { Toaster, toast } from 'sonner';
import { ChevronLeft, FolderX, Globe, LayoutGrid, RefreshCw, ShieldCheck, SquarePen, Trash2 } from 'lucide-react';

import { useAuth } from '@/modules/auth';
import { api, readApiJson } from '@/shared/api';
import type { HubProject, StudioChatSpace, StudioConversation, StudioHomeTile, T212Status } from '@/shared/types';
import { useStudio } from '@/modules/studio/hooks/useStudio';
import { StudioConfirmSheet } from '@/modules/studio/StudioConfirmSheet';
import { StudioHomeScreen } from '@/modules/studio/StudioHomeScreen';
import { lazyStudioPanel } from '@/modules/studio/lazyStudioPanel';
import { StudioLinksSheet } from '@/modules/studio/StudioLinksSheet';
import '@/modules/studio/studio.css';

// Sub-apps stay out of the home screen's first load (and are warmed once it is idle); same props as the originals.
const StudioChatPane = lazyStudioPanel(() => import('@/modules/studio/StudioChatPane').then(module => module.StudioChatPane), 'chat');
const StudioConnections = lazyStudioPanel(() => import('@/modules/studio/StudioConnections').then(module => module.StudioConnections), 'list');
const StudioProjectAgents = lazyStudioPanel(() => import('@/modules/studio/StudioProjectAgents').then(module => module.StudioProjectAgents), 'list');
const StudioProjectEditor = lazyStudioPanel(() => import('@/modules/studio/StudioProjectEditor').then(module => module.StudioProjectEditor), 'form');
const StudioProjectMail = lazyStudioPanel(() => import('@/modules/studio/StudioProjectMail').then(module => module.StudioProjectMail), 'list');
const StudioProjectTasks = lazyStudioPanel(() => import('@/modules/studio/StudioProjectTasks').then(module => module.StudioProjectTasks), 'list');
const StudioSnrPanel = lazyStudioPanel(() => import('@/modules/studio/StudioSnrPanel').then(module => module.StudioSnrPanel), 'list');
const StudioTrading212 = lazyStudioPanel(() => import('@/modules/studio/StudioTrading212').then(module => module.StudioTrading212), 'dashboard');
// ── v6 track: github — lazy panel (kept apart from the other tracks' insertions) ──
const StudioGitHub = lazyStudioPanel(() => import('@/modules/studio/StudioGitHub').then(module => module.StudioGitHub), 'list');

// Layout/drag features load after first paint; plain animations work immediately.
const loadMotionFeatures = () => import('@/modules/studio/motionFeatures').then(module => module.default);
// iOS-like default spring (response ~0.5 s, no visible overshoot).
const SPRING = { type: 'spring', stiffness: 158, damping: 25 } as const;
// Durations match the zoom keyframes in studio.css.
const APP_OPEN_MS = 560;
const APP_CLOSE_MS = 420;
// Scrolling past the large title collapses it into the glass navigation bar.
const LARGE_TITLE_COLLAPSE_AT = 28;
const SYSTEM_TITLES = { deepseek: 'DeepSeek', connections: '设置', github: 'GitHub', memory: '记忆' } as const;
const isSystemApp = (value: string | undefined): value is keyof typeof SYSTEM_TITLES => Boolean(value && value in SYSTEM_TITLES);

type Target = { kind: 'project'; id: string } | { kind: 'app'; id: keyof typeof SYSTEM_TITLES } | null;
type Tab = { id: string; label: string };

// Integrations lead (SNR opens on its K-line lab), then AI, then housekeeping.
function projectTabs(project: HubProject): Tab[] {
  const tabs: Tab[] = [];
  if (project.modules.includes('snr-lab')) tabs.push({ id: 'snr-lab', label: 'K 线实验室' });
  if (project.modules.includes('trading212')) tabs.push({ id: 'trading212', label: '股票分析' });
  if (project.modules.includes('mail')) tabs.push({ id: 'mail', label: '邮箱' });
  if (project.modules.includes('agents')) tabs.push({ id: 'ai', label: 'AI 助手' });
  if (project.providers.includes('deepseek')) tabs.push({ id: 'chat', label: 'DeepSeek' });
  if (project.modules.includes('automations')) tabs.push({ id: 'automations', label: '自动化' });
  tabs.push({ id: 'settings', label: '设置' });
  return tabs;
}

/** Used by App for `/`, `/projects/:id` and `/apps/:app`: a home screen of product icons, each opening its own environment. */
export function StudioPage() {
  const params = useParams<{ id?: string; app?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const target: Target = params.id ? { kind: 'project', id: params.id }
    : isSystemApp(params.app) ? { kind: 'app', id: params.app } : null;
  const chatSpace: StudioChatSpace = target?.kind === 'project' ? `project:${target.id}` : 'deepseek';
  const studio = useStudio(chatSpace);
  const { logout } = useAuth();
  // The signed-in user's projects (home-screen icons); null while loading.
  const [projects, setProjects] = useState<HubProject[] | null>(null);
  // Project list failures are shown alongside Studio's own errors.
  const [projectsError, setProjectsError] = useState('');
  // Whether Trading 212 has a key file, for the tile's status line.
  const [t212, setT212] = useState<T212Status[] | null>(null);
  // Zoom phase: an app grows out of its icon and shrinks back into it.
  const [transition, setTransition] = useState<'opening' | 'closing' | null>(null);
  // Screen point of the tapped icon, used as the zoom's transform origin.
  const [origin, setOrigin] = useState<{ x: number; y: number; w: number; h: number; tone: string } | null>(null);
  // The website quick-browse sheet for the open project.
  const [linksOpen, setLinksOpen] = useState(false);
  // Phones push from the conversation list to a thread; wider layouts show both side by side.
  const [threadOpen, setThreadOpen] = useState(false);
  // The navigation bar turns into translucent glass once the large title scrolls away.
  const [compact, setCompact] = useState(false);
  // Manual refreshes show the progress line until every status request settles.
  const [refreshing, setRefreshing] = useState(false);
  // Deleting a conversation waits for an explicit confirmation in the alert.
  const [pendingDelete, setPendingDelete] = useState<StudioConversation | null>(null);
  // The new-project sheet opened from the home screen's + tile.
  const [creating, setCreating] = useState(false);
  // Deleting a project waits for an explicit confirmation in the alert.
  const [confirmProjectDelete, setConfirmProjectDelete] = useState(false);

  const loadProjects = useCallback(async () => {
    try { setProjects(await api.studio.projects.list().then(readApiJson<HubProject[]>)); setProjectsError(''); }
    catch (failure) { setProjects(previous => previous ?? []); setProjectsError(failure instanceof Error ? failure.message : '项目加载失败'); }
  }, []);
  const loadT212 = useCallback(async () => {
    setT212(await api.studio.trading212.status().then(readApiJson<T212Status[]>).catch(() => []));
  }, []);
  useEffect(() => { void loadProjects(); void loadT212(); }, [loadProjects, loadT212]);

  useEffect(() => {
    if (!transition) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(() => {
      if (transition === 'closing') {
        // Return along history when the app was opened from home, so Back never loops.
        if ((location.state as { fromHome?: boolean } | null)?.fromHome) navigate(-1); else navigate('/');
      }
      setTransition(null);
    }, reduced ? 0 : transition === 'opening' ? APP_OPEN_MS : APP_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [transition, navigate, location.state]);

  const signOut = () => { void api.studio.closeSnr().finally(logout).catch(() => {}); };
  const openTile = (tile: StudioHomeTile, icon: DOMRect | null) => {
    if (transition || tile.href) return;
    setOrigin(icon ? { x: icon.left, y: icon.top, w: icon.width, h: icon.height, tone: tile.tone } : null);
    setThreadOpen(false);
    setCompact(false);
    setTransition('opening');
    navigate(tile.id.startsWith('project:') ? `/projects/${encodeURIComponent(tile.id.slice(8))}` : `/apps/${tile.id}`, { state: { fromHome: true } });
  };
  // Home works even mid-zoom: the closing animation simply replaces the opening one.
  const goHome = () => { if (transition !== 'closing') setTransition('closing'); };
  const refresh = async () => {
    setRefreshing(true);
    try { await Promise.all([studio.refresh(), loadProjects(), loadT212()]); } finally { setRefreshing(false); }
  };
  const onScroll = (event: UIEvent<HTMLDivElement>) => setCompact(event.currentTarget.scrollTop > LARGE_TITLE_COLLAPSE_AT);

  const configured = Boolean(studio.status?.deepseek.configured);
  const snrOnline = Boolean(studio.snr?.connected);
  const t212Ready = t212 === null ? null : t212.some(item => item.configured);
  const project = target?.kind === 'project' ? projects?.find(item => item.id === target.id) ?? null : null;
  const tabs = project ? projectTabs(project) : [];
  const tab = tabs.find(item => item.id === searchParams.get('tab'))?.id ?? tabs[0]?.id;
  const setTab = (id: string) => { setThreadOpen(false); setCompact(false); setSearchParams({ tab: id }, { replace: true, state: location.state }); };
  const chatContext = (target?.kind === 'app' && target.id === 'deepseek') || (Boolean(project) && tab === 'chat');
  const title = target?.kind === 'app' ? SYSTEM_TITLES[target.id] : project?.name ?? (projects ? '项目不存在' : '');
  const navTitle = chatContext && (threadOpen || studio.active) ? studio.active?.title ?? '新对话' : title;
  const assistant = project ? `${project.name} · DeepSeek` : 'DeepSeek';
  const busy = studio.loading || refreshing || studio.sending;
  const error = studio.error || projectsError;

  const tiles: StudioHomeTile[] = [
    ...(projects ?? []).map(item => ({
      id: `project:${item.id}`, name: item.name, tone: item.tone, glyph: item.glyph,
      status: item.modules.includes('snr-lab') ? (studio.loading ? undefined : snrOnline ? '在线' : '离线')
        : item.modules.includes('trading212') && t212Ready === false ? '未接入' : undefined,
    })),
    // ── v6 track: github — home tile below this line ──
    { id: 'github', name: 'GitHub', tone: 'graphite', glyph: 'pull-request' },
    // ── v6 track: memory — home tile below this line ──
    { id: 'deepseek', name: 'DeepSeek', tone: 'slate', glyph: 'sparkles', status: studio.loading || configured ? undefined : '待配置' },
    { id: 'workspace', name: '工作台', tone: 'graphite', glyph: 'terminal', href: '/work' },
    { id: 'connections', name: '设置', tone: 'stone', glyph: 'settings', status: studio.loading || configured ? undefined : '1 项待配置' },
  ];
  // The app is revealed from the exact icon rectangle (clip-path, so content never distorts), like iOS; without an icon it fades and scales from centre.
  const appStyle = (origin ? {
    '--zoom-clip': `inset(${origin.y}px ${Math.max(0, window.innerWidth - origin.x - origin.w)}px ${Math.max(0, window.innerHeight - origin.y - origin.h)}px ${origin.x}px round ${origin.w * 0.23}px)`,
    '--zoom-cx': `${origin.x + origin.w / 2}px`, '--zoom-cy': `${origin.y + origin.h / 2}px`,
  } : {}) as CSSProperties;

  const projectContent = () => {
    if (!project) return null;
    if (tab === 'ai') return <StudioProjectAgents project={project} onOpenChat={() => setTab('chat')} />;
    if (tab === 'snr-lab') return <StudioSnrPanel snr={studio.snr} remoteUrl={studio.status?.snrRemoteUrl ?? null} />;
    if (tab === 'trading212') return <StudioTrading212 />;
    if (tab === 'mail') return <StudioProjectMail project={project} />;
    if (tab === 'automations') return <StudioProjectTasks project={project} />;
    return <StudioProjectEditor key={project.updatedAt} project={project}
      onSaved={saved => { setProjects(previous => previous?.map(item => item.id === saved.id ? saved : item) ?? [saved]); toast.success('已保存项目设置'); }}
      onDelete={() => setConfirmProjectDelete(true)} />;
  };

  return <LazyMotion features={loadMotionFeatures} strict><MotionConfig reducedMotion="user" transition={SPRING}>
  <div className="studio" data-thread={chatContext && threadOpen ? 'true' : 'false'} data-transition={transition ?? undefined}>
    <Toaster position="top-center" offset={18} toastOptions={{ className: 'studio-toast', duration: 2600 }} />
    {busy && <div className="studio-progress" role="progressbar" aria-label={studio.sending ? '正在回复' : '正在同步'} />}
    {error && <div className="studio-alert" role="alert"><span>{error}</span><button type="button" className="ios-button tinted" onClick={() => void refresh()}>重试</button></div>}

    {/* The home screen stays mounted under an open app so its entrance animation and edit state persist. */}
    <div className={`home-layer ${target && !transition ? 'is-covered' : ''}`} aria-hidden={target ? true : undefined}>
      <StudioHomeScreen tiles={tiles} loading={projects === null} covered={Boolean(target && !transition)} snr={studio.snr} onOpen={openTile} onCreate={() => setCreating(true)}
        onRefresh={() => void refresh()} onSignOut={signOut} refreshing={refreshing} />
    </div>

    {target && <div className={`studio-app ${transition ?? ''} ${origin ? `has-origin tone-${origin.tone}` : ''}`} style={appStyle} role="region" aria-label={title || '应用'}>
      <main className={`studio-main ${tabs.length ? 'has-tabs' : ''}`}>
        <header className="studio-navbar" data-compact={chatContext || tabs.length > 0 || compact ? 'true' : 'false'}>
          <div className="navbar-leading">
            {chatContext && threadOpen && <button type="button" className="navbar-back ios-press studio-phone-only" onClick={() => setThreadOpen(false)}><ChevronLeft size={26} aria-hidden="true" />{project ? 'DeepSeek' : '对话'}</button>}
            <button type="button" className={`navbar-back ios-press ${chatContext && threadOpen ? 'studio-wide-only' : ''}`} onClick={goHome} aria-label="返回主屏幕"><ChevronLeft size={26} aria-hidden="true" /><LayoutGrid size={18} aria-hidden="true" /></button>
          </div>
          <div className="navbar-title" aria-hidden={!(chatContext || tabs.length > 0 || compact)}>
            {navTitle}
            {chatContext && (threadOpen || studio.active) && <small>{assistant} · {studio.active?.model ?? '新建'}</small>}
          </div>
          <div className="navbar-trailing">
            <span className="studio-private"><ShieldCheck size={15} aria-hidden="true" />私有工作空间</span>
            {project && project.links.length > 0 && !chatContext && <button type="button" className="icon-button" aria-label="打开网站" title="网站" onClick={() => setLinksOpen(true)}><Globe size={20} aria-hidden="true" /></button>}
            {chatContext ? <>
              {studio.active && <button type="button" className="icon-button danger" aria-label="删除当前对话" title="删除当前对话" disabled={studio.sending} onClick={() => setPendingDelete(studio.active)}><Trash2 size={19} aria-hidden="true" /></button>}
              <button type="button" className="icon-button" aria-label="新建对话" title="新建对话" disabled={studio.sending} onClick={() => { studio.startNew(); setThreadOpen(true); }}><SquarePen size={21} aria-hidden="true" /></button>
            </> : !tabs.length && <button type="button" className={`icon-button ${refreshing ? 'refreshing' : ''}`} aria-label="刷新状态" title="刷新状态"
              disabled={studio.loading || refreshing} onClick={() => void refresh()}><RefreshCw size={19} className="refresh-icon" aria-hidden="true" /></button>}
          </div>
        </header>

        {tabs.length > 0 && <nav className="project-tabs" aria-label="项目功能">
          {tabs.map(item => <button type="button" key={item.id} className="project-tab" aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}>{item.label}</button>)}
        </nav>}

        {chatContext ? <StudioChatPane key={chatSpace} studio={studio} assistant={assistant} title={title}
          tone={project?.tone ?? 'slate'} glyph={project?.glyph ?? 'sparkles'}
          onOpenThread={() => setThreadOpen(true)} onDelete={setPendingDelete} />
          : <div className="studio-scroll" onScroll={onScroll}>
            <AnimatePresence mode="wait" initial={false}>
            <m.div className="studio-content" key={`${target.kind}:${target.id}:${tab ?? ''}`}
              initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8, transition: { duration: 0.14 } }}>
              {!tabs.length && <div className="studio-large-title"><h1>{title}</h1></div>}
              {target.kind === 'app' && target.id === 'connections' && <StudioConnections status={studio.status} onChange={studio.refresh} />}
              {/* ── v6 track: github — app content below this line ── */}
              {target.kind === 'app' && target.id === 'github' && <StudioGitHub refreshing={refreshing} />}
              {/* ── v6 track: memory — app content below this line ── */}
              {target.kind === 'project' && !project && (projects === null
                ? <div className="studio-skeleton" role="status" aria-label="正在加载项目"><div className="skeleton-block" style={{ height: 160 }} /></div>
                : <div className="ios-empty"><FolderX size={32} strokeWidth={1.5} aria-hidden="true" /><span>这个项目不存在或已被删除</span>
                  <button type="button" className="ios-button tinted" onClick={goHome}>返回主屏幕</button></div>)}
              {projectContent()}
            </m.div>
            </AnimatePresence>
          </div>}
      </main>
    </div>}

    {creating && createPortal(<div className="studio-layer" onKeyDown={event => { if (event.key === 'Escape') setCreating(false); }}>
      <div className="sheet-scrim" aria-hidden="true" onClick={() => setCreating(false)} />
      <div className="library-sheet project-sheet" role="dialog" aria-modal="true" aria-labelledby="studio-new-project-title">
        <div className="library-grabber" aria-hidden="true" />
        <header><h2 id="studio-new-project-title">新建项目</h2></header>
        <StudioProjectEditor onCancel={() => setCreating(false)} onSaved={saved => {
          setProjects(previous => [...(previous ?? []), saved]);
          setCreating(false);
          toast.success(`已创建「${saved.name}」`);
          setOrigin(null);
          setTransition('opening');
          navigate(`/projects/${encodeURIComponent(saved.id)}`, { state: { fromHome: true } });
        }} />
      </div>
    </div>, document.body)}

    {pendingDelete && <StudioConfirmSheet title="删除此对话？" message={`“${pendingDelete.title}”及全部消息将被删除，此操作无法撤销。`} confirmLabel="删除"
      onCancel={() => setPendingDelete(null)}
      onConfirm={() => {
        const conversation = pendingDelete;
        setPendingDelete(null);
        // Deleting the open thread on a phone returns to the list instead of an empty thread.
        if (conversation.id === studio.active?.id) setThreadOpen(false);
        void studio.remove(conversation.id);
      }} />}

    {confirmProjectDelete && project && <StudioConfirmSheet title={`删除「${project.name}」？`} message="项目设置、自动化草稿和 DeepSeek 对话会被删除；电脑上的文件和工作台会话不受影响。" confirmLabel="删除"
      onCancel={() => setConfirmProjectDelete(false)}
      onConfirm={() => {
        const removed = project;
        setConfirmProjectDelete(false);
        void api.studio.projects.remove(removed.id).then(readApiJson).then(() => {
          setProjects(previous => previous?.filter(item => item.id !== removed.id) ?? []);
          navigate('/', { replace: true });
          toast(`已删除「${removed.name}」`);
        }).catch(failure => setProjectsError(failure instanceof Error ? failure.message : '删除失败'));
      }} />}

    {linksOpen && project && <StudioLinksSheet project={project} onClose={() => setLinksOpen(false)} />}
  </div>
  </MotionConfig></LazyMotion>;
}
