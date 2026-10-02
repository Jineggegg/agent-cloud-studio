import express from 'express';

import type { StudioBuildInput } from '@/shared/types.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

import type { createStudioBuildsService } from './builds.service.js';

function text(value: unknown) {
  if (typeof value !== 'string') throw new AppError('字段格式无效', { statusCode: 400 });
  return value;
}
function user(req: express.Request) {
  const id = Number((req as express.Request & { user?: { id: number } }).user?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError('需要登录', { statusCode: 401 });
  return id;
}
function buildInput(body: Record<string, unknown>): StudioBuildInput {
  return { name: text(body.name), tone: text(body.tone), glyph: text(body.glyph), prompt: text(body.prompt) };
}

/** Mounted by the Studio builds wiring at /api/studio/builds behind authentication; transport validation only. */
export function createStudioBuildsRouter(builds: ReturnType<typeof createStudioBuildsService>) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/', asyncHandler(async (req, res) => { res.json(builds.list(user(req))); }));
  router.post('/', asyncHandler(async (req, res) => { res.status(201).json(await builds.create(user(req), buildInput(req.body ?? {}))); }));
  // Registered before /:id so "environment" is never read as a build id.
  router.get('/environment', asyncHandler(async (req, res) => {
    user(req);
    res.json(builds.environment());
  }));
  router.get('/:id', asyncHandler(async (req, res) => { res.json(builds.get(user(req), String(req.params.id))); }));
  router.post('/:id/continue', asyncHandler(async (req, res) => {
    // The follow-up message is optional; without one the agent finishes the steps still open.
    const message = req.body?.message === undefined ? '' : text(req.body.message);
    res.json(builds.resume(user(req), String(req.params.id), message));
  }));
  router.post('/:id/cancel', asyncHandler(async (req, res) => { res.json(await builds.cancel(user(req), String(req.params.id))); }));
  return router;
}
