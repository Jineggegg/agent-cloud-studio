import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AnimatePresence, m } from 'motion/react';
import { toast } from 'sonner';
import { FileCode2, FolderSearch, FolderX, GitBranch, Globe, LayoutGrid, MessageSquareOff, PanelLeft, PanelRight, SquareTerminal } from 'lucide-react';
import type { LucideProps } from 'lucide-react';

import { usePaletteOpsRegister } from '@/modules/command-palette';
import { useEditorSidebar } from '@/modules/code-editor';
import { StudioConfirmSheet } from '@/modules/studio';
import { WORKBENCH_DOCK_TWEEN, WORKBENCH_PANEL_SPRING } from '@/shared/constants';
import { useBusySessionIdSet } from '@/shared/context/SessionProtectionContext';
import { useFileOpenResolver } from '@/shared/hooks/useFileOpenResolver';
import { useVisualViewportKeyboardOffset } from '@/shared/hooks/useVisualViewportKeyboardOffset';
import { writeSelectedProvider } from '@/shared/selectedProvider';
import type {
  DirectoryRevealRequest, FileOpenHandler, Project, WorkbenchChatChrome, WorkbenchInspectorTab, WorkbenchNewProvider, WorkbenchSessionItem,
} from '@/shared/types';
import { getPageTitle } from '@/shared/utils';
import { WorkbenchChat } from '@/modules/workbench/chat/WorkbenchChat';
import { WorkbenchChatBoundary } from '@/modules/workbench/WorkbenchChatBoundary';
import { WorkbenchInspector } from '@/modules/workbench/WorkbenchInspector';
import { WorkbenchProviderMark } from '@/modules/workbench/WorkbenchProviderMark';
import { WorkbenchSidebar } from '@/modules/workbench/WorkbenchSidebar';
import { useWorkbenchLayout } from '@/modules/workbench/hooks/useWorkbenchLayout';
import { useWorkbenchProjects } from '@/modules/workbench/hooks/useWorkbenchProjects';
import { useWorkbenchQuota } from '@/modules/workbench/hooks/useWorkbenchQuota';
import { useWorkbenchSessions } from '@/modules/workbench/hooks/useWorkbenchSessions';
import { useWorkbenchShortcuts } from '@/modules/workbench/hooks/useWorkbenchShortcuts';
import { useWorkbenchViewport } from '@/modules/workbench/hooks/useWorkbenchViewport';
import {
  fetchAgentSession, fetchDeepSeekConversation, newChatChoices, parseNewProvider, providerMeta, resolveLegacySessionPath,
  resolveNewChatProvider, workbenchPath,
} from '@/modules/workbench/utils/workbenchRoutes';

// Remembered on this device: the project /work opens and the agent a new chat starts with.
const LAST_PROJECT_KEY = 'acs-workbench-last-project';
const LAST_PROVIDER_KEY = 'acs-workbench-last-provider';
const SIDEBAR_WIDTH = 288;
const TOOL_ICONS: { id: WorkbenchInspectorTab; label: string; icon: ComponentType<LucideProps> }[] = [
  { id: 'files', label: '文件', icon: FileCode2 },
  { id: 'terminal', label: '终端', icon: SquareTerminal },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'preview', label: '预览', icon: Globe },
];

function readStored(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStored(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: the choice lasts this visit */ }
}

// ⌘ on Apple keyboards, Ctrl elsewhere; devices without a precise pointer (no keyboard in practice) get no hints.
function shortcutModifier(): string | null {
  if (typeof window === 'undefined' || !window.matchMedia?.('(any-pointer: fine)').matches) return null;
  return /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
}

// The chat column's placeholder while a session resolves: the shape of a transcript, not a spinner.
function ChatSkeleton() {
  return <div className="wb-chat-skeleton" role="status" aria-label="正在打开会话">
    <span className="skeleton-block is-user" />
    <span className="skeleton-block" />
    <span className="skeleton-block is-long" />
    <span className="skeleton-block is-user" />
  </div>;
}

/**
 * Used by WorkbenchRoute as the workbench itself: the project's history on the left (a sheet on phones), the chat
 * in the centre and the inspector on the right, driven by the /work URLs. It resolves the URL to a project and a
 * session, keeps the chat mounted while a new chat becomes a session, and owns the keyboard shortcuts.
 */
