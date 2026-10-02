import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Bot, CalendarClock, FolderGit2, Mail, Settings2 } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import type { HubProject } from '@/shared/types';
import { StudioProjectEditor } from '@/modules/studio/StudioProjectEditor';
import { StudioProjectAgents } from '@/modules/studio/StudioProjectAgents';
import { StudioProjectMail } from '@/modules/studio/StudioProjectMail';
import { StudioProjectTasks } from '@/modules/studio/StudioProjectTasks';
import '@/modules/studio/studio.css';
import '@/modules/studio/project-hub.css';

const VIEWS = [{ id: 'agents', label: '助手', icon: Bot }, { id: 'mail', label: '邮箱', icon: Mail }, { id: 'automations', label: '自动化', icon: CalendarClock }, { id: 'settings', label: '设置', icon: Settings2 }] as const;

/** Routed by App as the modular project workspace, independent from the protected SNR laboratory. */
export function StudioProjectPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  // The authoritative project controls which tabs can be visited.
  const [project, setProject] = useState<HubProject | null>(null);
  // Loading and failure are separate so missing projects never show an empty workspace.
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api.studio.projects.get(id).then(readApiJson<HubProject>).then(value => { if (active) { setProject(value); setError(''); } })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '项目加载失败'); });
    return () => { active = false; };
  }, [id]);
  const currentProject = project?.id === id ? project : null;
  const tabs = VIEWS.filter(view => view.id === 'settings' || currentProject?.modules.includes(view.id));
  const selected = tabs.find(view => view.id === params.get('view'))?.id ?? tabs[0]?.id ?? 'settings';
  return <div className="studio hub-shell">
    <main className="studio-main">
      <header className="hub-header"><Link to="/" className="hub-back" title="返回工作台"><ArrowLeft size={20} /><span>工作台</span></Link><span className="hub-header-context">自定义项目</span></header>
      <div className="hub-content">
        {error && <p role="alert" className="error">{error}</p>}
        {!currentProject && !error && <p role="status" className="hub-status">正在加载项目…</p>}
        {currentProject && <>
          <div className="hub-project-heading"><span className="project-square"><FolderGit2 size={25} /></span><div><h1>{currentProject.name}</h1>{currentProject.description && <p>{currentProject.description}</p>}</div></div>
          <nav className="hub-tabs" aria-label="项目模块">{tabs.map(({ id: view, label, icon: Icon }) => <button key={view} type="button" aria-current={selected === view ? 'page' : undefined} onClick={() => setParams({ view })}><Icon size={19} /><span>{label}</span></button>)}</nav>
          <div className="hub-panel" key={`${id}:${selected}`}>
            {selected === 'agents' && <StudioProjectAgents project={currentProject} />}
            {selected === 'mail' && <StudioProjectMail project={currentProject} />}
            {selected === 'automations' && <StudioProjectTasks project={currentProject} />}
            {selected === 'settings' && <StudioProjectEditor key={currentProject.updatedAt} project={currentProject} onSaved={setProject} />}
          </div>
        </>}
      </div>
    </main>
  </div>;
}
