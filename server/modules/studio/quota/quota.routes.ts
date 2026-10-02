import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import type { createQuotaService } from './quota.service.js';

function user(req: express.Request) {
  const id = Number((req as express.Request & { user?: { id?: number } }).user?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError('需要登录', { statusCode: 401 });
  return id;
}

/** Used by studio.module, mounted at /api/studio/quota behind authentication, for the home-screen quota widgets. */
export function createQuotaRouter(service: ReturnType<typeof createQuotaService>) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/', asyncHandler(async (req, res) => { res.json(await service.snapshots(user(req))); }));
  return router;
}
