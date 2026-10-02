import { memo, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { NavigateFunction, NavigateOptions, To } from 'react-router-dom';

import { PaletteOpsProvider } from '@/modules/command-palette';
import { ProjectsStateProvider } from '@/modules/project-workspace/context/ProjectsStateContext';
import {
  SessionProtectionProvider,
  useSessionProtectionActions,
} from '@/shared/context/SessionProtectionContext';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import { useVisualViewportKeyboardOffset } from '@/shared/hooks/useVisualViewportKeyboardOffset';
import ProjectWorkspaceShell from '@/modules/project-workspace/ProjectWorkspaceShell';
import { WorkspaceProjectIntent } from '@/modules/project-workspace/controllers/WorkspaceProjectIntent';
import { WorkspaceProviders } from '@/shared/ui/WorkspaceProviders';

const MemoizedProjectWorkspaceRouteContent = memo(ProjectWorkspaceRouteContent);

// The IDE's controllers still navigate to "/" (to clear the session) and "/session/:id"; both stay inside
// its hidden fallback routes instead of leaving for the Studio home or the workbench.
function toLegacyPath(path: string) {
  if (path === '/') return '/legacy/workspace';
  if (path.startsWith('/session/')) return `/legacy${path}`;
  return path;
}

/**
 * This module's only public export: rendered lazily by App for the hidden fallback routes
 * "/legacy/workspace" and "/legacy/session/:sessionId" (the workbench at /work replaced it; nothing links
 * here). It owns the IDE-wide providers so the Studio home screen never loads or runs them.
 */
export default function ProjectWorkspaceRoute() {
  return (
    <WorkspaceProviders>
      <SessionProtectionProvider>
        <PaletteOpsProvider>
          <MemoizedProjectWorkspaceRouteContent />
        </PaletteOpsProvider>
      </SessionProtectionProvider>
    </WorkspaceProviders>
  );
}

function ProjectWorkspaceRouteContent() {
  const routerNavigate = useNavigate();
  // Legacy workspace controllers use "/" to clear a session, not to leave the IDE.
  const navigate = useCallback<NavigateFunction>((to: To | number, options?: NavigateOptions) => {
    if (typeof to === 'number') return routerNavigate(to);
    const destination = typeof to === 'string'
      ? toLegacyPath(to)
      : to.pathname ? { ...to, pathname: toLegacyPath(to.pathname) } : to;
    routerNavigate(destination, options);
  }, [routerNavigate]);
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, subscribe } = useWebSocket();
  const { isSessionProcessing } = useSessionProtectionActions();

  useVisualViewportKeyboardOffset();

  return (
    <ProjectsStateProvider
      sessionId={sessionId}
      navigate={navigate}
      subscribe={subscribe}
      isMobile={isMobile}
      isSessionProcessing={isSessionProcessing}
    >
      <WorkspaceProjectIntent />
      <ProjectWorkspaceShell
        isMobile={isMobile}
        ws={ws}
        sendMessage={sendMessage}
        navigate={navigate}
      />
    </ProjectsStateProvider>
  );
}
