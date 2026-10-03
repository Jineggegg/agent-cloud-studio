import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { IconChevronRight, IconExternalLink, IconPlus, IconRefresh, IconServer, IconTerminal2, IconWorld } from '@/modules/studio/icons/tabler';
import { api, readApiJson } from '@/shared/api';
import type {
  HubProject, StudioBrand, StudioConversation, StudioProjectLink, StudioRemoteHost, StudioRemoteLaunch, StudioRemoteStatus, WorkbenchHubLink,
} from '@/shared/types';
import { StudioBrandMark } from '@/modules/studio/brandIcons';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import { useRefreshSpin } from '@/modules/studio/hooks/useRefreshSpin';
import '@/modules/studio/studio-project.css';

// The terminal (xterm) loads only when a remote session or the local shell is opened.
const StudioTerminalCover = lazy(() => import('@/modules/studio/StudioTerminalCover'));
// Shown while the terminal chunk downloads.
const terminalFallback = <div className="studio-layer terminal-loading"><StudioSpinner size={28} label="正在打开终端" /></div>;

// Name, muted tone and official mark of each provider a project session can belong to.
const PROVIDERS = {
  claude: { name: 'Claude Code', tone: 'clay', brand: 'claude' },
  codex: { name: 'Codex', tone: 'graphite', brand: 'openai' },
  deepseek: { name: 'DeepSeek', tone: 'slate', brand: 'deepseek' },
} as const satisfies Record<string, { name: string; tone: string; brand: StudioBrand }>;
type SessionProvider = keyof typeof PROVIDERS;

// Agents that can run on a remote host; the server builds the actual ssh/tmux command.
const REMOTE_AGENTS: { id: 'claude' | 'codex' | 'shell'; name: string; tone: string; brand?: StudioBrand; tool: 'claude' | 'codex' | null }[] = [
  { id: 'claude', name: 'Claude Code', tone: 'clay', brand: 'claude', tool: 'claude' },
  { id: 'codex', name: 'Codex', tone: 'graphite', brand: 'openai', tool: 'codex' },
  { id: 'shell', name: '终端', tone: 'stone', tool: null },
];

// One page of the IDE project's sessions is plenty for a landing list; the workbench pages further back.
const SESSION_PAGE = 50;
// The history shows this many rows until expanded.
const HISTORY_PREVIEW = 8;
// Running state is polled this often while the page is visible.
const RUNNING_POLL_MS = 15_000;

type SessionsPage = { sessions?: { id: string; provider?: string; summary?: string; lastActivity?: string | null }[] };
type RunningPayload = { data?: { sessions?: { sessionId?: unknown }[] } };

/** One row of the project's session list: a Claude Code / Codex session or a DeepSeek conversation. */
type ProjectSessionRow = { id: string; kind: 'agent' | 'deepseek'; provider: SessionProvider; title: string; updatedAt: string | null };

function hostOf(url: string) {
  try { return new URL(url).host; } catch { return url; }
}

