import express from 'express';

import { asyncHandler } from '@/shared/utils.js';

import type { createRemoteHostsService } from './remote-hosts.service.js';

/**
 * Mounted by studio.module at /api/studio/remote behind authentication. Read-only: it lists the configured hosts and
 * checks them; launch commands come only from the project hub's remote-launch route.
 */
export function createRemoteHostsRouter(service: ReturnType<typeof createRemoteHostsService>) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/hosts', (_req, res) => { res.json(service.hosts()); });
  // Unknown names are answered with 404 by the service before any SSH connection is attempted.
  router.get('/hosts/:name/status', asyncHandler(async (req, res) => { res.json(await service.status(String(req.params.name))); }));
  return router;
}
