import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

import { writeSelectedProvider } from '@/shared/selectedProvider';
import { useProjectSidebarState, useProjectCommandState } from '@/modules/project-workspace/context/ProjectsStateContext';

/** Used by ProjectWorkspaceRoute to consume Studio's explicit project/provider deep link once native projects are loaded. */
export function WorkspaceProjectIntent() {
  const [params] = useSearchParams();
  const { sidebarSharedProps } = useProjectSidebarState();
  const { handleNewSession } = useProjectCommandState();
  const consumed = useRef('');
  const projectId = params.get('projectId');
  const provider = params.get('provider');
  useEffect(() => {
    const intent = `${projectId}:${provider}`;
    if (!projectId || (provider !== 'claude' && provider !== 'codex') || consumed.current === intent) return;
    const project = sidebarSharedProps.projects.find(item => item.projectId === projectId);
    if (!project) return;
    consumed.current = intent;
    writeSelectedProvider(provider);
    handleNewSession(project);
  }, [projectId, provider, sidebarSharedProps.projects, handleNewSession]);
  return null;
}