// 今天 14:05 · 昨天 · 9月28日: the iOS way of dating a list row.
function formatWhen(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (date.getTime() >= startOfToday) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (date.getTime() >= startOfToday - 86_400_000) return '昨天';
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

// A summary with no letters or digits (a probe's ".") says nothing; such sessions read as untitled.
function sessionTitle(summary: string | undefined): string {
  return /[\p{L}\p{N}]/u.test(summary ?? '') ? summary!.trim() : '新会话';
}

function ProviderStone({ provider, running = false }: { provider: SessionProvider; running?: boolean }) {
  const meta = PROVIDERS[provider];
  return <span className={`home-icon small tone-${meta.tone} project-session-mark`} data-running={running ? 'true' : undefined} aria-hidden="true">
    <StudioBrandMark brand={meta.brand} size={19} />
  </span>;
}

/** The product's own website and sign-in pages (the project's links), each opening in a new tab. */
function ProjectWebsites({ project }: { project: HubProject }) {
  const [primary, ...others] = project.links;
  const open = (link: StudioProjectLink) => window.open(link.url, '_blank', 'noopener,noreferrer');
  return <section className="ios-section first project-websites" aria-label="网站">
    <div className="project-site-card">
      <span className={`home-icon tone-${project.tone} project-site-icon`} aria-hidden="true"><IconWorld size={24} strokeWidth={1.6} /></span>
      <span className="project-site-text">
        <strong>{primary.label}</strong>
        <small>{hostOf(primary.url)}</small>
      </span>
      <a className="ios-button filled project-site-open" href={primary.url} target="_blank" rel="noopener noreferrer" aria-label={`打开网站：${primary.label}`}>
        打开网站<IconExternalLink size={16} aria-hidden="true" />
      </a>
    </div>
    {others.length > 0 && <div className="project-site-links">
      {others.map(link => <button type="button" key={link.url} className="project-site-chip ios-press" onClick={() => open(link)} aria-label={`打开网站：${link.label}`}>
        <span>{link.label}</span><IconExternalLink size={14} aria-hidden="true" />
      </button>)}
    </div>}
  </section>;
}

function RemoteAgents({ project }: { project: HubProject }) {
  // Label and SSH target of the project's host, from the server's configured host list.
  const [host, setHost] = useState<StudioRemoteHost | null>(null);
  // Live reachability and installed tools; null while checking (an SSH round trip can take seconds).
  const [status, setStatus] = useState<StudioRemoteStatus | null>(null);
  // The agent whose launch command is being requested; blocks duplicate launches.
  const [launching, setLaunching] = useState<string | null>(null);
  // The session shown in the full-screen terminal.
  const [session, setSession] = useState<StudioRemoteLaunch | null>(null);
  // Launch failures stay visible until the next attempt.
  const [error, setError] = useState('');

  const check = useCallback(async () => {
    setStatus(null);
    const next = await api.studio.remote.status(project.remoteHost).then(readApiJson<StudioRemoteStatus>)
      .catch((reason: unknown) => ({ name: project.remoteHost, online: false, latencyMs: null, checkedAt: new Date().toISOString(), tools: { claude: false, codex: false, tmux: false }, error: reason instanceof Error ? reason.message : '无法检查主机' }));
    setStatus(next);
  }, [project.remoteHost]);
  useEffect(() => {
    void api.studio.remote.hosts().then(readApiJson<StudioRemoteHost[]>).then(hosts => setHost(hosts.find(item => item.name === project.remoteHost) ?? null)).catch(() => setHost(null));
    void check();
  }, [project.remoteHost, check]);

  async function launch(agent: 'claude' | 'codex' | 'shell') {
    setLaunching(agent); setError('');
    try { setSession(await readApiJson<StudioRemoteLaunch>(await api.studio.projects.launchRemote(project.id, agent))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法打开远程会话'); }
    finally { setLaunching(null); }
  }
  const label = host?.label ?? project.remoteHost;
  // The shell is always offered; Claude Code / Codex only when enabled for this project, as the server enforces.
  const agents = REMOTE_AGENTS.filter(agent => agent.tool === null || (project.modules.includes('agents') && project.providers.includes(agent.tool)));
  const missing = status?.online ? agents.filter(agent => agent.tool && !status.tools[agent.tool]).map(agent => agent.name) : [];

  return <section className={`ios-section ${project.links.length ? '' : 'first'}`}>
    <div className="ios-section-header"><h2>在 {label} 上开始</h2><span className="caption mono">{project.remoteDir || '~'}</span></div>
    <div className="ios-list">
      <div className="ios-row remote-host-row">
        <span className="home-icon small tone-graphite" aria-hidden="true"><IconServer size={17} strokeWidth={1.6} /></span>
        <span className="ios-row-body"><strong>{label}</strong><small className="mono">{host?.target ?? '未在服务器上配置这台主机'}</small></span>
        <span className="remote-host-status" aria-live="polite">
          {status === null ? <StudioSpinner size={16} label="正在检查" />
            : <><span className={`status-dot ${status.online ? 'good' : ''}`} aria-hidden="true" />{status.online ? `在线 · ${status.latencyMs ?? '–'} ms` : '离线'}</>}
        </span>
        <button type="button" className="icon-button" aria-label="重新检查" title="重新检查" disabled={status === null} onClick={() => void check()}><IconRefresh size={18} aria-hidden="true" /></button>
      </div>
    </div>
    {status && !status.online && status.error && <p className="studio-feedback error">{status.error}</p>}
    <div className="agent-grid remote-agent-grid">
      {agents.map(agent => {
        const unavailable = !status?.online || (agent.tool !== null && !status.tools[agent.tool]);
        return <button type="button" key={agent.id} className="agent-card ios-press" disabled={launching !== null || unavailable} onClick={() => void launch(agent.id)}>
          <span className={`home-icon tone-${agent.tone} agent-mark`} aria-hidden="true">{launching === agent.id ? <StudioSpinner size={22} /> : agent.brand ? <StudioBrandMark brand={agent.brand} size={24} /> : <IconTerminal2 size={22} strokeWidth={1.6} />}</span>
          <span className="agent-card-text"><strong>{agent.name}</strong><small>{agent.tool && status?.online && !status.tools[agent.tool] ? '未安装' : `运行在 ${label}`}</small></span>
        </button>;
      })}
    </div>
    {error && <p className="studio-feedback error" role="alert">{error}</p>}
    <p className="ios-section-footer">
      通过 Tailscale 与 SSH 连接；每个会话运行在远程主机的 tmux 里，关掉页面不会中断，再次打开会接回同一个会话。
      {missing.length > 0 && ` 这台主机还没有安装 ${missing.join('、')}。`}
      {status?.online && !status.tools.tmux && ' 主机上没有 tmux，会话在断开后不会保留。'}
    </p>
    {session && <Suspense fallback={terminalFallback}>
      <StudioTerminalCover mode="remote" launch={session} hostLabel={label} onClose={() => setSession(null)} />
    </Suspense>}
  </section>;
}

// A project's sessions as both session lists read them: the rows (newest first) with their running state, 新建会话
// (the workbench, or the project's DeepSeek chat without a local directory) and a row renderer that opens each one.
function useProjectSessions(project: HubProject, onOpenChat: (conversationId?: string) => void) {
  const navigate = useNavigate();
  const local = Boolean(project.workspacePath) && !project.remoteHost;
  const deepseek = project.providers.includes('deepseek');
  const agents = local && project.modules.includes('agents');
  // The IDE project of this directory, so rows open straight in the workbench; null until known (or never launched).
  const [workbenchProjectId, setWorkbenchProjectId] = useState<string | null>(null);
  // Claude Code / Codex sessions of the directory and the project's DeepSeek conversations; null while loading.
  const [rows, setRows] = useState<ProjectSessionRow[] | null>(null);
  // Ids of sessions with a run (or background work) in progress, from the server's running list.
  const [running, setRunning] = useState<Set<string>>(() => new Set());
  // A workbench launch in flight (新建会话 or a conversation of a not yet registered directory); blocks repeats.
  const [opening, setOpening] = useState(false);
  // Loading or opening failures stay visible and never imply a running model.
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const links = local ? await api.studio.workbench.hubLinks().then(readApiJson<WorkbenchHubLink[]>).catch(() => [] as WorkbenchHubLink[]) : [];
      const projectId = links.find(link => link.hubId === project.id)?.projectId ?? null;
      setWorkbenchProjectId(projectId);
      const [page, conversations] = await Promise.all([
        agents && projectId ? api.projectSessions(projectId, { limit: SESSION_PAGE, offset: 0 }).then(response => {
          if (!response.ok) throw new Error(`会话加载失败（${response.status}）`);
          return response.json() as Promise<SessionsPage>;
        }) : Promise.resolve({ sessions: [] } as SessionsPage),
        deepseek ? api.studio.conversations(`project:${project.id}`).then(readApiJson<StudioConversation[]>) : Promise.resolve([] as StudioConversation[]),
      ]);
      const agentRows: ProjectSessionRow[] = (page.sessions ?? [])
        // Cursor and OpenCode are hidden; a session without a provider is an old Claude Code one.
        .filter(item => !item.provider || item.provider === 'claude' || item.provider === 'codex')
        .map(item => ({ id: item.id, kind: 'agent', provider: item.provider === 'codex' ? 'codex' : 'claude', title: sessionTitle(item.summary), updatedAt: item.lastActivity ?? null }));
      const deepseekRows: ProjectSessionRow[] = conversations.map(item => ({ id: item.id, kind: 'deepseek', provider: 'deepseek', title: item.title || '新对话', updatedAt: item.updated_at ?? null }));
      setRows([...agentRows, ...deepseekRows].sort((a, b) => (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0)));
      setError('');
    } catch (reason) {
      setRows(previous => previous ?? []);
      setError(reason instanceof Error ? reason.message : '会话加载失败');
    }
  }, [agents, deepseek, local, project.id]);

  const loadRunning = useCallback(async () => {
    if (!agents) return;
    try {
      const response = await api.runningSessions();
      if (!response.ok) return;
      const payload = await response.json() as RunningPayload;
      const ids = (payload.data?.sessions ?? []).map(item => item.sessionId).filter((id): id is string => typeof id === 'string' && Boolean(id));
      setRunning(new Set(ids));
    } catch { /* The list keeps its last known state; the next poll tries again. */ }
  }, [agents]);
  // The list loads on open and again when the owner comes back; running state is also polled while visible.
  useEffect(() => {
    void load();
    void loadRunning();
    const timer = window.setInterval(() => { if (!document.hidden) void loadRunning(); }, RUNNING_POLL_MS);
    const onFocus = () => { void loadRunning(); void load(); };
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [load, loadRunning]);

  // Registers the directory as a workbench project when needed (POST launch) and opens `suffix` inside it.
  const openInWorkbench = async (suffix = '') => {
    if (workbenchProjectId) { navigate(`/work/${encodeURIComponent(workbenchProjectId)}${suffix}`); return; }
    setOpening(true); setError('');
    try {
      const { url } = await readApiJson<{ url: string }>(await api.studio.projects.launch(project.id));
      navigate(`${url}${suffix}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '工作台打开失败'); }
    finally { setOpening(false); }
  };
  const startNew = () => { if (local) void openInWorkbench(); else onOpenChat(); };
  const canStart = local ? (agents || deepseek) : deepseek;
  const hrefOf = (row: ProjectSessionRow) => workbenchProjectId
    ? `/work/${encodeURIComponent(workbenchProjectId)}/${row.kind === 'deepseek' ? 'd' : 's'}/${encodeURIComponent(row.id)}`
    : null;

  const runningRows = (rows ?? []).filter(row => row.kind === 'agent' && running.has(row.id));
  const historyRows = (rows ?? []).filter(row => !(row.kind === 'agent' && running.has(row.id)));

  const row = (item: ProjectSessionRow, isRunning: boolean) => {
    const meta = PROVIDERS[item.provider];
    const body = <>
      <ProviderStone provider={item.provider} running={isRunning} />
      <span className="ios-row-body">
        <strong>{item.title}</strong>
        <small>{meta.name}{isRunning ? ' · 运行中' : ''}</small>
      </span>
      {item.updatedAt && !isRunning && <time className="project-session-time" dateTime={item.updatedAt}>{formatWhen(item.updatedAt)}</time>}
      {isRunning && <span className="status-dot good" aria-hidden="true" />}
      <IconChevronRight size={18} className="chevron" aria-hidden="true" />
    </>;
    const href = local ? hrefOf(item) : null;
    if (href) return <Link className="ios-row" key={`${item.kind}:${item.id}`} to={href}>{body}</Link>;
    return <button type="button" className="ios-row" key={`${item.kind}:${item.id}`} disabled={opening}
      onClick={() => { if (!local) onOpenChat(item.id); else void openInWorkbench(`/${item.kind === 'deepseek' ? 'd' : 's'}/${encodeURIComponent(item.id)}`); }}>{body}</button>;
  };

  return { local, deepseek, rows, runningRows, historyRows, opening, error, canStart, startNew, row, load, loadRunning };
}

/**
 * The project's conversations: 新建会话, then its running sessions and its history (Claude Code and Codex sessions of
 * the project directory with its DeepSeek conversations, newest first). With a local directory everything opens in
 * the workbench's one chat, where the model menu chooses Claude Code, Codex or DeepSeek; without one (a remote or
 * unconfigured project) only DeepSeek conversations exist here and they open in the project's own chat (`onOpenChat`).
 */
function ProjectSessions({ project, onOpenChat }: { project: HubProject; onOpenChat: (conversationId?: string) => void }) {
  const { local, deepseek, rows, runningRows, historyRows, opening, error, canStart, startNew, row, load, loadRunning } = useProjectSessions(project, onOpenChat);
  // The whole history instead of its newest rows.
  const [showAll, setShowAll] = useState(false);
  // The full-screen shell on this computer, opened from the 终端 button.
  const [terminalOpen, setTerminalOpen] = useState(false);
  // The list's refresh button spins (whole turns) while it reads the sessions again.
  const refreshSpin = useRefreshSpin();
  const shownHistory = showAll ? historyRows : historyRows.slice(0, HISTORY_PREVIEW);
  // Remote projects run agents in their own terminals above; this section then only holds DeepSeek.
  const heading = local ? '会话' : 'DeepSeek 对话';

  return <>
    <section className={`ios-section project-start ${project.links.length || project.remoteHost ? '' : 'first'}`}>
      <div className="project-start-row">
        <button type="button" className="project-new-session ios-press" disabled={!canStart || opening} onClick={startNew}>
          <span className="project-new-icon" aria-hidden="true">{opening ? <StudioSpinner size={18} /> : <IconPlus size={20} strokeWidth={2.2} />}</span>
          <span className="project-new-text">
            <strong>{local ? '新建会话' : '新建对话'}</strong>
            <small>{local ? '在对话里选 Claude、Codex 或 DeepSeek 的模型' : 'DeepSeek · 这个项目的对话'}</small>
          </span>
        </button>
        {local && <button type="button" className="project-terminal ios-press" onClick={() => setTerminalOpen(true)} aria-label="终端" title="在项目目录打开终端">
          <IconTerminal2 size={20} strokeWidth={1.8} aria-hidden="true" /><span>终端</span>
        </button>}
      </div>
      {!project.workspacePath && !project.remoteHost && project.modules.includes('agents') && <p className="ios-section-footer">在「设置」里填写项目目录后，就能在这个目录里和 Claude Code、Codex 对话。</p>}
      {error && <p className="studio-feedback error" role="alert">{error}</p>}
    </section>

    {runningRows.length > 0 && <section className="ios-section" aria-label="正在运行的会话">
      <div className="ios-section-header"><h2>正在运行</h2><span className="caption">{runningRows.length} 个</span></div>
      <div className="ios-list">{runningRows.map(item => row(item, true))}</div>
    </section>}

    {(local || deepseek) && <section className="ios-section" aria-label="历史会话">
      <div className="ios-section-header"><h2>{runningRows.length ? '历史' : heading}</h2>
        <button type="button" className={`icon-button ${refreshSpin.spinning ? 'refreshing' : ''}`} title="刷新会话" aria-label="刷新会话"
          aria-busy={refreshSpin.spinning || undefined} onClick={() => void refreshSpin.run(() => Promise.all([load(), loadRunning()]))}><IconRefresh size={18} className="refresh-icon" aria-hidden="true" /></button></div>
      <div className="ios-list">
        {rows === null && <div className="ios-row no-icon" role="status"><StudioSpinner size={16} label="正在读取会话" /></div>}
        {shownHistory.map(item => row(item, false))}
        {rows !== null && !historyRows.length && <div className="ios-row no-icon"><span className="ios-row-body"><small>{runningRows.length ? '没有其他会话' : `还没有会话，点「${local ? '新建会话' : '新建对话'}」开始`}</small></span></div>}
        {historyRows.length > HISTORY_PREVIEW && <button type="button" className="ios-row no-icon project-show-all" onClick={() => setShowAll(value => !value)}>
          {showAll ? '收起' : `显示全部 ${historyRows.length} 个`}
        </button>}
      </div>
      {local && <p className="ios-section-footer">Claude Code 和 Codex 在这台电脑的 <span className="mono">{project.workspacePath}</span> 里运行，用你已登录的订阅；DeepSeek 对话保存在这个项目里。</p>}
    </section>}

    {terminalOpen && <Suspense fallback={terminalFallback}>
      <StudioTerminalCover mode="local" project={project} onClose={() => setTerminalOpen(false)} />
    </Suspense>}
  </>;
}

/**
 * Used by StudioAppHome's AI sidebar (an AI-built app's 主页): 新建会话 and the project's few newest sessions, running
 * ones first, each opening in the workbench; 全部 (`onShowAll`) goes to the AI 工坊 tab with the whole history.
 */
export function StudioProjectRecentSessions({ project, onOpenChat, onShowAll, limit = 3 }: {
  project: HubProject; onOpenChat: (conversationId?: string) => void; onShowAll: () => void; limit?: number;
}) {
  const { local, rows, runningRows, historyRows, opening, error, canStart, startNew, row } = useProjectSessions(project, onOpenChat);
  const recent = [...runningRows.map(item => ({ item, running: true })), ...historyRows.map(item => ({ item, running: false }))].slice(0, limit);
  return <>
    <button type="button" className="project-new-session app-side-new ios-press" disabled={!canStart || opening} onClick={startNew}>
      <span className="project-new-icon" aria-hidden="true">{opening ? <StudioSpinner size={18} /> : <IconPlus size={20} strokeWidth={2.2} />}</span>
      <span className="project-new-text"><strong>{local ? '新建会话' : '新建对话'}</strong><small>Claude、Codex 或 DeepSeek</small></span>
    </button>
    {error && <p className="studio-feedback error" role="alert">{error}</p>}
    <section className="app-side-section project-home" aria-label="最近会话">
      <div className="app-side-header"><h2>最近会话</h2>
        <button type="button" className="app-side-link ios-press" onClick={onShowAll}>全部<IconChevronRight size={15} aria-hidden="true" /></button></div>
      <div className="ios-list">
        {rows === null && <div className="ios-row no-icon" role="status"><StudioSpinner size={16} label="正在读取会话" /></div>}
        {recent.map(({ item, running }) => row(item, running))}
        {rows !== null && !recent.length && <div className="ios-row no-icon"><span className="ios-row-body"><small>还没有会话</small></span></div>}
      </div>
    </section>
  </>;
}

/**
 * Used by StudioPage's project app as the AI 助手 tab (AI 工坊 in an AI-built app, which opens on its 主页 instead),
 * the page a project opens on: the product's website (打开网站),
 * 新建会话 (one chat for Claude Code, Codex and DeepSeek), the running and earlier sessions of the project with
 * their official marks, a small 终端 button, and for a remote project the agents of its host. `onOpenChat` opens the
 * project's own DeepSeek chat (a new conversation, or `conversationId`) where there is no local directory.
 */
export function StudioProjectAgents({ project, onOpenChat }: { project: HubProject; onOpenChat: (conversationId?: string) => void }) {
  return <div className="studio-stagger project-home">
    {project.links.length > 0 && <ProjectWebsites project={project} />}
    {project.remoteHost && <RemoteAgents project={project} />}
    {(!project.remoteHost || project.providers.includes('deepseek')) && <ProjectSessions project={project} onOpenChat={onOpenChat} />}
  </div>;
}
