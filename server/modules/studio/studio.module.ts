import path from 'node:path';

import { getConnection, getDatabasePath, userDb } from '@/modules/database/index.js';

import { createStudioService } from './studio.service.js';
import { createStudioRouter } from './studio.routes.js';
import { createSnrGateway } from './snr-gateway.service.js';
import { createSnrGatewayRouter } from './snr-gateway.routes.js';

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
  return { routes: createStudioRouter(service, gateway), snrRoutes: createSnrGatewayRouter(gateway) };
}
