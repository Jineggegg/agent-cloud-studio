import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import { parseGitHubMergeRequest, parseGitHubPullRef } from './github.service.js';
import type { createGitHubService } from './github.service.js';

function user(req: express.Request) {
  const id = Number((req as express.Request & { user?: { id?: number } }).user?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError('需要登录', { statusCode: 401 });
  return id;
}

// ?refresh=1 (or true) bypasses the short server cache; anything else that is present is a client bug.
function refreshFlag(value: unknown) {
  if (value === undefined || value === '' || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  throw new AppError('refresh 参数无效', { statusCode: 400, code: 'INVALID_REFRESH' });
}

/**
 * Used by studio.module, mounted at /api/studio/github behind authentication: the gh account's status, the PR inbox,
 * one pull request's detail, merging (audited per Studio user) and the user's merge history.
 */
export function createGitHubRouter(service: ReturnType<typeof createGitHubService>) {
  const router = express.Router();
  // Account and repository data must never be cached by the browser or a proxy.
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/status', asyncHandler(async (req, res) => { res.json(await service.status(refreshFlag(req.query.refresh))); }));
  router.get('/prs', asyncHandler(async (req, res) => { res.json(await service.pulls(refreshFlag(req.query.refresh))); }));
  router.get('/prs/:owner/:repo/:number', asyncHandler(async (req, res) => {
    res.json(await service.pull(parseGitHubPullRef(req.params), refreshFlag(req.query.refresh)));
  }));
  router.post('/prs/:owner/:repo/:number/merge', asyncHandler(async (req, res) => {
    const userId = user(req);
    const ref = parseGitHubPullRef(req.params);
    let request: ReturnType<typeof parseGitHubMergeRequest>;
    try {
      request = parseGitHubMergeRequest(req.body);
    } catch (error) {
      // Every merge attempt is audited, including one rejected here for a bad method, SHA or flag.
      service.recordInvalidMerge(userId, ref, error);
      throw error;
    }
    res.json(await service.merge(userId, ref, request));
  }));
  router.get('/merges', asyncHandler(async (req, res) => { res.json(service.merges(user(req))); }));
  return router;
}
