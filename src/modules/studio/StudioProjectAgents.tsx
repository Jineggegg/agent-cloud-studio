import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, Bot, RefreshCw } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import type { HubProject, HubSession } from '@/shared/types';

/** Used by StudioProjectPage to open native Claude/Codex workspaces and display actual project sessions. */
export function StudioProjectAgents({ project }: { project: HubProject }) {
  const navigate = useNavigate();
  // Only existing sessions returned for this project's directory are displayed.
  const [sessions, setSessions] = useState<HubSession[]>([]);
  // Errors from loading or opening a workspace remain visible and never imply a running model.
  const [error, setError] = useState('');
  // Prevents duplicate workspace launches while registration is in flight.
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setSessions(await readApiJson<HubSession[]>(await api.studio.projects.sessions(project.id))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '会话加载失败'); }
  }, [project.id]);
  useEffect(() => { void load(); }, [load]);
  async function launch(provider: 'claude' | 'codex') {
    setBusy(true); setError('');
    try {
      const result = await readApiJson<{ url: string }>(await api.studio.projects.launch(project.id, provider));
      navigate(result.url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '工作区打开失败'); }
    finally { setBusy(false); }
  }
  return <section>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="hub-agents">{project.providers.map(provider => <div className="hub-agent" key={provider}>
      <span className={`connection-symbol ${provider}`}><Bot size={25} /></span>
      <div><h2>{provider === 'claude' ? 'Claude' : 'GPT / Codex'}</h2><p className="hub-status">{project.workspacePath ? '开发工作区' : '工作目录未设置'}</p></div>
      <button className="icon-button" disabled={busy || !project.workspacePath} aria-label={`打开 ${provider === 'claude' ? 'Claude' : 'GPT / Codex'}`} title="打开工作区" onClick={() => void launch(provider)}><ArrowUpRight size={21} /></button>
    </div>)}</div>
    <div className="studio-section-heading"><h2>项目会话</h2><button className="icon-button" title="刷新会话" aria-label="刷新会话" onClick={() => void load()}><RefreshCw size={18} /></button></div>
    {sessions.map(session => <Link className="hub-session-row" key={session.id} to={`/session/${encodeURIComponent(session.id)}`}>
      <Bot size={19} /><span>{session.title}</span><small>{session.provider === 'claude' ? 'Claude' : 'GPT / Codex'}</small><ArrowUpRight size={17} />
    </Link>)}
    {!sessions.length && <p className="hub-status" role="status">暂无项目会话</p>}
  </section>;
}
