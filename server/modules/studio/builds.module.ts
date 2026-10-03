import { execFileSync } from 'node:child_process';
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
// A git user.name or user.email value usable as an environment variable: one line, no control characters.
const IDENTITY_VALUE = /^[^\p{Cc}]{1,200}$/u;

/**
 * The owner's git identity (user.name and user.email from their global configuration), read once here, outside
 * the sandbox, because sandboxed commands cannot read ~/.gitconfig. Null when either is unset or unusable.
 */
function readGitIdentity(): { name: string; email: string } | null {
  const read = (key: string) => {
    try {
      return execFileSync('git', ['config', '--global', '--get', key], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  const name = read('user.name');
  const email = read('user.email');
  return IDENTITY_VALUE.test(name) && IDENTITY_VALUE.test(email) ? { name, email } : null;
}

/**
 * Used by studio.module to mount `/api/studio/builds`: App Store-style AI builds made with Claude Code.
 *
 * Environment:
 * - STUDIO_BUILDS_ROOT: absolute folder new projects are created in (default ~/projects); it must be inside the
 *   home directory, where the IDE accepts projects, or starting a build fails with a configuration error.
 * - STUDIO_BUILDS_MAX_PARALLEL: builds that run at once (default 2); later ones wait as 排队中.
 * - STUDIO_BUILD_MODEL / STUDIO_BUILD_EFFORT: optional Claude model and effort for build turns (default: the
 *   Claude runtime's default model).
 * - STUDIO_BUILD_SANDBOX=on: run builds in Claude Code's OS sandbox when it is available. Strictly opt-in (exactly
 *   `on`): any other value, and none, means restricted mode, until the owner has run the sandbox checks in
 *   docs/ai-builds.md on this machine.
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
    environment: () => detectBuildEnvironment(process.env.STUDIO_BUILD_SANDBOX === 'on'),
    gitIdentity: readGitIdentity(),
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
    const next = environment.missing.length
      ? `; for sandboxed builds install ${environment.missing.join(' and ')} (sudo apt-get install -y bubblewrap socat), run the sandbox checks in docs/ai-builds.md, then set STUDIO_BUILD_SANDBOX=on`
      : environment.available ? '; the OS sandbox is available but off: run the sandbox checks in docs/ai-builds.md, then set STUDIO_BUILD_SANDBOX=on' : '';
    console.warn(`[studio-builds] AI builds run in restricted mode (no installs, no tests)${next}`);
  }
  return createStudioBuildsRouter(builds);
}
