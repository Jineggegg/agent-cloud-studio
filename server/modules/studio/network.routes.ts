import express from 'express';

import type { createStudioNetworkService } from './network.service.js';

/** Used by studio.module to answer GET /api/studio/network (mounted behind authenticateToken). */
export function createStudioNetworkRouter(service: ReturnType<typeof createStudioNetworkService>) {
  const router = express.Router();
  router.get('/', (req, res) => {
    // authenticateToken sets `tailscaleSession` only for tokens issued by Tailscale sign-in.
    const { tailscaleSession } = req as express.Request & { tailscaleSession?: unknown };
    res.json(service.describe({ host: req.get('host'), tailscaleSession: tailscaleSession !== undefined }));
  });
  return router;
}
