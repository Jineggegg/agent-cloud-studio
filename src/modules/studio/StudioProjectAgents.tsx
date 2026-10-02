import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronRight, LoaderCircle, MessagesSquare, RefreshCw } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { writeSelectedProvider } from '@/shared/selectedProvider';
import type { HubAgentProvider, HubProject, HubSession } from '@/shared/types';

// IDE agents in display order, with their muted brand-adjacent tones.
const AGENTS: { id: HubAgentProvider; name: string; caption: string; tone: string; mark: string }[] = [
  { id: 'claude', name: 'Claude Code', caption: 'Claude 订阅', tone: 'clay', mark: 'C' },
  { id: 'codex', name: 'Codex', caption: 'ChatGPT 订阅', tone: 'graphite', mark: 'O' },
  { id: 'cursor', name: 'Cursor', caption: 'Cursor Agent', tone: 'slate', mark: 'Cu' },
  { id: 'opencode', name: 'OpenCode', caption: 'OpenCode', tone: 'stone', mark: 'Oc' },
];

/** Used by StudioPage's project app to start an IDE agent inside the project directory or open its DeepSeek chat. */
export function StudioProjectAgents({ project, onOpenChat }: { project: HubProject; onOpenChat: () => void }) {
  const navigate = useNavigate();
  // Only existing sessions returned for this project's directory are displayed.
  const [sessions, setSessions] = useState<HubSession[]>([]);
  // Errors from loading or opening a workspace remain visible and never imply a running model.
  const [error, setError] = useState('');
  // The agent whose workspace is being registered; blocks duplicate launches.
  const [launching, setLaunching] = useState<HubAgentProvider | null>(null);
  const load = useCallback(async () => {
    try { setSessions(await readApiJson<HubSession[]>(await api.studio.projects.sessions(project.id))); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '会话加载失败'); }
  }, [project.id]);
  useEffect(() => { void load(); }, [load]);

  async function launch(provider: HubAgentProvider) {
    setLaunching(provider); setError('');
    try {
      const result = await readApiJson<{ url: string }>(await api.studio.projects.launch(project.id, provider));
      // The IDE reads the provider once when its chat mounts, so it must be chosen before navigating.
      writeSelectedProvider(provider);
      navigate(result.url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '工作区打开失败'); }
    finally { setLaunching(null); }
  }
  const agents = AGENTS.filter(agent => project.providers.includes(agent.id));
  const nameOf = (provider: string) => AGENTS.find(agent => agent.id === provider)?.name ?? provider;

  return <div className="studio-stagger">
    <section className="ios-section first">
      <div className="ios-section-header"><h2>在本项目中开始</h2><span className="caption mono">{project.workspacePath || '未设置目录'}</span></div>
      <div className="agent-grid">
        {agents.map(agent => <button type="button" key={agent.id} className="agent-card ios-press" disabled={launching !== null || !project.workspacePath} onClick={() => void launch(agent.id)}>
          <span className={`home-icon tone-${agent.tone} agent-mark`} aria-hidden="true">{launching === agent.id ? <LoaderCircle size={22} className="spin" /> : agent.mark}</span>
          <span className="agent-card-text"><strong>{agent.name}</strong><small>{agent.caption}</small></span>
        </button>)}
        {project.providers.includes('deepseek') && <button type="button" className="agent-card ios-press" onClick={onOpenChat}>
          <span className="home-icon tone-slate agent-mark" aria-hidden="true"><MessagesSquare size={22} strokeWidth={1.6} /></span>
          <span className="agent-card-text"><strong>DeepSeek</strong><small>项目对话 · API</small></span>
        </button>}
      </div>
      {!project.workspacePath && agents.length > 0 && <p className="ios-section-footer">在「设置」里填写项目目录后，即可在该目录里启动 Claude Code / Codex。</p>}
      {error && <p className="studio-feedback error" role="alert">{error}</p>}
    </section>

    {agents.length > 0 && <section className="ios-section">
      <div className="ios-section-header"><h2>项目会话</h2>
        <button type="button" className="icon-button" title="刷新会话" aria-label="刷新会话" onClick={() => void load()}><RefreshCw size={18} aria-hidden="true" /></button></div>
      <div className="ios-list">
        {sessions.map(session => <Link className="ios-row" key={session.id} to={`/session/${encodeURIComponent(session.id)}`}>
          <span className={`home-icon small tone-${AGENTS.find(agent => agent.id === session.provider)?.tone ?? 'stone'}`} aria-hidden="true">{AGENTS.find(agent => agent.id === session.provider)?.mark ?? '·'}</span>
          <span className="ios-row-body"><strong>{session.title}</strong><small>{nameOf(session.provider)}</small></span>
          <ChevronRight size={18} className="chevron" aria-hidden="true" />
        </Link>)}
        {!sessions.length && <div className="ios-row no-icon"><span className="ios-row-body"><small>还没有在这个目录里的会话</small></span></div>}
      </div>
      <p className="ios-section-footer">会话在这台电脑上运行，工作目录是项目目录；它们使用你已登录的 Claude / Codex 订阅。</p>
    </section>}
  </div>;
}
