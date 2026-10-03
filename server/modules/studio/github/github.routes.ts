import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import {
  parseGitHubApproveRunsRequest, parseGitHubMergeRequest, parseGitHubPullRef, parseGitHubUpdateBranchRequest,
} from './github.service.js';
import type { createGitHubService } from './github.service.js';
import { parseWorkbenchProjectId } from './github-branch.service.js';
import type { createGitHubBranchService } from './github-branch.service.js';

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
 * one pull request's detail, merging (audited per Studio user), the user's merge history, the one-tap fixes for a
 * blocked pull request (update branch, mark ready, approve runs; audited) and, with the branch service, the open
 * pull request of a workbench project's current branch.
 */
export function createGitHubRouter(
  service: ReturnType<typeof createGitHubService>,
  branches?: ReturnType<typeof createGitHubBranchService>,
) {
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
  router.post('/prs/:owner/:repo/:number/update-branch', asyncHandler(async (req, res) => {
    const userId = user(req);
    const ref = parseGitHubPullRef(req.params);
    let request: ReturnType<typeof parseGitHubUpdateBranchRequest>;
    try {
      request = parseGitHubUpdateBranchRequest(req.body);
    } catch (error) {
      service.recordInvalidAction(userId, ref, 'update-branch', error);
      throw error;
    }
    res.json(await service.updateBranch(userId, ref, request));
  }));
  router.post('/prs/:owner/:repo/:number/ready', asyncHandler(async (req, res) => {
    const userId = user(req);
    res.json(await service.markReady(userId, parseGitHubPullRef(req.params)));
  }));
  router.post('/prs/:owner/:repo/:number/approve-runs', asyncHandler(async (req, res) => {
    const userId = user(req);
    const ref = parseGitHubPullRef(req.params);
    let request: ReturnType<typeof parseGitHubApproveRunsRequest>;
    try {
      request = parseGitHubApproveRunsRequest(req.body);
    } catch (error) {
      service.recordInvalidAction(userId, ref, 'approve-runs', error);
      throw error;
    }
    res.json(await service.approveRuns(userId, ref, request));
  }));
  router.get('/merges', asyncHandler(async (req, res) => { res.json(service.merges(user(req))); }));
  if (branches) {
    // IDE projects are not per user; like the IDE's own git routes, any signed-in Studio user may read them.
    router.get('/branch-pr', asyncHandler(async (req, res) => {
      user(req);
      res.json(await branches.branchPull(parseWorkbenchProjectId(req.query.projectId), refreshFlag(req.query.refresh)));
    }));
  }
  return router;
}
