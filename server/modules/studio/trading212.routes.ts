import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import type { createTrading212Service } from './trading212.service.js';

function environment(value: unknown) {
  if (value === undefined) return 'live';
  if (value !== 'live' && value !== 'demo') throw new AppError('环境必须为 live 或 demo', { statusCode: 400 });
  return value;
}

/** Mounted by studio.module behind authentication; exposes read-only account views and nothing that trades. */
export function createTrading212Router(service: ReturnType<typeof createTrading212Service>) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/status', (_req, res) => { res.json(service.status()); });
  router.get('/overview', asyncHandler(async (req, res) => { res.json(await service.overview(environment(req.query.env))); }));
  router.get('/history', asyncHandler(async (req, res) => {
    const days = req.query.days === undefined ? 30 : Number(req.query.days);
    if (!Number.isInteger(days) || days < 0 || days > 3650) throw new AppError('时间范围无效', { statusCode: 400 });
    res.json(service.history(environment(req.query.env), days));
  }));
  router.get('/activity', asyncHandler(async (req, res) => { res.json(await service.activity(environment(req.query.env))); }));
  return router;
}
