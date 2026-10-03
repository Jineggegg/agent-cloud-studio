import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties, UIEvent } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AnimatePresence, LazyMotion, MotionConfig, m } from 'motion/react';
import { Toaster, toast } from 'sonner';

import { IconChevronLeft, IconEdit, IconFolderX, IconLayoutGrid, IconRefresh, IconShieldCheck, IconTrash, IconWorld } from '@/modules/studio/icons/tabler';
import { useAuth } from '@/modules/auth';
import { api, readApiJson } from '@/shared/api';
import type { HubProject, StudioBuildCreated, StudioChatSpace, StudioConversation, StudioHomeTile, T212Status } from '@/shared/types';
import { STUDIO_AJ_EXIT_TILE_ID, STUDIO_MOTION_IN_MS, STUDIO_MOTION_OUT_MS } from '@/shared/constants';
import { reloadIfNewBuild } from '@/shared/hooks/useFrontendUpdateWatcher';
import { applyModelDefaults } from '@/shared/modelDefaults';
import { writeSelectedProvider } from '@/shared/selectedProvider';
import { useStudio } from '@/modules/studio/hooks/useStudio';
import { useStudioBuilds } from '@/modules/studio/hooks/useStudioBuilds';
import { useRefreshSpin } from '@/modules/studio/hooks/useRefreshSpin';
import { StudioConfirmSheet } from '@/modules/studio/StudioConfirmSheet';
import { StudioCreateSheet } from '@/modules/studio/StudioCreateSheet';
import { StudioHomeScreen } from '@/modules/studio/StudioHomeScreen';
import { lazyStudioPanel } from '@/modules/studio/lazyStudioPanel';
import { StudioPanelPending } from '@/modules/studio/StudioPanelFallback';
import { StudioLinksSheet } from '@/modules/studio/StudioLinksSheet';
import { SETTINGS_PAGES, readSettingsPage, useSettingsSplit } from '@/modules/studio/settingsPages';
import type { SettingsPageId } from '@/modules/studio/settingsPages';
import type { WidgetType } from '@/modules/studio/StudioWidgets';
import '@/modules/studio/studio.css';

// Sub-apps stay out of the home screen's first load (and are warmed once it is idle); same props as the originals.
const StudioChatPane = lazyStudioPanel(() => import('@/modules/studio/StudioChatPane').then(module => module.StudioChatPane), 'chat');
const StudioBuildComposer = lazyStudioPanel(() => import('@/modules/studio/StudioBuildComposer').then(module => module.StudioBuildComposer), 'form');
const StudioConnections = lazyStudioPanel(() => import('@/modules/studio/StudioConnections').then(module => module.StudioConnections), 'list');
const StudioMemory = lazyStudioPanel(() => import('@/modules/studio/StudioMemory').then(module => module.StudioMemory), 'list');
const StudioProjectAgents = lazyStudioPanel(() => import('@/modules/studio/StudioProjectAgents').then(module => module.StudioProjectAgents), 'list');
const StudioProjectEditor = lazyStudioPanel(() => import('@/modules/studio/StudioProjectEditor').then(module => module.StudioProjectEditor), 'form');
const StudioProjectMail = lazyStudioPanel(() => import('@/modules/studio/StudioProjectMail').then(module => module.StudioProjectMail), 'list');
const StudioProjectTasks = lazyStudioPanel(() => import('@/modules/studio/StudioProjectTasks').then(module => module.StudioProjectTasks), 'list');
const StudioSnrPanel = lazyStudioPanel(() => import('@/modules/studio/StudioSnrPanel').then(module => module.StudioSnrPanel), 'list');
const StudioTrading212 = lazyStudioPanel(() => import('@/modules/studio/StudioTrading212').then(module => module.StudioTrading212), 'dashboard');
const StudioAppHome = lazyStudioPanel(() => import('@/modules/studio/StudioAppHome').then(module => module.StudioAppHome), 'dashboard');
const StudioAppRunSettings = lazyStudioPanel(() => import('@/modules/studio/StudioAppHome').then(module => module.StudioAppRunSettings), 'list');
// ── v6 track: github — lazy panel (kept apart from the other tracks' insertions) ──
const StudioGitHub = lazyStudioPanel(() => import('@/modules/studio/StudioGitHub').then(module => module.StudioGitHub), 'list');

