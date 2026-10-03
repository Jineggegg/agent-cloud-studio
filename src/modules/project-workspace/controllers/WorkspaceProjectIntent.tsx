import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

import { OFFERED_AGENT_PROVIDERS } from '@/shared/constants';
import { writeSelectedProvider } from '@/shared/selectedProvider';
import type { LLMProvider } from '@/shared/types';
import { useProjectSidebarState, useProjectCommandState } from '@/modules/project-workspace/context/ProjectsStateContext';

// The agents Studio offers; a deep link naming Cursor or OpenCode (both hidden) is ignored.
const AGENTS: readonly LLMProvider[] = OFFERED_AGENT_PROVIDERS;

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
    if (!projectId || !AGENTS.includes(provider as LLMProvider) || consumed.current === intent) return;
    const project = sidebarSharedProps.projects.find(item => item.projectId === projectId);
    if (!project) return;
    consumed.current = intent;
    writeSelectedProvider(provider as LLMProvider);
    handleNewSession(project);
  }, [projectId, provider, sidebarSharedProps.projects, handleNewSession]);
  return null;
}
