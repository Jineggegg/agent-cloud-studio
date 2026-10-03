import path from 'node:path';
import os from 'node:os';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

import { readRequestClient, verifyStepUpPassword } from '@/modules/auth/index.js';
import { getConnection, getDatabasePath, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { createProject } from '@/modules/projects/index.js';
import { readCodexAccountRateLimits } from '@/modules/providers/index.js';
import { scheduledMessagesService } from '@/modules/scheduled-messages/index.js';
import { AppError, readStudioIngressOrigins } from '@/shared/utils.js';

import { createStudioService } from './studio.service.js';
import { createStudioRouter } from './studio.routes.js';
import { createSnrGateway } from './snr-gateway.service.js';
import { createSnrGatewayRouter } from './snr-gateway.routes.js';
import { createProjectHubService } from './project-hub.service.js';
import { createProjectMailService } from './project-mail.service.js';
import { createProjectHubRouter, createProjectMailCallbackRouter } from './project-hub.routes.js';
import { createMailService } from './mail/mail.service.js';
import { createMailRouter } from './mail/mail.routes.js';
import { createTrading212Service } from './trading212.service.js';
import { createTrading212Router } from './trading212.routes.js';
import { createTrading212OrdersService } from './trading212-orders.service.js';
import { createTrading212OrdersRouter } from './trading212-orders.routes.js';
import { createLinkChecker } from './link-check.service.js';
import { createStudioBuildsRoutes } from './builds.module.js';
import { createRemoteHostsService } from './remote-hosts.service.js';
import { createRemoteHostsRouter } from './remote-hosts.routes.js';
import { createGhRunner, resolveGhPath } from './github/github-cli.adapter.js';
import { createGitHubService } from './github/github.service.js';
import { createGitHubRouter } from './github/github.routes.js';
import { createStudioNetworkService } from './network.service.js';
import { createStudioNetworkRouter } from './network.routes.js';
import { createQuotaService } from './quota/quota.service.js';
import { createQuotaRouter } from './quota/quota.routes.js';
import { createWorkbenchService } from './workbench.service.js';
import { createWorkbenchRouter } from './workbench.routes.js';
import { createMemoryMcpClient } from './memory/memory-client.adapter.js';
import { createMemoryService, findWindowsHome, memoryFolderName } from './memory/memory.service.js';
import { createMemoryChatBridge } from './memory/memory-chat.service.js';
import { createMemoryRouter } from './memory/memory.routes.js';
import { createStudioRuntimeService } from './runtime.service.js';
import { createStudioRuntimeRouter } from './runtime.routes.js';

const linkChecker = createLinkChecker();

// An explicit env path wins; otherwise a conventional checkout under ~/projects is used when it exists.
function defaultWorkspace(variable: string, folder: string) {
  const configured = process.env[variable];
  if (configured) return configured;
  const candidate = path.join(os.homedir(), 'projects', folder);
  return existsSync(candidate) ? candidate : '';
}

// "label=url; label=url" from env, e.g. STUDIO_SUPER_PROFESSOR_LINKS. Malformed entries are skipped with a warning,
// because the hub validates seeds strictly and one bad link would otherwise block seeding every built-in project.
function linksFromEnv(variable: string) {
  const links = (process.env[variable] ?? '').split(';').map(entry => entry.trim()).filter(Boolean).map(entry => {
    const split = entry.indexOf('=');
    return { label: split > 0 ? entry.slice(0, split).trim() : '', url: split > 0 ? entry.slice(split + 1).trim() : '' };
  });
  const valid = links.filter(link => {
    if (!link.label || link.label.length > 40 || !link.url || link.url.length > 500) return false;
    try { return ['http:', 'https:'].includes(new URL(link.url).protocol); } catch { return false; }
  }).slice(0, 8);
  if (valid.length !== links.length) console.warn(`[studio] ${variable}: skipped ${links.length - valid.length} invalid link(s)`);
  return valid;
}

/** Used by server/index to assemble Studio independently of the inherited CLI providers. */
export function createStudioModule() {
  const vaultDirectory = path.join(path.dirname(getDatabasePath()), 'studio-vault');
  const gateway = createSnrGateway({
    baseUrl: process.env.STUDIO_SNR_BASE_URL ?? 'http://127.0.0.1:8768',
    validUser: id => Boolean(userDb.getUserById(id)),
  });
  // SSH hosts the owner configured (STUDIO_SSH_HOSTS); projects can only point at these, and commands are built here.
  const remote = createRemoteHostsService({ hostsConfig: process.env.STUDIO_SSH_HOSTS });
  const hub = createProjectHubService({
    database: getConnection(),
    professorPath: defaultWorkspace('STUDIO_SUPER_PROFESSOR_PATH', 'super-professor'),
    snrPath: defaultWorkspace('STUDIO_SNR_PATH', 'snr3-lab'),
    trading212Path: defaultWorkspace('STUDIO_TRADING212_PATH', 'trading212'),
    professorLinks: linksFromEnv('STUDIO_SUPER_PROFESSOR_LINKS'),
    checkLinks: links => linkChecker.check(links),
    remoteHosts: () => remote.names(),
    remoteSeeds: () => remote.seeds(),
    remoteCommand: (host, dir, agent) => remote.command(host, dir, agent),
    async workbench() {
      const directory = process.env.STUDIO_WORKBENCH_PATH || path.join(os.homedir(), 'studio-workbench');
      await mkdir(directory, { recursive: true });
      return directory;
    },
    async resolveWorkspace(directory) {
      if (!existsSync(directory)) throw new AppError('工作目录不存在', { statusCode: 400 });
      const canonical = realpathSync(directory);
      const existing = projectsDb.getProjectPath(canonical);
      if (existing) {
        if (existing.isArchived) throw new AppError('请先在开发工具中恢复已归档的项目', { statusCode: 409 });
        return { projectId: existing.project_id, path: canonical };
      }
      const result = await createProject({ projectPath: canonical });
      return { projectId: result.project.projectId, path: result.project.path };
    },
    listSessions(directory) {
      if (!existsSync(directory)) return [];
      const canonical = realpathSync(directory);
      return (getConnection().prepare('SELECT session_id FROM sessions WHERE project_path = ? AND isArchived = 0 ORDER BY updated_at DESC LIMIT 100').all(canonical) as { session_id: string }[])
        .flatMap(({ session_id }) => {
          const session = sessionsDb.getSessionById(session_id);
          return session ? [{ id: session.session_id, provider: session.provider, title: session.custom_name ?? session.session_id.slice(0, 12) }] : [];
        });
    },
    pendingSchedules(userId, directory) {
      const canonical = existsSync(directory) ? realpathSync(directory) : path.resolve(directory);
      return scheduledMessagesService.listPending(userId).filter(job =>
        job.status === 'pending' && sessionsDb.getSessionById(job.sessionId)?.project_path === canonical,
      ).length;
    },
    schedule: input => scheduledMessagesService.schedule(input),
    forget(userId, projectId) {
      service.removeSpace(userId, `project:${projectId}`);
      mail.forget(projectId);
    },
  });
  const service = createStudioService({
    database: getConnection(),
    vaultDirectory,
    snrBaseUrl: process.env.STUDIO_SNR_BASE_URL,
    agentWorkbenchUrl: process.env.STUDIO_AGENT_WORKBENCH_URL,
    deepseekKeyFile: process.env.STUDIO_DEEPSEEK_ENV_FILE || undefined,
    project(userId, id) {
      try { return hub.get(userId, id); } catch { return null; }
    },
  });
  const mail = createProjectMailService({
    database: getConnection(),
    vaultDirectory,
    project: hub.get,
    clientId: process.env.STUDIO_GMAIL_CLIENT_ID,
    clientSecret: process.env.STUDIO_GMAIL_CLIENT_SECRET,
    // Both front doors, validated without throwing: a malformed origin disables Gmail, not the server.
    doors: () => readStudioIngressOrigins(process.env),
  });
  const trading212 = createTrading212Service({
    database: getConnection(),
    envFiles: { live: process.env.STUDIO_T212_ENV_FILE || undefined, demo: process.env.STUDIO_T212_DEMO_ENV_FILE || undefined },
  });
  trading212.startSnapshots(Number(process.env.STUDIO_T212_SNAPSHOT_MINUTES ?? 30));
  const quota = createQuotaService({
    deepseekKey: userId => service.deepseekApiKey(userId),
    codexRateLimits: () => readCodexAccountRateLimits(),
  });
  const routes = createStudioRouter(service, gateway);
  routes.use('/runtime', createStudioRuntimeRouter(createStudioRuntimeService()));
  routes.use('/projects', createProjectHubRouter(hub, mail));
  routes.use('/trading212', createTrading212Router(trading212));
  routes.use('/remote', createRemoteHostsRouter(remote));
  routes.use('/quota', createQuotaRouter(quota));
  // ── v4 track: network — create its service and mount its router below this line ──
  // Both front doors (STUDIO_PUBLIC_ORIGIN, STUDIO_TAILNET_ORIGIN) reach this one backend.
  routes.use('/network', createStudioNetworkRouter(createStudioNetworkService()));
  // ── v4 track: orders — create its service and mount its router below this line ──
  // Caps (per order and per rolling 24 hours) default to the env values, are edited per user in Settings (raising needs
  // Face ID / Touch ID) and never exceed STUDIO_T212_CAP_CEILING.
  // Order placement is off unless STUDIO_T212_TRADING allows an account; each user's trading mode (Settings, adding an
  // account needs Face ID / Touch ID) narrows it further. Each order is capped and needs a passkey (or,
  // only while the user has none, a double confirmation). Only requests from these origins may trade; localhost only
  // with STUDIO_T212_ALLOW_LOCALHOST=1. Passkey changes are stepped up with the Studio account password, through
  // the auth module's step-up (its per-session budget, daily per-user cap and security log apply).
  const trading212Orders = createTrading212OrdersService({
    database: getConnection(),
    trading212,
    trading: process.env.STUDIO_T212_TRADING,
    maxOrderValue: process.env.STUDIO_T212_MAX_ORDER_VALUE,
    maxDailyValue: process.env.STUDIO_T212_MAX_DAILY_VALUE,
    capCeiling: process.env.STUDIO_T212_CAP_CEILING,
    requirePasskey: process.env.STUDIO_T212_REQUIRE_PASSKEY,
    allowLocalhost: process.env.STUDIO_T212_ALLOW_LOCALHOST,
    origins: [process.env.STUDIO_PUBLIC_ORIGIN, process.env.STUDIO_TAILNET_ORIGIN],
    verifyStepUp: ({ user, client }, password) => verifyStepUpPassword(user, password, client),
  });
  routes.use('/trading212', createTrading212OrdersRouter(trading212Orders, (req) => readRequestClient(req)));
  // ── v4 track: mail — create its service and mount its router below this line ──
  // Per-user read-only mail accounts (Gmail over IMAP, Outlook over Graph). Project-bound Gmail OAuth
  // connections from the older project mail module appear as extra accounts in the same inbox.
  const mailAccounts = createMailService({
    database: getConnection(),
    vaultDirectory,
    outlookClientId: process.env.STUDIO_OUTLOOK_CLIENT_ID?.trim() || undefined,
    legacyGmail: {
      accounts: userId => hub.list(userId).filter(item => item.modules.includes('mail')).flatMap(item => {
        try {
          const status = mail.status(userId, item.id);
          return status.connected && status.email ? [{ projectId: item.id, projectName: item.name, email: status.email }] : [];
        } catch { return []; }
      }),
      search: (userId, projectId, query) => mail.search(userId, projectId, query),
      message: (userId, projectId, messageId) => mail.message(userId, projectId, messageId),
      forget(userId, projectId) {
        hub.get(userId, projectId);
        mail.forget(projectId);
      },
    },
  });
  routes.use('/mail', createMailRouter(mailAccounts));
  // ── v6 track: shell — create its service and mount its router below this line ──
  // The workbench (/work) asks which IDE project each local hub project lives in; looking it up never registers one.
  const workbench = createWorkbenchService({
    listHubProjects: userId => hub.list(userId),
    findProjectId(directory) {
      if (!existsSync(directory)) return null;
      const row = projectsDb.getProjectPath(realpathSync(directory));
      return row && !row.isArchived ? row.project_id : null;
    },
  });
  routes.use('/workbench', createWorkbenchRouter(workbench));
  // ── v6 track: chat — create its service and mount its router below this line ──
  // ── v6 track: github — create its service and mount its router below this line ──
  // The owner's GitHub through the gh CLI already signed in on this machine (gh keeps the token; Studio never reads
  // it). STUDIO_GH_PATH points at gh when it is not in ~/.local/bin, /usr/local/bin, /usr/bin or on PATH.
  const github = createGitHubService({
    database: getConnection(),
    run: createGhRunner({ ghPath: resolveGhPath(process.env.STUDIO_GH_PATH) }),
  });
  routes.use('/github', createGitHubRouter(github));
  // ── v6 track: builder — create its service and mount its router below this line ──
  // App Store-style AI builds: a new ~/projects folder, a hub project (the icon) and an unattended Claude Code
  // session per build (STUDIO_BUILDS_ROOT, STUDIO_BUILDS_MAX_PARALLEL, STUDIO_BUILD_MODEL; see builds.module.ts).
  routes.use('/builds', createStudioBuildsRoutes(hub));
  // ── v6 track: memory — create its service and mount its router below this line ──
  // One MCP session with the shared basic-memory server (scripts/wsl/install-memory.sh, docs/memory.md) serves the
  // 记忆 app and the DeepSeek bridge. STUDIO_MEMORY_URL overrides the endpoint; STUDIO_MEMORY_DEEPSEEK=0 keeps
  // DeepSeek replies away from memory. A hub project's notes live in the folder named after its workspace.
  // The status card also checks the Windows Claude Code and Codex apps: their home is found under /mnt/c/Users,
  // or named by STUDIO_MEMORY_WINDOWS_HOME (empty or 0 turns the Windows checks off).
  const memoryUrl = process.env.STUDIO_MEMORY_URL?.trim() || 'http://127.0.0.1:8770/mcp';
  const memoryOff = (value: string) => ['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
  const memoryForDeepseek = !memoryOff(process.env.STUDIO_MEMORY_DEEPSEEK ?? '');
  const memoryWindowsSetting = process.env.STUDIO_MEMORY_WINDOWS_HOME;
  const memoryWindowsHome = memoryWindowsSetting === undefined ? findWindowsHome()
    : memoryOff(memoryWindowsSetting) || !memoryWindowsSetting.trim() ? null : memoryWindowsSetting.trim();
  const memoryFolder = (item: { id: string; name: string; workspacePath: string; remoteDir: string }) =>
    memoryFolderName([item.workspacePath, item.remoteDir, item.name], item.id);
  const memory = createMemoryService({
    client: createMemoryMcpClient({ url: memoryUrl }),
    url: memoryUrl,
    deepseekEnabled: memoryForDeepseek,
    windowsHome: memoryWindowsHome,
    projects: userId => hub.list(userId).map(item => ({ id: item.id, name: item.name, tone: item.tone, glyph: item.glyph, folder: memoryFolder(item) })),
  });
  if (memoryForDeepseek) {
    service.attachMemory(createMemoryChatBridge({
      memory,
      scope(userId, space) {
        const projectId = /^project:(.+)$/.exec(space)?.[1];
        if (!projectId) return { folder: null, project: null };
        try {
          const project = hub.get(userId, projectId);
          return { folder: memoryFolder(project), project: project.name };
        } catch {
          return { folder: null, project: null };
        }
      },
    }));
  }
  routes.use('/memory', createMemoryRouter(memory));
  return {
    routes,
    snrRoutes: createSnrGatewayRouter(gateway),
    mailCallbackRoutes: createProjectMailCallbackRouter(mail),
    // Used by the server entrypoint when "退出所有设备" also drops the user's SNR access cookies.
    revokeSnrAccess: (userId: number) => gateway.revoke(userId),
  };
}
