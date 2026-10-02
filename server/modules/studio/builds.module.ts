import os from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';

import { getConnection, projectsDb } from '@/modules/database/index.js';
import { createProject } from '@/modules/projects/index.js';
import { providerRuntimeService, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';

import { createClaudeBuildRunner, detectBuildEnvironment } from './build-runner.service.js';
import { createStudioBuildsService } from './builds.service.js';
import { createStudioBuildsRouter } from './builds.routes.js';
import type { createProjectHubService } from './project-hub.service.js';

// A registry host name such as registry.npmmirror.com (no scheme, port or path).
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * Used by studio.module to mount `/api/studio/builds`: App Store-style AI builds made with Claude Code.
 *
 * Environment:
 * - STUDIO_BUILDS_ROOT: absolute folder new projects are created in (default ~/projects); it must be inside the
 *   home directory, where the IDE accepts projects, or starting a build fails with a configuration error.
 * - STUDIO_BUILDS_MAX_PARALLEL: builds that run at once (default 2); later ones wait as 排队中.
 * - STUDIO_BUILD_MODEL / STUDIO_BUILD_EFFORT: optional Claude model and effort for build turns (default: the
 *   Claude runtime's default model).
 * - STUDIO_BUILD_SANDBOX=off: run builds in restricted mode even when the OS sandbox is available (an escape hatch
 *   for a machine where bubblewrap is installed but cannot start).
 * - STUDIO_BUILD_EXTRA_DOMAINS: comma-separated registry hosts sandboxed builds may reach besides npm and PyPI
 *   (for example a registry mirror).
 * The permission policy for these unattended turns is documented in build-runner.service.ts and docs/ai-builds.md.
 */
export function createStudioBuildsRoutes(hub: ReturnType<typeof createProjectHubService>) {
  const home = os.homedir();
  const root = process.env.STUDIO_BUILDS_ROOT?.trim() || path.join(home, 'projects');
  const extraDomains = (process.env.STUDIO_BUILD_EXTRA_DOMAINS ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
  const invalidDomains = extraDomains.filter(entry => !HOST_NAME.test(entry));
  if (invalidDomains.length) console.warn(`[studio-builds] ignoring invalid STUDIO_BUILD_EXTRA_DOMAINS entries: ${invalidDomains.join(', ')}`);
  const runner = createClaudeBuildRunner({
    runtime: providerRuntimeService,
    runTurn: runDetachedChatTurn,
    getRun: sessionId => chatRunRegistry.getRun(sessionId),
    completeRun: (sessionId, options) => chatRunRegistry.completeRun(sessionId, options),
    readHistory: async sessionId => (await sessionsService.fetchHistory(sessionId)).messages,
    model: process.env.STUDIO_BUILD_MODEL?.trim() || undefined,
    effort: process.env.STUDIO_BUILD_EFFORT?.trim() || undefined,
    environment: () => (process.env.STUDIO_BUILD_SANDBOX?.trim() === 'off' ? { mode: 'restricted', missing: [] } : detectBuildEnvironment()),
    home,
    extraDomains: extraDomains.filter(entry => HOST_NAME.test(entry)),
  });
  const builds = createStudioBuildsService({
    database: getConnection(),
    root,
    home,
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
  const fromHome = path.relative(home, path.resolve(root));
  if (fromHome === '..' || fromHome.startsWith(`..${path.sep}`) || path.isAbsolute(fromHome)) {
    console.warn(`[studio-builds] STUDIO_BUILDS_ROOT (${root}) is outside the home directory; starting a build will fail until it is moved inside ${home}`);
  }
  const environment = runner.environment();
  if (environment.mode === 'restricted') {
    console.warn(`[studio-builds] AI builds run in restricted mode (no installs, no tests)${environment.missing.length
      ? `; install ${environment.missing.join(' and ')} for sandboxed builds: sudo apt-get install -y bubblewrap socat` : ''}`);
  }
  return createStudioBuildsRouter(builds);
}
