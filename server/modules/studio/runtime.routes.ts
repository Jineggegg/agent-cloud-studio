import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import type { createStudioRuntimeService } from './runtime.service.js';

/** Used by studio.module to expose runtime metadata behind the existing authenticateToken middleware. */
export function createStudioRuntimeRouter(service: ReturnType<typeof createStudioRuntimeService>) {
  const router = express.Router();
  router.get('/', asyncHandler(async (req, res) => {
    const userId = Number((req as express.Request & { user?: { id?: number } }).user?.id);
    if (!Number.isSafeInteger(userId) || userId < 1) throw new AppError('需要登录', { statusCode: 401 });
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.describe());
  }));
  return router;
}
