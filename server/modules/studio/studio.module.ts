import path from 'node:path';
import os from 'node:os';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

import { maskClientAddress, readRequestClient, verifyStepUpPassword } from '@/modules/auth/index.js';
import { getConnection, getDatabasePath, projectsDb, sessionsDb, taskRunsDb, userDb } from '@/modules/database/index.js';
import {
  getStudioPushStatus, isSessionInView, notifyRunStopped, onSessionsViewed, sendStudioPushNotification,
} from '@/modules/notifications/index.js';
import { createProject } from '@/modules/projects/index.js';
import { providerRuntimeService, readCodexAccountRateLimits, sessionsService } from '@/modules/providers/index.js';
import { scheduledMessagesService } from '@/modules/scheduled-messages/index.js';
import { chatRunRegistry, connectedClients, WS_OPEN_STATE } from '@/modules/websocket/index.js';
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
import { createStudioAppRunner } from './app-runner.service.js';
import { createStudioAppGateway } from './app-gateway.service.js';
import { createStudioAppSiteRouter, createStudioAppsRouter } from './apps.routes.js';
import type { StudioAppLookup } from './apps.routes.js';
import { createRemoteHostsService } from './remote-hosts.service.js';
import { createRemoteHostsRouter } from './remote-hosts.routes.js';
import { createGhRunner, resolveGhPath } from './github/github-cli.adapter.js';
import { createGitHubService } from './github/github.service.js';
import { createGitHubRouter } from './github/github.routes.js';
import { createGitHubBranchService } from './github/github-branch.service.js';
import { createLocalRepoReader } from './github/git-local.adapter.js';
import { createStudioNetworkService } from './network.service.js';
import { createStudioNetworkRouter } from './network.routes.js';
import { createQuotaService } from './quota/quota.service.js';
import { createQuotaRouter } from './quota/quota.routes.js';
import { createWorkbenchService } from './workbench.service.js';
import { createWorkbenchRouter } from './workbench.routes.js';
import { createWorkbenchThreadsService } from './workbench-threads.service.js';
import { createWorkbenchActivityService } from './workbench-activity.service.js';
import { createPromptSuggester } from './prompt-suggestions.service.js';
import { createPromptSuggestionsRouter } from './prompt-suggestions.routes.js';
import { createMemoryMcpClient } from './memory/memory-client.adapter.js';
import { createMemoryService, findWindowsHome, memoryFolderName } from './memory/memory.service.js';
import { createMemoryChatBridge } from './memory/memory-chat.service.js';
import { createMemoryRouter } from './memory/memory.routes.js';
import { createStudioRuntimeService } from './runtime.service.js';
import { createStudioRuntimeRouter } from './runtime.routes.js';
import { createAutomationsService } from './automations/automations.service.js';
import { createAutomationsRouter } from './automations/automations.routes.js';
import { createAutomationDeepseekAdapter } from './automations/automation-deepseek.adapter.js';
import { createHarnessService } from './harness.service.js';
import { createHarnessRouter } from './harness.routes.js';

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
      automations.forgetProject(userId, projectId);
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
  routes.use('/trading212', createTrading212OrdersRouter(trading212Orders, (req) => readRequestClient(req), maskClientAddress));
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
  // ── automations: per-project automations described in plain words ──
  // Schedules (in the owner's time zone) or a failed AI build, plus an action that stays inside Studio: a read-only
  // digest of one connected mailbox (judged and summarised by DeepSeek when the owner has a key) or a Web Push to
  // the owner. A 30-second poll runs due schedules; nothing here sends mail or acts outside Studio.
  const automations = createAutomationsService({
    database: getConnection(),
    project: hub.get,
    mail: {
      accounts: userId => mailAccounts.accounts(userId),
      messages: (userId, input) => mailAccounts.messages(userId, input),
    },
    push: {
      status: userId => getStudioPushStatus(userId),
      send: (userId, message) => sendStudioPushNotification(userId, message),
    },
    ai: createAutomationDeepseekAdapter({ apiKey: userId => service.deepseekApiKey(userId) }),
  });
  automations.start();
  routes.use('/automations', createAutomationsRouter(automations));
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
  // A conversation handed to another provider mid-way: a summary from the stored transcript seeds the next session,
  // and the chain of sessions is kept so the workbench lists and shows it as one conversation.
  const workbenchThreads = createWorkbenchThreadsService({
    database: getConnection(),
    agentSession(sessionId) {
      try {
        const details = sessionsService.getSessionDetailsById(sessionId);
        return { provider: details.provider, projectId: details.project?.projectId ?? null };
      } catch { return null; }
    },
    agentTranscript: async sessionId => (await sessionsService.fetchHistory(sessionId, { limit: null, offset: 0 })).messages,
    deepseekConversation: (userId, conversationId) => service.conversation(userId, conversationId) as {
      messages: { role: string; content: string; status?: string }[];
    },
  });
  // The project switcher's marks: projects with an agent turn or DeepSeek reply running, and projects that need the
  // owner (an approval or question, a failed or interrupted run, a run that finished unseen). Pages are told to read
  // again over the chat websocket; a DeepSeek reply that finished off screen is also notified, like an agent run.
  const projectIdOf = (projectPath: string | null | undefined) => {
    const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
    return project && !project.isArchived ? project.project_id : null;
  };
  const linkedHubProjects = (userId: number) => new Map(workbench.hubLinks(userId)
    .flatMap(link => (link.projectId ? [[link.hubId, link.projectId] as [string, string]] : [])));
  const workbenchActivity = createWorkbenchActivityService({
    listRunningSessions: () => sessionsService.listRunningSessions(),
    hasPendingApproval: sessionId => providerRuntimeService.getPendingApprovalsForSession(sessionId).length > 0,
    listUnresolvedRuns: userId => taskRunsDb.listInterrupted(userId, { limit: 100 }),
    sessionProjectId(sessionId) {
      const session = sessionsDb.getSessionById(sessionId);
      return session && !session.isArchived ? projectIdOf(session.project_path) : null;
    },
    projectIdOfPath: projectPath => projectIdOf(projectPath),
    replyingConversations: userId => service.replyingConversations(userId),
    hubProjectIds: linkedHubProjects,
    isSessionInView: sessionId => isSessionInView(sessionId),
    broadcast() {
      const frame = JSON.stringify({ kind: 'workbench_activity', timestamp: new Date().toISOString() });
      for (const client of connectedClients) if (client.readyState === WS_OPEN_STATE) client.send(frame);
    },
  });
  chatRunRegistry.onActivity(event => workbenchActivity.handleRunActivity(event));
  onSessionsViewed(sessionIds => workbenchActivity.handleSessionsViewed(sessionIds));
  service.observeReplies(event => {
    workbenchActivity.handleReply(event);
    if (event.phase !== 'ended') return;
    const hubId = /^project:(.+)$/.exec(event.space)?.[1];
    const projectId = hubId ? linkedHubProjects(event.userId).get(hubId) : undefined;
    notifyRunStopped({
      userId: event.userId, provider: 'deepseek', sessionId: event.conversationId, sessionName: event.title,
      url: projectId ? `/work/${encodeURIComponent(projectId)}/d/${encodeURIComponent(event.conversationId)}` : '/',
    });
  });
  routes.use('/workbench', createWorkbenchRouter(workbench, workbenchThreads, workbenchActivity));
  // ── v6 track: chat — create its service and mount its router below this line ──
  // The faint suggested next message in every chat composer, from DeepSeek with the Studio chat's key
  // (STUDIO_SUGGEST_MODEL picks the model, default deepseek-chat); without a key only a local rule answers.
  routes.use('/suggestions', createPromptSuggestionsRouter(createPromptSuggester({
    deepseekKey: userId => service.deepseekApiKey(userId),
    model: process.env.STUDIO_SUGGEST_MODEL,
  })));
  // ── v6 track: github — create its service and mount its router below this line ──
  // The owner's GitHub through the gh CLI already signed in on this machine (gh keeps the token; Studio never reads
  // it). STUDIO_GH_PATH points at gh when it is not in ~/.local/bin, /usr/local/bin, /usr/bin or on PATH.
  const github = createGitHubService({
    database: getConnection(),
    run: createGhRunner({ ghPath: resolveGhPath(process.env.STUDIO_GH_PATH) }),
  });
  // The workbench chat header's PR chip: the open PR of an IDE project's current branch (git reads its origin).
  const githubBranches = createGitHubBranchService({
    github,
    projectDirectory(projectId) {
      const row = projectsDb.getProjectById(projectId);
      return row && !row.isArchived ? row.project_path : null;
    },
    readLocalRepo: createLocalRepoReader(),
  });
  routes.use('/github', createGitHubRouter(github, githubBranches));
  // ── v6 track: builder — create its service and mount its router below this line ──
  // App Store-style AI builds: a new ~/projects folder, a hub project (the icon) and an unattended Claude Code
  // session per build (STUDIO_BUILDS_ROOT, STUDIO_BUILDS_MAX_PARALLEL, STUDIO_BUILD_MODEL; see builds.module.ts).
  // Name suggestions use the same DeepSeek key as the Studio chat.
  const buildsModule = createStudioBuildsRoutes(hub, {
    deepseekKey: userId => service.deepseekApiKey(userId),
    onBuildFailed: ({ userId, projectId, error }) => {
      void automations.handleEvent(userId, projectId, 'build-failed', error)
        .catch((failure: unknown) => console.error('[studio-automations] build-failed event failed', failure instanceof Error ? failure.message : failure));
    },
  });
  routes.use('/builds', buildsModule.router);
  // The apps those builds made run in their project's 主页: started on demand on a loopback port, reached through a
  // token-addressed gateway (/api/studio/app-site, mounted by the server without session auth) in a sandboxed iframe.
  const appRunner = createStudioAppRunner();
  process.once('exit', () => appRunner.stopAll());
  const appGateway = createStudioAppGateway({ validUser: id => Boolean(userDb.getUserById(id)) });
  const lookupApp: StudioAppLookup = (userId, projectId) => {
    const build = buildsModule.builds.list(userId).find(item => item.hubProjectId === projectId);
    if (!build) throw new AppError('这个项目不是 AI 开发的应用', { statusCode: 404 });
    return { directory: build.workspacePath, name: hub.get(userId, projectId).name };
  };
  routes.use('/apps', createStudioAppsRouter({ runner: appRunner, gateway: appGateway, lookup: lookupApp }));
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
  // ── harness: the Claude Code and Codex sessions running on this computer ──
  // Read from the agents' own files on both sides of WSL (the Windows home is the one the memory checks found), so
  // sessions started in a terminal or the desktop apps show up too. A WSL session Studio has indexed opens in the
  // workbench; the sessions Studio's own chat runs drive are marked as Studio's.
  const harness = createHarnessService({
    homes: [{ machine: 'wsl', home: os.homedir() }, ...(memoryWindowsHome ? [{ machine: 'windows' as const, home: memoryWindowsHome }] : [])],
    linuxHome: os.homedir(),
    async studioRuns() {
      const runs = (await sessionsService.listRunningSessions()).filter(run => !run.background && !run.statusText);
      return new Set(runs.map(run => sessionsDb.getSessionById(run.sessionId)?.provider_session_id || run.sessionId));
    },
    href(providerSessionId) {
      const session = sessionsDb.getSessionByProviderSessionId(providerSessionId);
      const project = session?.project_path ? projectsDb.getProjectPath(session.project_path) : null;
      if (!session || session.isArchived || !project || project.isArchived) return null;
      return `/work/${encodeURIComponent(project.project_id)}/s/${encodeURIComponent(session.session_id)}`;
    },
  });
  routes.use('/harness', createHarnessRouter(harness));
  return {
    routes,
    snrRoutes: createSnrGatewayRouter(gateway),
    appSiteRoutes: createStudioAppSiteRouter({ runner: appRunner, gateway: appGateway, lookup: lookupApp }),
    mailCallbackRoutes: createProjectMailCallbackRouter(mail),
    // Used by the server entrypoint when "退出所有设备" also drops the user's SNR access cookies.
    revokeSnrAccess: (userId: number) => gateway.revoke(userId),
    // …and every address of the user's AI-built apps.
    revokeAppAccess: (userId: number) => appGateway.revoke(userId),
  };
}
