import { memo } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

import ProjectEffects from '@/modules/project-workspace/controllers/ProjectEffects';
import type { ProjectWorkspaceShellProps } from '@/shared/types';
import ProjectCommandPalette from '@/modules/project-workspace/ProjectCommandPalette';
import ProjectMainRegion from '@/modules/project-workspace/ProjectMainRegion';
import ProjectQuickSettingsRegion from '@/modules/project-workspace/ProjectQuickSettingsRegion';
import ProjectSidebarRegion from '@/modules/project-workspace/ProjectSidebarRegion';

/** Rendered by ProjectWorkspaceRoute to lay out the workspace sidebar, main region and global overlays. */
function ProjectWorkspaceShell({
  isMobile,
  ws,
  sendMessage,
  navigate,
}: ProjectWorkspaceShellProps) {
  return (
    <div
      className="fixed inset-0 flex flex-col bg-background"
      style={{ bottom: 'var(--keyboard-height, 0px)' }}
    >
      <header
        className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3"
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        <Link
          to="/"
          className="flex min-h-[44px] items-center gap-2 rounded-md px-2 text-sm font-medium text-foreground hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          title="返回 Studio"
        >
          <ArrowLeft size={18} aria-hidden="true" />
          返回 Studio
        </Link>
        <span className="truncate text-sm text-muted-foreground">开发工作区</span>
      </header>

      <div className="flex min-h-0 flex-1">
        <ProjectEffects />
        <ProjectSidebarRegion isMobile={isMobile} />

        <div className="flex min-w-0 flex-1 flex-col">
          <ProjectMainRegion
            isMobile={isMobile}
            ws={ws}
            sendMessage={sendMessage}
            navigate={navigate}
          />
        </div>

        <ProjectCommandPalette />
        {/* Last flex child on purpose: when pinned it docks to the right of the main region. */}
        <ProjectQuickSettingsRegion />
      </div>
    </div>
  );
}

export default memo(ProjectWorkspaceShell);
