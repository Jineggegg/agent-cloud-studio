import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import type { createMemoryService } from './memory.service.js';

const FOLDER = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;

function user(req: express.Request) {
  const id = Number((req as express.Request & { user?: { id?: number } }).user?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError('需要登录', { statusCode: 401 });
  return id;
}
function invalid(message: string): never {
  throw new AppError(message, { statusCode: 400, code: 'MEMORY_INVALID_REQUEST' });
}
// Optional single query string; repeated or non-string parameters are rejected rather than coerced.
function optionalText(value: unknown, label: string, max: number) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) invalid(`${label}格式无效`);
  return value;
}
function folder(value: unknown) {
  const name = optionalText(value, '文件夹', 64);
  if (name === undefined || name === '') return undefined;
  if (!FOLDER.test(name)) invalid('文件夹格式无效');
  return name;
}
// A note id is a basic-memory permalink such as `studio/global/偏好`: relative, no dot segments, no control characters.
function noteId(value: unknown) {
  const id = optionalText(value, '笔记 id', 400)?.trim();
  if (!id || id.startsWith('/') || /[\p{Cc}\\]/u.test(id) || id.split('/').some(part => part === '' || part === '.' || part === '..')) invalid('笔记 id 无效');
  return id;
}
// Runs a read with a signal that aborts when the browser goes away (a superseded search, a closed sheet), so the
// memory server is not kept busy; an aborted read sends nothing and is not reported as a server error.
async function whileConnected(res: express.Response, read: (signal: AbortSignal) => Promise<unknown>) {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    res.json(await read(controller.signal));
  } catch (error) {
    if (controller.signal.aborted) return;
    throw error;
  }
}

/** Used by studio.module, mounted at /api/studio/memory behind authentication, for the 记忆 app. */
export function createMemoryRouter(service: ReturnType<typeof createMemoryService>) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/status', asyncHandler(async (req, res) => {
    user(req);
    res.json(await service.status());
  }));
  router.get('/notes', asyncHandler(async (req, res) => {
    const userId = user(req);
    const only = folder(req.query.folder);
    await whileConnected(res, signal => service.recent({ userId, folder: only, signal }));
  }));
  router.get('/search', asyncHandler(async (req, res) => {
    user(req);
    const query = optionalText(req.query.q, '搜索内容', 200)?.trim() ?? '';
    const only = folder(req.query.folder);
    await whileConnected(res, async signal => ({ notes: query ? await service.search(query, { folders: only ? [only] : null, limit: 40, signal }) : [] }));
  }));
  router.get('/note', asyncHandler(async (req, res) => {
    user(req);
    const id = noteId(req.query.id);
    await whileConnected(res, signal => service.read(id, signal));
  }));
  router.delete('/note', asyncHandler(async (req, res) => {
    user(req);
    res.json(await service.remove(noteId(req.query.id)));
  }));
  return router;
}
