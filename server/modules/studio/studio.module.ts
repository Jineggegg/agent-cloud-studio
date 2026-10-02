import path from 'node:path';
import os from 'node:os';
import { existsSync, realpathSync } from 'node:fs';

import { getConnection, getDatabasePath, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { createProject } from '@/modules/projects/index.js';
import { scheduledMessagesService } from '@/modules/scheduled-messages/index.js';
import { AppError } from '@/shared/utils.js';

import { createStudioService } from './studio.service.js';
import { createStudioRouter } from './studio.routes.js';
import { createSnrGateway } from './snr-gateway.service.js';
import { createSnrGatewayRouter } from './snr-gateway.routes.js';
import { createProjectHubService } from './project-hub.service.js';
import { createProjectMailService } from './project-mail.service.js';
import { createProjectHubRouter, createProjectMailCallbackRouter } from './project-hub.routes.js';

/** Used by server/index to assemble Studio independently of the inherited CLI providers. */
export function createStudioModule() {
  const gateway = createSnrGateway({
    baseUrl: process.env.STUDIO_SNR_BASE_URL ?? 'http://127.0.0.1:8768',
    validUser: id => Boolean(userDb.getUserById(id)),
  });
  const service = createStudioService({
    database: getConnection(),
    vaultDirectory: path.join(path.dirname(getDatabasePath()), 'studio-vault'),
    snrBaseUrl: process.env.STUDIO_SNR_BASE_URL,
    agentWorkbenchUrl: process.env.STUDIO_AGENT_WORKBENCH_URL,
  });
  const defaultProfessorPath = path.join(os.homedir(), 'projects', 'super-professor');
  const hub = createProjectHubService({
    database: getConnection(),
    professorPath: process.env.STUDIO_SUPER_PROFESSOR_PATH ?? (existsSync(defaultProfessorPath) ? defaultProfessorPath : ''),
    async resolveWorkspace(directory) {
      if (!existsSync(directory)) throw new AppError('工作目录不存在', { statusCode: 400 });
      const canonical = realpathSync(directory);
      if (/snr/i.test(canonical)) throw new AppError('SNR 保留在独立实验室', { statusCode: 400 });
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
      if (/snr/i.test(canonical)) return [];
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
  });
  const mail = createProjectMailService({
    database: getConnection(),
    vaultDirectory: path.join(path.dirname(getDatabasePath()), 'studio-vault'),
    project: hub.get,
    clientId: process.env.STUDIO_GMAIL_CLIENT_ID,
    clientSecret: process.env.STUDIO_GMAIL_CLIENT_SECRET,
    publicOrigin: process.env.STUDIO_PUBLIC_ORIGIN,
  });
  const routes = createStudioRouter(service, gateway);
  routes.use('/projects', createProjectHubRouter(hub, mail));
  return { routes, snrRoutes: createSnrGatewayRouter(gateway), mailCallbackRoutes: createProjectMailCallbackRouter(mail) };
}
