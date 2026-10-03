import express from 'express';
import type { Request, Response } from 'express';

import type { TaskRecoveryFilters } from '@/shared/index.js';

import { taskRecoveryService } from './task-recovery.service.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

function readUserId(req: Request, res: Response): string | number | null {
  const id = (req as AuthenticatedRequest).user?.id;
  if ((typeof id === 'string' && id.trim()) || (typeof id === 'number' && Number.isFinite(id))) return id;
  res.status(401).json({ error: 'Authentication required', code: 'USER_REQUIRED' });
  return null;
}

/** The server mounts these authenticated routes at /api/task-recovery. */
export const taskRecoveryRouter = express.Router();

taskRecoveryRouter.get('/', (req, res, next) => {
  const userId = readUserId(req, res);
  if (userId === null) return;
  const filters: TaskRecoveryFilters = {};
  for (const key of ['projectPath', 'sessionId'] as const) {
    if (req.query[key] === undefined) continue;
    if (typeof req.query[key] !== 'string' || !req.query[key].trim()) {
      res.status(400).json({ error: `Invalid ${key}`, code: 'INVALID_QUERY' });
      return;
    }
    filters[key] = req.query[key];
  }
  if (req.query.unassigned !== undefined) {
    if (req.query.unassigned !== 'true' && req.query.unassigned !== 'false') {
      res.status(400).json({ error: 'Invalid unassigned', code: 'INVALID_QUERY' });
      return;
    }
    filters.unassigned = req.query.unassigned === 'true';
  }
  if (req.query.limit !== undefined) {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      res.status(400).json({ error: 'Invalid limit', code: 'INVALID_QUERY' });
      return;
    }
    filters.limit = limit;
  }
  try { res.json({ runs: taskRecoveryService.list(userId, filters) }); } catch (error) { next(error); }
});

taskRecoveryRouter.get('/requests/:requestId', (req, res, next) => {
  const userId = readUserId(req, res);
  if (userId === null) return;
  const requestId = req.params.requestId;
  if (typeof requestId !== 'string' || !requestId.trim()) {
    res.status(400).json({ error: 'Invalid requestId', code: 'INVALID_REQUEST' });
    return;
  }
  try { res.json({ run: taskRecoveryService.findRequest(userId, requestId) }); } catch (error) { next(error); }
});

taskRecoveryRouter.post('/:runId/resolve', (req, res, next) => {
  const userId = readUserId(req, res);
  if (userId === null) return;
  const runId = req.params.runId;
  if (typeof runId !== 'string' || !runId.trim()) {
    res.status(400).json({ error: 'Invalid runId', code: 'INVALID_REQUEST' });
    return;
  }
  try {
    if (!taskRecoveryService.resolve(userId, runId)) {
      res.status(404).json({ error: 'Recoverable task not found', code: 'RECOVERY_NOT_FOUND' });
      return;
    }
    res.json({ resolved: true });
  } catch (error) { next(error); }
});
