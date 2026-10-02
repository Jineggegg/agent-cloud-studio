import type { StudioWorkbenchHubLink } from '@/shared/types.js';

// The fields of a hub project the workbench needs to find its IDE project.
type WorkbenchHubProject = { id: string; workspacePath: string; remoteHost: string };

type WorkbenchServiceDeps = {
  // The signed-in user's hub projects (project-hub.service `list`).
  listHubProjects: (userId: number) => WorkbenchHubProject[];
  // The IDE project id registered for a directory, or null. Must never register a new project.
  findProjectId: (directory: string) => string | null;
};

/**
 * Used by studio.module behind /api/studio/workbench: tells the workbench and the project app which IDE
 * project each local hub project lives in. Read-only: unlike `launch`, it never registers a directory.
 */
export function createWorkbenchService(deps: WorkbenchServiceDeps) {
  return {
    hubLinks(userId: number): StudioWorkbenchHubLink[] {
      return deps.listHubProjects(userId)
        .filter(project => !project.remoteHost && project.workspacePath)
        .map(project => {
          // A directory that vanished or cannot be resolved only means "not linked yet", never a failed list.
          let projectId: string | null = null;
          try { projectId = deps.findProjectId(project.workspacePath); } catch { projectId = null; }
          return { hubId: project.id, projectId };
        });
    },
  };
}
