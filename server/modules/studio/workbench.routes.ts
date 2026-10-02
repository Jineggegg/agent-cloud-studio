import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import type { createWorkbenchService } from './workbench.service.js';

function user(req: express.Request) {
  const id = Number((req as express.Request & { user?: { id?: number } }).user?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError('需要登录', { statusCode: 401 });
  return id;
}

/** Used by studio.module, mounted at /api/studio/workbench behind authentication, for the workbench shell. */
export function createWorkbenchRouter(service: ReturnType<typeof createWorkbenchService>) {
  const router = express.Router();
  router.get('/hub-links', asyncHandler(async (req, res) => { res.json(service.hubLinks(user(req))); }));
  return router;
}
