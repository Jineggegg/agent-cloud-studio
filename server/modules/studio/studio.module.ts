import path from 'node:path';
import os from 'node:os';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';

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
import { createStudioNetworkService } from './network.service.js';
import { createStudioNetworkRouter } from './network.routes.js';
import { createQuotaService } from './quota/quota.service.js';
import { createQuotaRouter } from './quota/quota.routes.js';

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
  routes.use('/projects', createProjectHubRouter(hub, mail));
  routes.use('/trading212', createTrading212Router(trading212));
  routes.use('/remote', createRemoteHostsRouter(remote));
  routes.use('/quota', createQuotaRouter(quota));
  // ── v4 track: network — create its service and mount its router below this line ──
  // Both front doors (STUDIO_PUBLIC_ORIGIN, STUDIO_TAILNET_ORIGIN) reach this one backend.
  routes.use('/network', createStudioNetworkRouter(createStudioNetworkService()));
  // ── v4 track: orders — create its service and mount its router below this line ──
  // Order placement is off unless STUDIO_T212_TRADING allows an account; each order is capped and needs a passkey (or,
  // only while the user has none, a double confirmation). Only requests from these origins may trade; localhost only
  // with STUDIO_T212_ALLOW_LOCALHOST=1. Passkey changes are stepped up with the Studio account password.
  // bcrypt has no TypeScript declarations here, so its compare function is narrowed like in the auth module.
  const bcrypt = createRequire(import.meta.url)('bcrypt') as { compare(password: string, passwordHash: string): Promise<boolean> };
  const trading212Orders = createTrading212OrdersService({
    database: getConnection(),
    trading212,
    trading: process.env.STUDIO_T212_TRADING,
    maxOrderValue: process.env.STUDIO_T212_MAX_ORDER_VALUE,
    requirePasskey: process.env.STUDIO_T212_REQUIRE_PASSKEY,
    allowLocalhost: process.env.STUDIO_T212_ALLOW_LOCALHOST,
    origins: [process.env.STUDIO_PUBLIC_ORIGIN, process.env.STUDIO_TAILNET_ORIGIN],
    async verifyPassword(userId, password) {
      // getUserById omits the hash, so the active account is re-read by username for the comparison.
      const account = userDb.getUserById(userId);
      const row = account ? userDb.getUserByUsername(account.username) : undefined;
      return row ? bcrypt.compare(password, row.password_hash) : false;
    },
  });
  routes.use('/trading212', createTrading212OrdersRouter(trading212Orders));
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
  // ── v6 track: chat — create its service and mount its router below this line ──
  // ── v6 track: github — create its service and mount its router below this line ──
  // ── v6 track: builder — create its service and mount its router below this line ──
  // App Store-style AI builds: a new ~/projects folder, a hub project (the icon) and an unattended Claude Code
  // session per build (STUDIO_BUILDS_ROOT, STUDIO_BUILDS_MAX_PARALLEL, STUDIO_BUILD_MODEL; see builds.module.ts).
  routes.use('/builds', createStudioBuildsRoutes(hub));
  // ── v6 track: memory — create its service and mount its router below this line ──
  return { routes, snrRoutes: createSnrGatewayRouter(gateway), mailCallbackRoutes: createProjectMailCallbackRouter(mail) };
}