// Layout/drag features load after first paint; plain animations work immediately.
const loadMotionFeatures = () => import('@/modules/studio/motionFeatures').then(module => module.default);
// iOS-like default spring (response ~0.5 s, no visible overshoot).
const SPRING = { type: 'spring', stiffness: 158, damping: 25 } as const;
// Scrolling past the large title collapses it into the glass navigation bar.
const LARGE_TITLE_COLLAPSE_AT = 28;
const SYSTEM_TITLES = { deepseek: 'DeepSeek', connections: '设置', github: 'GitHub', memory: '记忆' } as const;
const isSystemApp = (value: string | undefined): value is keyof typeof SYSTEM_TITLES => Boolean(value && value in SYSTEM_TITLES);
// Studio's settings app, also opened by the home screen's gear (zooming out of the button).
const SETTINGS_TILE: StudioHomeTile = { id: 'connections', name: '设置', tone: 'stone', glyph: 'settings' };
const prefersReducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

type Target = { kind: 'project'; id: string } | { kind: 'app'; id: keyof typeof SYSTEM_TITLES } | null;
type Tab = { id: string; label: string };
// History state of an app's entries. `fromHome`: the entry behind the app's root is the home screen. `appTrail`: the
// app's earlier views behind this entry (tab ids, or `chat`), nearest last. Every in-app step (a tab, 全部, a DeepSeek conversation) is
// pushed with one more, and replace navigations keep the state, so the trail always matches the entries behind it:
// the top-left back walks it with history, like a UINavigationController, and leaves the app only from its root.
type AppEntryState = { fromHome?: boolean; appTrail?: string[] } | null;

