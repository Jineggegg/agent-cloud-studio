import os from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';

import { getConnection, projectsDb } from '@/modules/database/index.js';
import { createProject } from '@/modules/projects/index.js';
import { providerRuntimeService, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';

import { createClaudeBuildRunner } from './build-runner.service.js';
import { createStudioBuildsService } from './builds.service.js';
import { createStudioBuildsRouter } from './builds.routes.js';
import type { createProjectHubService } from './project-hub.service.js';

/**
 * Used by studio.module to mount `/api/studio/builds`: App Store-style AI builds made with Claude Code.
 *
 * Environment:
 * - STUDIO_BUILDS_ROOT: absolute folder new projects are created in (default ~/projects; must be inside the
 *   home directory, where the IDE accepts projects).
 * - STUDIO_BUILDS_MAX_PARALLEL: builds that run at once (default 2); later ones wait as 排队中.
 * - STUDIO_BUILD_MODEL / STUDIO_BUILD_EFFORT: optional Claude model and effort for build turns (default: the
 *   Claude runtime's default model).
 * The permission policy for these unattended turns is documented in build-runner.service.ts.
 */
export function createStudioBuildsRoutes(hub: ReturnType<typeof createProjectHubService>) {
  const runner = createClaudeBuildRunner({
    runtime: providerRuntimeService,
    runTurn: runDetachedChatTurn,
    getRun: sessionId => chatRunRegistry.getRun(sessionId),
    completeRun: (sessionId, options) => chatRunRegistry.completeRun(sessionId, options),
    readHistory: async sessionId => (await sessionsService.fetchHistory(sessionId)).messages,
    model: process.env.STUDIO_BUILD_MODEL?.trim() || undefined,
    effort: process.env.STUDIO_BUILD_EFFORT?.trim() || undefined,
  });
  const builds = createStudioBuildsService({
    database: getConnection(),
    root: process.env.STUDIO_BUILDS_ROOT?.trim() || path.join(os.homedir(), 'projects'),
    hub,
    // A build folder is brand new, so it is either registered already (a retried request) or registered now.
    async resolveWorkspace(directory) {
      const canonical = realpathSync(directory);
      const existing = projectsDb.getProjectPath(canonical);
      if (existing) return { projectId: existing.project_id, path: canonical };
      const result = await createProject({ projectPath: canonical });
      return { projectId: result.project.projectId, path: result.project.path };
    },
    createSession: (workspacePath, title) => sessionsService.createAppSession('claude', workspacePath, title),
    runner,
    maxParallel: Number(process.env.STUDIO_BUILDS_MAX_PARALLEL ?? 2),
  });
  return createStudioBuildsRouter(builds);
}
