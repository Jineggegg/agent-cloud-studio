import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, FolderGit2, Plus, X } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import type { HubProject } from '@/shared/types';
import { StudioProjectEditor } from '@/modules/studio/StudioProjectEditor';
import '@/modules/studio/project-hub.css';

/** Used by StudioPage to display the editable project tree while leaving SNR in its existing independent view. */
export function StudioProjectOverview() {
  // The saved server-side tree follows the signed-in user between devices.
  const [projects, setProjects] = useState<HubProject[]>([]);
  // Creating a project is a focused inline form, never a filesystem operation.
  const [creating, setCreating] = useState(false);
  // Loading errors are visible without blocking SNR or the rest of Studio.
  const [error, setError] = useState('');
  // Loading is distinct from an empty project collection.
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void api.studio.projects.list().then(readApiJson<HubProject[]>).then(data => { if (active) setProjects(data); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '项目加载失败'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  return <section aria-labelledby="hub-projects-heading" className="hub-overview">
    <div className="studio-section-heading"><h2 id="hub-projects-heading">自定义项目</h2>
      <button className="icon-button" aria-label={creating ? '关闭新建项目' : '新建项目'} title={creating ? '关闭新建项目' : '新建项目'} onClick={() => setCreating(!creating)}>{creating ? <X size={19} /> : <Plus size={19} />}</button>
    </div>
    {loading && <p role="status" className="hub-status">正在加载项目…</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {projects.map(project => <Link className="studio-project-row hub-project-link" key={project.id} to={`/projects/${project.id}`}>
      <span className="project-square"><FolderGit2 size={23} /></span><div><h3>{project.name}</h3>
        <p>{project.description || project.providers.map(value => value === 'claude' ? 'Claude' : 'GPT / Codex').join(' · ')}</p>
        <div className="hub-module-labels">{project.modules.map(module => <span key={module}>{module === 'agents' ? '助手' : module === 'mail' ? '邮箱' : '自动化'}</span>)}</div>
      </div><ChevronRight size={20} aria-hidden="true" />
    </Link>)}
    {creating && <StudioProjectEditor onCancel={() => setCreating(false)} onSaved={value => { setProjects([value, ...projects]); setCreating(false); }} />}
  </section>;
}