export function WorkbenchShell() {
  const params = useParams<{ projectId?: string; sessionId?: string; conversationId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const viewport = useWorkbenchViewport();
  const { entries, error: projectsError, refresh: refreshProjects } = useWorkbenchProjects();
  const quota = useWorkbenchQuota();
  const { layout, toggleSidebar, setSidebarCollapsed, toggleInspector, closeInspector, showInspectorTab, setInspectorWidth } = useWorkbenchLayout();
  const busy = useBusySessionIdSet();
  const searchRef = useRef<HTMLInputElement>(null);
  const modifier = useMemo(() => shortcutModifier(), []);
  // iOS Safari keeps the layout viewport under the soft keyboard; the root follows the visible area instead.
  useVisualViewportKeyboardOffset();

  const projectId = params.projectId ?? null;
  const target = params.sessionId ? { kind: 'agent' as const, id: params.sessionId }
    : params.conversationId ? { kind: 'deepseek' as const, id: params.conversationId } : null;
  const targetKey = target ? `${target.kind}:${target.id}` : '';
  const current = entries?.find(entry => entry.project.projectId === projectId) ?? null;
  const project = current?.project ?? null;
  const hubProjectId = current?.hub?.id ?? null;
  const sessions = useWorkbenchSessions(project?.projectId ?? null, hubProjectId);
  const { upsert, rename, archive, restore, remove, reload: reloadSessions, loadMore } = sessions;

  // The history's search text.
  const [query, setQuery] = useState('');
  // The phone's history sheet.
  const [sheetOpen, setSheetOpen] = useState(false);
  // The agent a new chat starts with when the URL names none; remembered on this device.
  const [lastProvider, setLastProvider] = useState<WorkbenchNewProvider>(() => parseNewProvider(readStored(LAST_PROVIDER_KEY)) ?? 'claude');
  // Bumped by every explicit new chat, so the chat column starts fresh even when the URL stays the same.
  const [chatEpoch, setChatEpoch] = useState(0);
  // The session the current new chat turned into: the same chat stays mounted while its URL changes.
  const [adoptedId, setAdoptedId] = useState<string | null>(null);
  // A session opened by URL that the loaded history does not contain (a deep link or an older page).
  const [fetched, setFetched] = useState<{ key: string; item: WorkbenchSessionItem | null } | null>(null);
  // The row waiting for the delete confirmation.
  const [pendingDelete, setPendingDelete] = useState<WorkbenchSessionItem | null>(null);
  // A folder a chat link asked the file tree to reveal; an object so the same folder can be asked for twice.
  const [revealDirectory, setRevealDirectory] = useState<DirectoryRevealRequest | null>(null);

  // Running sessions (GET /api/providers/sessions/running plus live chat frames) breathe in the history.
  const historyItems = useMemo(
    () => sessions.items?.map(item => (busy.has(item.id) ? { ...item, running: true } : item)) ?? null,
    [sessions.items, busy],
  );
  const listed = target && historyItems ? historyItems.find(item => item.kind === target.kind && item.id === target.id) ?? null : null;
  const historyLoaded = historyItems !== null;

  // A URL session outside the loaded history is looked up once per project; a provider-native id is corrected to
  // the app id. The project is part of the key: a session found in another project is looked up again there.
  const targetKind = target?.kind ?? null;
  const targetId = target?.id ?? null;
  const fetchKey = target && project ? `${project.projectId}|${targetKey}` : '';
  const isListed = Boolean(listed);
  useEffect(() => {
    if (!targetKind || !targetId || isListed || !historyLoaded || !project || fetched?.key === fetchKey) return undefined;
    let alive = true;
    const lookup: Promise<WorkbenchSessionItem | null | 'moved'> = targetKind === 'agent'
      ? fetchAgentSession(targetId).then(resolved => {
        if (!resolved) return null;
        if (resolved.projectId && resolved.projectId !== project.projectId) {
          navigate(workbenchPath(resolved.projectId, resolved.item), { replace: true });
          return 'moved' as const;
        }
        if (resolved.item.id !== targetId) navigate(workbenchPath(project.projectId, resolved.item), { replace: true });
        return resolved.item;
      })
      : fetchDeepSeekConversation(targetId);
    // A session that lives in another project is not "missing" here: the route moves and that project resolves it.
    void lookup.then(item => { if (alive && item !== 'moved') setFetched({ key: fetchKey, item }); });
    return () => { alive = false; };
  }, [targetKind, targetId, fetchKey, isListed, historyLoaded, project, fetched?.key, navigate]);

  const resolved: WorkbenchSessionItem | 'loading' | 'missing' | null = !target ? null
    : listed ?? (fetched?.key === fetchKey ? fetched.item ?? 'missing' : 'loading');
  const session = resolved && typeof resolved === 'object' ? { ...resolved, running: busy.has(resolved.id) || undefined } : null;
  const newProvider = parseNewProvider(searchParams.get('new'));
  // DeepSeek talks in the hub project's space; a directory without one starts Claude Code instead (the chat column
  // and the new-session menu apply the same rule from workbenchRoutes).
  const requestedProvider = newProvider ?? lastProvider;
  const chatProvider: WorkbenchNewProvider = session ? parseNewProvider(session.provider) ?? lastProvider
    : resolveNewChatProvider(requestedProvider, hubProjectId);
  // What "+ 新会话" offers here: the shared rule (DeepSeek only with a Studio project).
  const newChoices = useMemo(() => newChatChoices(hubProjectId), [hubProjectId]);
  const chatKey = project ? `${project.projectId}:${session && session.id !== adoptedId ? `${session.kind}:${session.id}` : `new:${chatEpoch}`}` : '';

  useEffect(() => { if (project) writeStored(LAST_PROJECT_KEY, project.projectId); }, [project]);

  useEffect(() => {
    const projectName = current?.hub?.name ?? project?.displayName;
    const title = session?.title ?? (targetKey ? '会话' : '新会话');
    document.title = projectName ? `${title} · ${projectName}` : '工作台 · Agent Cloud Studio';
  }, [current?.hub?.name, project?.displayName, session?.title, targetKey]);
  // Leaving the workbench gives the tab back the app's own title; the Studio home does not set one itself.
  useEffect(() => () => { document.title = getPageTitle(null, null); }, []);

  // A notification tapped while the workbench is open names a session; open it here.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return undefined;
    const onMessage = (event: MessageEvent) => {
      const message = event.data as { type?: string; sessionId?: unknown } | null;
      if (message?.type !== 'notification:navigate' || typeof message.sessionId !== 'string' || !message.sessionId) return;
      void resolveLegacySessionPath(message.sessionId).then(path => { if (path) navigate(path); });
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);

  // Files: the editor state, resolving bare names from chat links against the project tree.
  const { editingFile, handleFileOpen, handleCloseEditor, handleUnsavedChangesChange } = useEditorSidebar({ selectedProject: project, isMobile: viewport === 'phone' });
  const resolveAndOpen = useFileOpenResolver(project, handleFileOpen);
  const openFile = useCallback((path: string, diffInfo?: Parameters<FileOpenHandler>[1], line?: number | null) => {
    showInspectorTab('files');
    resolveAndOpen(path, diffInfo ?? null, line ?? null);
  }, [showInspectorTab, resolveAndOpen]);
  const onOpenFile = useCallback((path: string) => openFile(path), [openFile]);
  const openFileInEditor = useCallback((path: string, line?: number | null) => openFile(path, undefined, line), [openFile]);
  const openDirectory = useCallback((path: string) => { showInspectorTab('files'); setRevealDirectory({ path }); }, [showInspectorTab]);
  const openSettings = useCallback(() => navigate('/apps/connections'), [navigate]);
  usePaletteOpsRegister({ openFile: onOpenFile, openFileInEditor, openDirectory, openSettings, refreshProjects });
  // The editor belongs to the project it was opened in; another project shows its own (empty) files panel.
  const projectFile = editingFile && editingFile.projectId === project?.projectId ? editingFile : null;

  const startNewChat = useCallback((provider?: WorkbenchNewProvider) => {
    if (!project) return;
    const chosen = provider ?? lastProvider;
    setLastProvider(chosen);
    writeStored(LAST_PROVIDER_KEY, chosen);
    // The inherited chat engine reads the agent from this shared preference when a new chat mounts.
    if (chosen !== 'deepseek') writeSelectedProvider(chosen);
    setAdoptedId(null);
    setChatEpoch(value => value + 1);
    setSheetOpen(false);
    navigate(workbenchPath(project.projectId, null, chosen));
  }, [project, lastProvider, navigate]);

  // A new chat switched agent in its header: remember it like a menu pick, and let the URL follow so a reload
  // reopens the new chat with the agent now chosen (the chat stays mounted; only ?new= changes).
  const rememberProvider = useCallback((provider: WorkbenchNewProvider) => {
    setLastProvider(provider);
    writeStored(LAST_PROVIDER_KEY, provider);
    if (project) navigate(workbenchPath(project.projectId, null, provider), { replace: true });
  }, [project, navigate]);

  const onSessionCreated = useCallback((item: WorkbenchSessionItem) => {
    if (!project) return;
    upsert(item);
    setAdoptedId(item.id);
    navigate(workbenchPath(project.projectId, item), { replace: true });
  }, [project, upsert, navigate]);

  const leaveIfOpen = (item: WorkbenchSessionItem) => {
    if (project && session?.id === item.id && session.kind === item.kind) navigate(workbenchPath(project.projectId), { replace: true });
  };
  const renameSession = async (item: WorkbenchSessionItem, title: string) => {
    try { await rename(item, title); return true; } catch (failure) { toast.error(failure instanceof Error ? failure.message : '重命名失败'); return false; }
  };
  const archiveSession = async (item: WorkbenchSessionItem) => {
    try {
      await archive(item);
      leaveIfOpen(item);
      toast(`已归档「${item.title}」`, {
        action: { label: '撤销', onClick: () => { void restore(item).catch(failure => toast.error(failure instanceof Error ? failure.message : '恢复失败')); } },
      });
    } catch (failure) { toast.error(failure instanceof Error ? failure.message : '归档失败'); }
  };
  const deleteSession = async (item: WorkbenchSessionItem) => {
    try {
      await remove(item);
      leaveIfOpen(item);
      toast(`已删除「${item.title}」`);
    } catch (failure) { toast.error(failure instanceof Error ? failure.message : '删除失败'); }
  };
  // An older page that fails says so; the button stays, so another tap retries.
  const loadOlderSessions = async () => {
    try { await loadMore(); } catch (failure) { toast.error(failure instanceof Error ? failure.message : '更早的会话加载失败'); }
  };

  const sidebarDocked = viewport !== 'phone';
  const sidebarVisible = sidebarDocked ? !layout.sidebarCollapsed : sheetOpen;
  const showSidebar = () => { if (sidebarDocked) setSidebarCollapsed(false); else setSheetOpen(true); };
  const focusSearch = () => {
    showSidebar();
    // The column may still be sliding in; focus once it exists.
    window.setTimeout(() => searchRef.current?.focus(), 60);
  };
  useWorkbenchShortcuts({
    onSearch: focusSearch,
    onNewChat: () => startNewChat(),
    onToggleSidebar: () => { if (sidebarDocked) toggleSidebar(); else setSheetOpen(value => !value); },
    onToggleInspector: toggleInspector,
  });

  // The docked column leaves the tab order while it is collapsed.
  const dock = useRef<HTMLDivElement>(null);
  useEffect(() => { if (dock.current) dock.current.inert = !sidebarVisible; }, [sidebarVisible, sidebarDocked]);

  // /work opens the project used last on this device, else the first Studio project, else the first one, keeping a
  // requested agent (?new=). Studio projects come before the rest because any folder a CLI ran in is listed too.
  if (!projectId && entries?.length) {
    const remembered = readStored(LAST_PROJECT_KEY);
    const destination = entries.find(entry => entry.project.projectId === remembered)
      ?? entries.find(entry => entry.hub) ?? entries[0];
    return <Navigate to={workbenchPath(destination.project.projectId, null, newProvider)} replace />;
  }

  const sidebar = <WorkbenchSidebar
    viewport={viewport} modifier={modifier} entries={entries} current={current} newChatChoices={newChoices} lastProvider={lastProvider}
    query={query} searchRef={searchRef} quota={quota}
    list={project ? {
      projectId: project.projectId, items: historyItems, activeId: session?.id ?? null, error: sessions.error,
      hasMore: sessions.hasMore, loadingMore: sessions.loadingMore,
      onRetry: () => void reloadSessions(), onLoadMore: () => void loadOlderSessions(), onNavigate: () => setSheetOpen(false),
      onRename: renameSession, onArchive: item => void archiveSession(item), onDelete: setPendingDelete,
    } : null}
    onQueryChange={setQuery}
    onSelectProject={id => { setQuery(''); navigate(workbenchPath(id)); }}
    onNewChat={startNewChat}
    onHome={() => navigate('/')}
    onHide={() => { if (sidebarDocked) setSidebarCollapsed(true); else setSheetOpen(false); }}
    onOpenSettings={openSettings}
  />;

  const projectName = current?.hub?.name ?? project?.displayName ?? '';
  const barProvider = session?.provider ?? chatProvider;
  // The chat column is on screen (not a skeleton or an empty state): its glass header is then the only title bar,
  // carrying these same controls, so the shell's own bar steps aside.
  const showsChat = entries !== null && Boolean(projectId) && Boolean(project) && resolved !== 'loading' && resolved !== 'missing';

  const barLeading = sidebarVisible ? null : <>
    <button type="button" className="icon-button plain" onClick={showSidebar} aria-label="显示会话列表"
      title={`显示会话列表${modifier ? `（${modifier}\\）` : ''}`}><PanelLeft size={19} aria-hidden="true" /></button>
    {sidebarDocked && <button type="button" className="icon-button plain" onClick={() => navigate('/')} aria-label="返回 Studio 主屏幕">
      <LayoutGrid size={18} aria-hidden="true" /></button>}
  </>;
  const barTrailing = !project ? null : viewport === 'phone'
    ? <button type="button" className="icon-button plain" onClick={() => showInspectorTab(layout.inspectorTab)} aria-label="打开文件、终端、Git 与预览">
      <PanelRight size={19} aria-hidden="true" /></button>
    : <div className="wb-toolbar" role="group" aria-label="检查器">
      {TOOL_ICONS.map(tool => {
        const Icon = tool.icon;
        const pressed = layout.inspectorOpen && layout.inspectorTab === tool.id;
        return <button type="button" key={tool.id} className="wb-tool" aria-pressed={pressed} aria-label={tool.label}
          title={`${tool.label}${modifier ? `（${modifier}J 切换检查器）` : ''}`} onClick={() => showInspectorTab(tool.id, { toggle: true })}>
          <Icon size={17} aria-hidden="true" />
        </button>;
      })}
    </div>;
  // The bar of the states without a chat (loading, empty, missing, a crashed column).
  const shellBar = <header className="wb-bar">
    <div className="wb-bar-leading">{barLeading}</div>
    {project && <div className="wb-bar-title">
      <WorkbenchProviderMark provider={barProvider} running={Boolean(session?.running)} />
      <span className="wb-bar-text">
        <strong>{session?.title ?? (resolved === 'loading' ? '…' : '新会话')}</strong>
        <small>{providerMeta(barProvider).name}{session?.running ? ' · 运行中' : ''} · {projectName}</small>
      </span>
    </div>}
    <div className="wb-bar-trailing">{barTrailing}</div>
  </header>;
  const chatChrome: WorkbenchChatChrome = { leading: barLeading, trailing: barTrailing, projectName, onProviderChange: rememberProvider };

  const centre = (() => {
    if (entries === null) return <ChatSkeleton />;
    if (!projectId) {
      return <div className="wb-stage-empty">
        <FolderSearch size={34} strokeWidth={1.4} aria-hidden="true" />
        <h2>{projectsError ? '项目列表加载失败' : '还没有项目'}</h2>
        <p>{projectsError || '在 Studio 打开一个项目的「AI 助手」，从那里启动 Claude Code 或 Codex，项目就会出现在这里。'}</p>
        <div className="wb-stage-actions">
          {projectsError && <button type="button" className="ios-button tinted" onClick={() => void refreshProjects()}>重试</button>}
          <Link to="/" className="ios-button">返回 Studio</Link>
        </div>
      </div>;
    }
    if (!project) {
      return <div className="wb-stage-empty">
        <FolderX size={34} strokeWidth={1.4} aria-hidden="true" />
        <h2>找不到这个项目</h2>
        <p>{projectsError || '它可能已被归档或删除。可以从左上角切换到其他项目。'}</p>
        <div className="wb-stage-actions">
          <button type="button" className="ios-button tinted" onClick={() => navigate('/work', { replace: true })}>打开最近的项目</button>
        </div>
      </div>;
    }
    if (resolved === 'loading') return <ChatSkeleton />;
    if (resolved === 'missing') {
      return <div className="wb-stage-empty">
        <MessageSquareOff size={34} strokeWidth={1.4} aria-hidden="true" />
        <h2>这个会话已不存在</h2>
        <p>它可能已被删除或归档。可以从左侧历史里打开其他会话。</p>
        <div className="wb-stage-actions"><button type="button" className="ios-button tinted" onClick={() => startNewChat()}>开始新会话</button></div>
      </div>;
    }
    return <WorkbenchChatBoundary key={chatKey} header={shellBar} onNewChat={() => startNewChat()}>
      <WorkbenchChat project={project} session={session} provider={chatProvider} hubProjectId={hubProjectId}
        onSessionCreated={onSessionCreated} onOpenFile={onOpenFile} chrome={chatChrome} />
    </WorkbenchChatBoundary>;
  })();

  return <div className="studio workbench" data-viewport={viewport}>
    {sidebarDocked
      ? <m.div ref={dock} className="wb-sidebar-dock" initial={false} animate={{ width: sidebarVisible ? SIDEBAR_WIDTH : 0 }} transition={WORKBENCH_DOCK_TWEEN}
        aria-hidden={!sidebarVisible || undefined}>
        <div className="wb-sidebar-frame" style={{ width: SIDEBAR_WIDTH }}>{sidebar}</div>
      </m.div>
      : <AnimatePresence>
        {sheetOpen && <m.div key="scrim" className="wb-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSheetOpen(false)} />}
        {sheetOpen && <m.div key="sheet" className="wb-sidebar-sheet" role="dialog" aria-modal="true" aria-label="会话列表"
          initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }} transition={WORKBENCH_PANEL_SPRING}
          onKeyDown={event => { if (event.key === 'Escape') setSheetOpen(false); }}>
          {sidebar}
        </m.div>}
      </AnimatePresence>}

    <main className="wb-main">
      {!showsChat && shellBar}
      <div className="wb-stage">{centre}</div>
    </main>

    {project && <WorkbenchInspector key={project.projectId} project={project} viewport={viewport} open={layout.inspectorOpen} tab={layout.inspectorTab}
      width={layout.inspectorWidth} reservedWidth={sidebarDocked && sidebarVisible ? SIDEBAR_WIDTH : 0}
      editingFile={projectFile} revealDirectory={revealDirectory}
      onTabChange={tab => showInspectorTab(tab)} onClose={closeInspector} onWidthCommit={setInspectorWidth}
      onOpenFile={openFile} onCloseEditor={handleCloseEditor} onUnsavedChangesChange={handleUnsavedChangesChange}
      onProjectSelect={(next: Project) => navigate(workbenchPath(next.projectId))} onProjectsRefresh={() => void refreshProjects()} />}

    {pendingDelete && <StudioConfirmSheet
      title={pendingDelete.kind === 'deepseek' ? '删除这段对话？' : '删除这个会话？'}
      message={`「${pendingDelete.title}」${pendingDelete.kind === 'deepseek' ? '及全部消息' : '及其对话记录'}将被永久删除，无法撤销。只想收起它可以选择「归档」。`}
      confirmLabel="删除"
      onCancel={() => setPendingDelete(null)}
      onConfirm={() => { const item = pendingDelete; setPendingDelete(null); void deleteSession(item); }} />}
  </div>;
}
