import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import type { createHarnessService } from './harness.service.js';

function user(req: express.Request) {
  const id = Number((req as express.Request & { user?: { id?: number } }).user?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError('需要登录', { statusCode: 401 });
  return id;
}

/** Used by studio.module, mounted at /api/studio/harness: the Harness app's list of agent sessions on this computer. */
export function createHarnessRouter(service: ReturnType<typeof createHarnessService>) {
  const router = express.Router();
  router.get('/tasks', asyncHandler(async (req, res) => {
    user(req);
    res.set('Cache-Control', 'no-store');
    res.json(await service.tasks());
  }));
  return router;
}