// Integrations lead (SNR opens on its K-line lab), then AI, then housekeeping. An app Studio's AI built opens on
// 主页 (the app itself) and calls its AI tab AI 工坊: the workshop where the owner and the AI keep improving it.
function projectTabs(project: HubProject, isApp: boolean): Tab[] {
  const tabs: Tab[] = [];
  if (isApp) tabs.push({ id: 'app', label: '主页' });
  if (project.modules.includes('snr-lab')) tabs.push({ id: 'snr-lab', label: 'K 线实验室' });
  if (project.modules.includes('trading212')) tabs.push({ id: 'trading212', label: '股票分析' });
  if (project.modules.includes('mail')) tabs.push({ id: 'mail', label: '邮箱' });
  // One AI 助手 tab for Claude Code, Codex and DeepSeek; the project's DeepSeek chat (`chat`) opens from inside it.
  if (project.modules.includes('agents') || project.providers.includes('deepseek')) tabs.push({ id: 'ai', label: isApp ? 'AI 工坊' : 'AI 助手' });
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
  // Opening and closing an app: the timed zooms in studio.css (the whole view grows from, or shrinks back into, the
  // tapped icon while the home screen recedes or returns); null once it has settled.
  const [transition, setTransition] = useState<'opening' | 'closing' | null>(null);
  // Centre of the tapped icon (or widget card, or gear): the app zooms out of it and back into it.
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  // The website quick-browse sheet for the open project.
  const [linksOpen, setLinksOpen] = useState(false);
  // Phones push from the conversation list to a thread; wider layouts show both side by side.
  const [threadOpen, setThreadOpen] = useState(false);
  // The navigation bar turns into translucent glass once the large title scrolls away.
  const [compact, setCompact] = useState(false);
  // Manual refreshes spin the refresh icon (whole turns) and show the progress line until every status request settles.
  const refreshSpin = useRefreshSpin();
  const refreshing = refreshSpin.spinning;
  // Deleting a conversation waits for an explicit confirmation in the alert.
  const [pendingDelete, setPendingDelete] = useState<StudioConversation | null>(null);
  // The new-project sheet opened from the home screen's + tile.
  const [creating, setCreating] = useState(false);
  // Deleting a project waits for an explicit confirmation in the alert.
  const [confirmProjectDelete, setConfirmProjectDelete] = useState(false);
  // AI builds: progress rings on project icons, polled only while one is running.
  const builds = useStudioBuilds(projects);
  // Settings show their list beside the chosen page on a wide screen, one screen at a time on a phone.
  const settingsSplit = useSettingsSplit();

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
    const reduced = prefersReducedMotion();
    const timer = window.setTimeout(() => {
      if (transition === 'closing') {
        // Return along history when the app was opened from home, so Back never loops.
        if ((location.state as AppEntryState)?.fromHome) navigate(-1); else navigate('/');
      }
      setTransition(null);
    }, reduced ? 0 : transition === 'opening' ? STUDIO_MOTION_IN_MS : STUDIO_MOTION_OUT_MS);
    return () => window.clearTimeout(timer);
  }, [transition, navigate, location.state]);

  const signOut = () => { void api.studio.closeSnr().finally(logout).catch(() => {}); };
  // An app opens from what was tapped (an icon, a widget card or the gear): the whole view fades in as it grows a
  // little from there, like iPadOS, while the home screen recedes behind it. Without a box it grows from the centre;
  // under reduced motion it simply appears.
  const openTile = (tile: StudioHomeTile, icon: DOMRect | null) => {
    if (transition || tile.href) return;
    setOrigin(icon ? { x: icon.left + icon.width / 2, y: icon.top + icon.height / 2 } : null);
    setThreadOpen(false);
    setCompact(false);
    setTransition(prefersReducedMotion() ? null : 'opening');
    navigate(tile.id.startsWith('project:') ? `/projects/${encodeURIComponent(tile.id.slice(8))}` : `/apps/${tile.id}`, { state: { fromHome: true } });
  };
  // A widget opens the app it summarises. Claude and Codex start a new session in the workbench directory with the
  // model and effort chosen in settings; the others open their app from the card's centre, like an icon.
  const openWidget = async (type: WidgetType, card: DOMRect) => {
    if (transition) return;
    if (type === 'claude' || type === 'codex') {
      try {
        const { url } = await api.studio.projects.launchWorkbench(type).then(readApiJson<{ url: string }>);
        applyModelDefaults(type);
        writeSelectedProvider(type);
        navigate(url);
      } catch (failure) { toast.error(failure instanceof Error ? failure.message : '无法打开工作台'); }
      return;
    }
    if (type === 'deepseek') { openTile({ id: 'deepseek', name: 'DeepSeek', tone: 'slate', glyph: 'sparkles' }, card); return; }
    // The GitHub widget opens the PR inbox system app, from the card like its home tile.
    if (type === 'github') { openTile({ id: 'github', name: 'GitHub', tone: 'graphite', glyph: 'pull-request' }, card); return; }
    const module = type === 'trading212' ? 'trading212' : 'snr-lab';
    const found = projects?.find(item => item.modules.includes(module));
    if (!found) { toast.error(type === 'trading212' ? '没有启用股票分析的项目' : '没有启用 K 线实验室的项目'); return; }
    openTile({ id: `project:${found.id}`, name: found.name, tone: found.tone, glyph: found.glyph }, card);
  };
  // Home works even mid-zoom: the closing animation simply replaces the opening one.
  const goHome = () => { if (transition !== 'closing') setTransition('closing'); };
  // An AI build lands on the home screen at once as a dimmed icon; the sheet closes and nothing zooms open.
  const startBuild = ({ build, project: created }: StudioBuildCreated) => {
    setProjects(previous => [...(previous ?? []), created]);
    builds.track(build);
    setCreating(false);
    toast(`「${created.name}」开始开发`, { description: '完成后图标会亮起；随时点开图标就能看它在做什么。' });
  };
  const refresh = async () => {
    await refreshSpin.run(async () => {
      // A newer deploy is loaded right away (the page reloads), so the button also updates the app itself.
      if (await reloadIfNewBuild()) return;
      await Promise.all([studio.refresh(), loadProjects(), loadT212()]);
    });
  };
  const onScroll = (event: UIEvent<HTMLDivElement>) => setCompact(event.currentTarget.scrollTop > LARGE_TITLE_COLLAPSE_AT);

  const configured = Boolean(studio.status?.deepseek.configured);
  const snrOnline = Boolean(studio.snr?.connected);
  const t212Ready = t212 === null ? null : t212.some(item => item.configured);
  const project = target?.kind === 'project' ? projects?.find(item => item.id === target.id) ?? null : null;
  // The build that made this project, when Studio's AI made it: the project is then an app with a 主页.
  const appBuild = project ? builds.buildFor(project.id) : null;
  const tabs = project ? projectTabs(project, Boolean(appBuild)) : [];
  // `chat` is AI 助手's own DeepSeek conversation view, used where the workbench cannot run (no local directory).
  const tab = searchParams.get('tab') === 'chat' && project?.providers.includes('deepseek') ? 'chat'
    : tabs.find(item => item.id === searchParams.get('tab'))?.id ?? tabs[0]?.id;
  const appTrail = (location.state as AppEntryState)?.appTrail ?? [];
  // Opening another view of the app (a tab, 全部, a DeepSeek conversation) is a step the top-left back returns from.
  // Going to the view just behind is that step back, so switching between two tabs never piles up history.
  const setTab = (id: string) => {
    setThreadOpen(false);
    setCompact(false);
    if (id === tab) return;
    if (appTrail.at(-1) === id) { navigate(-1); return; }
    navigate({ search: `?tab=${encodeURIComponent(id)}` }, { state: { appTrail: [...appTrail, tab ?? ''] } });
  };
  const chatContext = (target?.kind === 'app' && target.id === 'deepseek') || (Boolean(project) && tab === 'chat');
  // An app's 主页 fills the page under the chrome with the app and its AI sidebar, scrolling inside the app.
  const appHome = Boolean(project && appBuild) && tab === 'app';
  // Settings: the page in the URL (?tab=<page>), and whether the list and the page sit side by side.
  const settingsOpen = target?.kind === 'app' && target.id === 'connections';
  const settingsPage = settingsOpen ? readSettingsPage(searchParams.get('tab'), location.hash) : null;
  const settingsParent = settingsPage ? SETTINGS_PAGES[settingsPage].parent ?? null : null;
  // A phone shows one settings screen at a time; its navigation bar then leads back up a level, not home.
  const settingsPushed = settingsOpen && !settingsSplit && settingsPage !== null;
  const openSettingsPage = (page: SettingsPageId | null) => {
    setCompact(false);
    setSearchParams(page ? { tab: page } : {}, { replace: true, state: location.state });
  };
  const title = target?.kind === 'app' ? SYSTEM_TITLES[target.id] : project?.name ?? (projects ? '项目不存在' : '');
  // The app's root is its first tab: the top-left back leaves for the home screen only from there. A deeper view
  // reached without history (a deep link, a reload in a new tab) steps back to the root first.
  const rootTab = tabs[0]?.id;
  const atAppRoot = !project || tab === rootTab;
  const backView = appTrail.at(-1) ?? (atAppRoot ? null : rootTab ?? null);
  // The project's DeepSeek chat lives under AI 助手, so a step back into it is named after that tab. While the
  // project still loads, a step back is only a step back.
  const backLabel = backView === null ? null : tabs.find(item => item.id === (backView === 'chat' ? 'ai' : backView))?.label ?? '上一页';
  const goBack = () => {
    setThreadOpen(false);
    setCompact(false);
    if (appTrail.length) navigate(-1);
    else if (!atAppRoot) navigate({ pathname: location.pathname, search: '' }, { replace: true, state: location.state });
    else goHome();
  };
  const navTitle = chatContext && (threadOpen || studio.active) ? studio.active?.title ?? '新对话'
    : settingsPushed && settingsPage ? SETTINGS_PAGES[settingsPage].title : title;
  const assistant = project ? `${project.name} · DeepSeek` : 'DeepSeek';
  const busy = studio.loading || refreshing || studio.sending;
  const error = studio.error || projectsError;

  const tiles: StudioHomeTile[] = [
    ...(projects ?? []).map(item => ({
      id: `project:${item.id}`, name: item.name, tone: item.tone, glyph: item.glyph,
      status: item.modules.includes('snr-lab') ? (studio.loading ? undefined : snrOnline ? '在线' : '离线')
        : item.modules.includes('trading212') && t212Ready === false ? '未接入' : undefined,
      // An AI build in progress dims the icon under a ring and links it to the live workbench session.
      ...builds.tileFor(item.id),
    })),
    // ── v6 track: github — home tile below this line ──
    { id: 'github', name: 'GitHub', tone: 'graphite', glyph: 'pull-request' },
    // ── v6 track: memory — home tile below this line ──
    // The shared memory of Claude Code, Codex and DeepSeek: a notebook, in warm paper.
    { id: 'memory', name: '记忆', tone: 'sand', glyph: 'book' },
    // Switches this device's traffic to the Tailscale exit node on AJ's server; the home screen runs it (useAjExit).
    { id: STUDIO_AJ_EXIT_TILE_ID, name: 'AJ 出口', tone: 'ink', glyph: 'globe' },
    { id: 'deepseek', name: 'DeepSeek', tone: 'slate', glyph: 'sparkles', status: studio.loading || configured ? undefined : '待配置' },
    { id: 'workspace', name: '工作台', tone: 'graphite', glyph: 'terminal', href: '/work' },
    { ...SETTINGS_TILE, status: studio.loading || configured ? undefined : '1 项待配置' },
  ];
  // The app zooms about the tapped icon's centre, so it grows out of the icon and shrinks back towards it.
  const appStyle = (origin ? { '--zoom-cx': `${origin.x}px`, '--zoom-cy': `${origin.y}px` } : {}) as CSSProperties;

  const projectContent = () => {
    if (!project) return null;
    if (tab === 'ai') return <StudioProjectAgents project={project} onOpenChat={conversationId => openProjectChat(conversationId)} />;
    if (tab === 'snr-lab') return <StudioSnrPanel snr={studio.snr} remoteUrl={studio.status?.snrRemoteUrl ?? null} />;
    if (tab === 'trading212') return <StudioTrading212 />;
    if (tab === 'mail') return <StudioProjectMail project={project} />;
    if (tab === 'automations') return <StudioProjectTasks project={project} />;
    const editor = <StudioProjectEditor key={project.updatedAt} project={project}
      onSaved={saved => { setProjects(previous => previous?.map(item => item.id === saved.id ? saved : item) ?? [saved]); toast.success('已保存项目设置'); }}
      onDelete={() => setConfirmProjectDelete(true)} />;
    // An app's settings lead with whether it is running.
    return appBuild ? <><StudioAppRunSettings project={project} />{editor}</> : editor;
  };
  // Opens the project's DeepSeek chat (a new conversation, or `conversationId`) from AI 助手 / AI 工坊 or the 主页.
  const openProjectChat = (conversationId?: string) => {
    setTab('chat');
    if (conversationId) { void studio.select(conversationId); setThreadOpen(true); }
  };

  return <LazyMotion features={loadMotionFeatures} strict><MotionConfig reducedMotion="user" transition={SPRING}>
  <div className="studio" data-thread={chatContext && threadOpen ? 'true' : 'false'} data-transition={transition ?? undefined}>
    <Toaster position="top-center" offset={18} toastOptions={{ className: 'studio-toast', duration: 2600 }} />
    {busy && <div className="studio-progress" role="progressbar" aria-label={studio.sending ? '正在回复' : '正在同步'} />}
    {error && <div className="studio-alert" role="alert"><span>{error}</span><button type="button" className="ios-button tinted" onClick={() => void refresh()}>重试</button></div>}

    {/* The home screen stays mounted under an open app so its entrance animation and edit state persist. */}
    <div className={`home-layer ${target && !transition ? 'is-covered' : ''}`} aria-hidden={target ? true : undefined}>
      <StudioHomeScreen tiles={tiles} loading={projects === null} covered={Boolean(target && !transition)} snr={studio.snr} onOpen={openTile} onOpenWidget={(type, card) => void openWidget(type, card)}
        onOpenSettings={gear => openTile(SETTINGS_TILE, gear)} onCreate={() => setCreating(true)}
        onRefresh={() => void refresh()} onSignOut={signOut} refreshing={refreshing} onBuildAction={(tile, action) => builds.act(tile.id.slice(8), action)} />
    </div>

    {target && <div className={`studio-app ${transition ?? ''}`} style={appStyle} role="region" aria-label={title || '应用'}>
      <main className={`studio-main ${tabs.length ? 'has-tabs' : ''}`}>
        <header className="studio-navbar" data-compact={chatContext || tabs.length > 0 || compact || (settingsOpen && settingsSplit) ? 'true' : 'false'}>
          <div className="navbar-leading">
            {chatContext && threadOpen && <button type="button" className="navbar-back ios-press studio-phone-only" onClick={() => setThreadOpen(false)}><IconChevronLeft size={26} aria-hidden="true" />{project ? 'DeepSeek' : '对话'}</button>}
            {settingsPushed ? <button type="button" className="navbar-back ios-press" onClick={() => openSettingsPage(settingsParent)}>
              <IconChevronLeft size={26} aria-hidden="true" />{settingsParent ? SETTINGS_PAGES[settingsParent].title : '设置'}</button>
              : backLabel ? <button type="button" className={`navbar-back ios-press ${chatContext && threadOpen ? 'studio-wide-only' : ''}`} onClick={goBack} aria-label={`返回 ${backLabel}`}>
                <IconChevronLeft size={26} aria-hidden="true" />{backLabel}</button>
              : <button type="button" className={`navbar-back ios-press ${chatContext && threadOpen ? 'studio-wide-only' : ''}`} onClick={goBack} aria-label="返回主屏幕"><IconChevronLeft size={26} aria-hidden="true" /><IconLayoutGrid size={18} aria-hidden="true" /></button>}
          </div>
          <div className="navbar-title" aria-hidden={!(chatContext || tabs.length > 0 || compact || (settingsOpen && settingsSplit))}>
            {navTitle}
            {chatContext && (threadOpen || studio.active) && <small>{assistant} · {studio.active?.model ?? '新建'}</small>}
          </div>
          <div className="navbar-trailing">
            <span className="studio-private"><IconShieldCheck size={15} aria-hidden="true" />私有工作空间</span>
            {project && project.links.length > 0 && !chatContext && <button type="button" className="icon-button" aria-label="打开网站" title="网站" onClick={() => setLinksOpen(true)}><IconWorld size={20} aria-hidden="true" /></button>}
            {chatContext ? <>
              {studio.active && <button type="button" className="icon-button danger" aria-label="删除当前对话" title="删除当前对话" disabled={studio.sending} onClick={() => setPendingDelete(studio.active)}><IconTrash size={19} aria-hidden="true" /></button>}
              <button type="button" className="icon-button" aria-label="新建对话" title="新建对话" disabled={studio.sending} onClick={() => { studio.startNew(); setThreadOpen(true); }}><IconEdit size={21} aria-hidden="true" /></button>
            </> : !tabs.length && <button type="button" className={`icon-button ${refreshing ? 'refreshing' : ''}`} aria-label="刷新状态" title="刷新状态"
              disabled={studio.loading || refreshing} onClick={() => void refresh()}><IconRefresh size={19} className="refresh-icon" aria-hidden="true" /></button>}
          </div>
        </header>

        {tabs.length > 0 && <nav className="project-tabs" aria-label="项目功能">
          {tabs.map(item => <button type="button" key={item.id} className="project-tab" aria-current={tab === item.id || (tab === 'chat' && item.id === 'ai') ? 'page' : undefined} onClick={() => setTab(item.id)}>{item.label}</button>)}
        </nav>}

        {chatContext ? <StudioChatPane key={chatSpace} studio={studio} assistant={assistant} title={title}
          tone={project?.tone ?? 'slate'} glyph={project?.glyph ?? 'sparkles'}
          onOpenThread={() => setThreadOpen(true)} onDelete={setPendingDelete} />
          // Settings lay out their own list and pages, each with its own scrolling.
          : settingsOpen ? <StudioConnections status={studio.status} onChange={studio.refresh} page={settingsPage} split={settingsSplit}
            onNavigate={openSettingsPage} onScroll={onScroll} onSignOut={signOut} />
          : appHome && project && appBuild ? <StudioAppHome key={project.id} project={project} build={appBuild}
            progress={builds.tileFor(project.id).progress} workbenchUrl={builds.tileFor(project.id).href ?? null}
            onChange={message => builds.change(project.id, message)} onContinue={() => builds.act(project.id, 'resume')}
            onOpenChat={openProjectChat} onShowSessions={() => setTab('ai')} />
          : <div className="studio-scroll" onScroll={onScroll}>
            <AnimatePresence mode="wait" initial={false}>
            <m.div className="studio-content" key={`${target.kind}:${target.id}:${tab ?? ''}`}
              initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8, transition: { duration: 0.14 } }}>
              {!tabs.length && <div className="studio-large-title"><h1>{title}</h1></div>}
              {/* ── v6 track: github — app content below this line ── */}
              {target.kind === 'app' && target.id === 'github' && <StudioGitHub refreshing={refreshing} />}
              {/* ── v6 track: memory — app content below this line ── */}
              {target.kind === 'app' && target.id === 'memory' && <StudioMemory refreshing={refreshing} />}
              {/* While the project list loads, the activity indicator stands in. */}
              {target.kind === 'project' && !project && (projects === null
                ? <StudioPanelPending />
                : <div className="ios-empty"><IconFolderX size={32} strokeWidth={1.5} aria-hidden="true" /><span>这个项目不存在或已被删除</span>
                  <button type="button" className="ios-button tinted" onClick={goHome}>返回主屏幕</button></div>)}
              {projectContent()}
            </m.div>
            </AnimatePresence>
          </div>}
      </main>
    </div>}

    {creating && <StudioCreateSheet onClose={() => setCreating(false)}
      build={<StudioBuildComposer onCancel={() => setCreating(false)} onStarted={startBuild} />}
      manual={<StudioProjectEditor onCancel={() => setCreating(false)} onSaved={saved => {
        setProjects(previous => [...(previous ?? []), saved]);
        setCreating(false);
        toast.success(`已创建「${saved.name}」`);
        setOrigin(null);
        setTransition(prefersReducedMotion() ? null : 'opening');
        navigate(`/projects/${encodeURIComponent(saved.id)}`, { state: { fromHome: true } });
      }} />} />}

    {builds.pendingStop && <StudioConfirmSheet title={`停止开发「${builds.pendingStop.name}」？`}
      message="Claude Code 会立刻停下，已经写好的文件都会保留。之后可以在编辑主屏幕时继续开发。" confirmLabel="停止"
      onCancel={builds.cancelStop} onConfirm={() => void builds.confirmStop()} />}

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
