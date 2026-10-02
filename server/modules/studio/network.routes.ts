import express from 'express';

import { asyncHandler } from '@/shared/utils.js';

import type { createStudioNetworkService } from './network.service.js';

/**
 * Used by studio.module to answer GET /api/studio/network and GET /api/studio/network/guide
 * (mounted behind authenticateToken).
 */
export function createStudioNetworkRouter(service: ReturnType<typeof createStudioNetworkService>) {
  const router = express.Router();
  router.get('/guide', asyncHandler(async (_req, res) => {
    res.json(service.guide());
  }));
  router.get('/', (req, res) => {
    // authenticateToken sets `tailscaleSession` only for tokens issued by Tailscale sign-in.
    const { tailscaleSession } = req as express.Request & { tailscaleSession?: unknown };
    res.json(service.describe({ host: req.get('host'), tailscaleSession: tailscaleSession !== undefined }));
  });
  return router;
}
