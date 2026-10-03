import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { IconChevronRight, IconLoader2, IconRefresh, IconServer, IconTerminal2 } from '@/modules/studio/icons/tabler';
import { api, readApiJson } from '@/shared/api';
import { writeSelectedProvider } from '@/shared/selectedProvider';
import type { HubAgentProvider, HubProject, HubSession, StudioBrand, StudioRemoteHost, StudioRemoteLaunch, StudioRemoteStatus, WorkbenchHubLink } from '@/shared/types';
import { StudioBrandMark } from '@/modules/studio/brandIcons';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';

// The terminal (xterm) loads only when a remote session or the local shell is opened.
const StudioTerminalCover = lazy(() => import('@/modules/studio/StudioTerminalCover'));
// Shown while the terminal chunk downloads.
const terminalFallback = <div className="studio-layer terminal-loading"><StudioSpinner size={28} label="正在打开终端" /></div>;

// IDE agents in display order, with their muted brand-adjacent tones and official marks (brandIcons).
const AGENTS: { id: HubAgentProvider; name: string; caption: string; tone: string; brand: StudioBrand }[] = [
  { id: 'claude', name: 'Claude Code', caption: 'Claude 订阅', tone: 'clay', brand: 'claude' },
  { id: 'codex', name: 'Codex', caption: 'ChatGPT 订阅', tone: 'graphite', brand: 'openai' },
  { id: 'cursor', name: 'Cursor', caption: 'Cursor Agent', tone: 'slate', brand: 'cursor' },
  { id: 'opencode', name: 'OpenCode', caption: 'OpenCode', tone: 'stone', brand: 'opencode' },
];

// Agents that can run on a remote host; the server builds the actual ssh/tmux command.
const REMOTE_AGENTS: { id: 'claude' | 'codex' | 'shell'; name: string; tone: string; brand?: StudioBrand; tool: 'claude' | 'codex' | null }[] = [
  { id: 'claude', name: 'Claude Code', tone: 'clay', brand: 'claude', tool: 'claude' },
  { id: 'codex', name: 'Codex', tone: 'graphite', brand: 'openai', tool: 'codex' },
  { id: 'shell', name: '终端', tone: 'stone', tool: null },
];

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

  return <div className="studio-stagger">
    <section className="ios-section first">
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
    </section>
    {session && <Suspense fallback={terminalFallback}>
      <StudioTerminalCover mode="remote" launch={session} hostLabel={label} onClose={() => setSession(null)} />
    </Suspense>}
  </div>;
}

/** Used by StudioPage's project app to start an IDE agent inside the project directory (or on its remote host) or open its DeepSeek chat. */
export function StudioProjectAgents({ project, onOpenChat }: { project: HubProject; onOpenChat: () => void }) {
  if (project.remoteHost) return <RemoteAgents project={project} />;
  return <LocalAgents project={project} onOpenChat={onOpenChat} />;
}

function LocalAgents({ project, onOpenChat }: { project: HubProject; onOpenChat: () => void }) {
  const navigate = useNavigate();
  // Only existing sessions returned for this project's directory are displayed.
  const [sessions, setSessions] = useState<HubSession[]>([]);
  // Errors from loading or opening a workspace remain visible and never imply a running model.
  const [error, setError] = useState('');
  // The agent whose workspace is being registered; blocks duplicate launches.
  const [launching, setLaunching] = useState<HubAgentProvider | null>(null);
  // The full-screen shell on this computer, opened from the 终端 card.
  const [terminalOpen, setTerminalOpen] = useState(false);
  // The IDE project of this directory, so session rows open straight in the workbench; null until known (or never launched).
  const [workbenchProjectId, setWorkbenchProjectId] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void api.studio.workbench.hubLinks().then(readApiJson<WorkbenchHubLink[]>)
      .then(links => { if (current) setWorkbenchProjectId(links.find(link => link.hubId === project.id)?.projectId ?? null); })
      .catch(() => { if (current) setWorkbenchProjectId(null); });
    return () => { current = false; };
  }, [project.id]);
  // Without a known IDE project the old /session link still works: the workbench resolves it to its project.
  const sessionHref = (id: string) => workbenchProjectId
    ? `/work/${encodeURIComponent(workbenchProjectId)}/s/${encodeURIComponent(id)}`
    : `/session/${encodeURIComponent(id)}`;
  const load = useCallback(async () => {
    try { setSessions(await readApiJson<HubSession[]>(await api.studio.projects.sessions(project.id))); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '会话加载失败'); }
  }, [project.id]);
  useEffect(() => { void load(); }, [load]);

  async function launch(provider: HubAgentProvider) {
    setLaunching(provider); setError('');
    try {
      const result = await readApiJson<{ url: string }>(await api.studio.projects.launch(project.id, provider));
      // The workbench chat reads the provider once when it mounts, so it must be chosen before navigating.
      writeSelectedProvider(provider);
      navigate(result.url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '工作台打开失败'); }
    finally { setLaunching(null); }
  }
  const agents = AGENTS.filter(agent => project.providers.includes(agent.id));
  const nameOf = (provider: string) => AGENTS.find(agent => agent.id === provider)?.name ?? provider;

  return <div className="studio-stagger">
    <section className="ios-section first">
      <div className="ios-section-header"><h2>在本项目中开始</h2><span className="caption mono">{project.workspacePath || '未设置目录'}</span></div>
      <div className="agent-grid">
        {agents.map(agent => <button type="button" key={agent.id} className="agent-card ios-press" disabled={launching !== null || !project.workspacePath} onClick={() => void launch(agent.id)}>
          <span className={`home-icon tone-${agent.tone} agent-mark`} aria-hidden="true">{launching === agent.id ? <IconLoader2 size={22} className="spin" /> : <StudioBrandMark brand={agent.brand} size={24} />}</span>
          <span className="agent-card-text"><strong>{agent.name}</strong><small>{agent.caption}</small></span>
        </button>)}
        {project.providers.includes('deepseek') && <button type="button" className="agent-card ios-press" onClick={onOpenChat}>
          <span className="home-icon tone-slate agent-mark" aria-hidden="true"><StudioBrandMark brand="deepseek" size={24} /></span>
          <span className="agent-card-text"><strong>DeepSeek</strong><small>项目对话 · API</small></span>
        </button>}
        {project.workspacePath && <button type="button" className="agent-card ios-press" onClick={() => setTerminalOpen(true)}>
          <span className="home-icon tone-stone agent-mark" aria-hidden="true"><IconTerminal2 size={22} strokeWidth={1.6} /></span>
          <span className="agent-card-text"><strong>终端</strong><small>本机 · 项目目录</small></span>
        </button>}
      </div>
      {project.workspacePath && <p className="ios-section-footer">「终端」在项目目录打开这台电脑的命令行，可以直接输入 sudo 密码；关掉后 30 分钟内再打开会回到同一个会话。</p>}
      {!project.workspacePath && agents.length > 0 && <p className="ios-section-footer">在「设置」里填写项目目录后，即可在该目录里启动 Claude Code / Codex。</p>}
      {error && <p className="studio-feedback error" role="alert">{error}</p>}
    </section>

    {agents.length > 0 && <section className="ios-section">
      <div className="ios-section-header"><h2>项目会话</h2>
        <button type="button" className="icon-button" title="刷新会话" aria-label="刷新会话" onClick={() => void load()}><IconRefresh size={18} aria-hidden="true" /></button></div>
      <div className="ios-list">
        {sessions.map(session => <Link className="ios-row" key={session.id} to={sessionHref(session.id)}>
          <span className={`home-icon small tone-${AGENTS.find(agent => agent.id === session.provider)?.tone ?? 'stone'}`} aria-hidden="true">{(brand => brand ? <StudioBrandMark brand={brand} size={18} /> : '·')(AGENTS.find(agent => agent.id === session.provider)?.brand)}</span>
          <span className="ios-row-body"><strong>{session.title}</strong><small>{nameOf(session.provider)}</small></span>
          <IconChevronRight size={18} className="chevron" aria-hidden="true" />
        </Link>)}
        {!sessions.length && <div className="ios-row no-icon"><span className="ios-row-body"><small>还没有在这个目录里的会话</small></span></div>}
      </div>
      <p className="ios-section-footer">会话在这台电脑上运行，工作目录是项目目录；它们使用你已登录的 Claude / Codex 订阅。</p>
    </section>}
    {terminalOpen && <Suspense fallback={terminalFallback}>
      <StudioTerminalCover mode="local" project={project} onClose={() => setTerminalOpen(false)} />
    </Suspense>}
  </div>;
}
