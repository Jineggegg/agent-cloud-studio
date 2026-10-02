import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import type { createMailService } from './mail.service.js';

function user(req: express.Request) {
  const id = Number((req as express.Request & { user?: { id?: number } }).user?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError('需要登录', { statusCode: 401 });
  return id;
}
function text(value: unknown, field: string) {
  if (typeof value !== 'string') throw new AppError(`${field}格式无效`, { statusCode: 400 });
  return value;
}
function optionalText(value: unknown, field: string) {
  return value === undefined || value === '' ? undefined : text(value, field);
}
function limit(value: unknown) {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(text(value, '数量'));
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) throw new AppError('数量应为 1 到 50', { statusCode: 400 });
  return parsed;
}

/** Used by studio.module, mounted at /api/studio/mail behind authentication: accounts belong to the signed-in Studio user. */
export function createMailRouter(service: ReturnType<typeof createMailService>) {
  const router = express.Router();
  // Mailbox data and account status must never be cached by the browser or a proxy.
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/accounts', asyncHandler(async (req, res) => { res.json(service.accounts(user(req))); }));
  router.post('/accounts/imap', asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    res.status(201).json(await service.addGmailImap(user(req), { email: text(body.email, '邮箱地址'), password: text(body.password, '应用专用密码') }));
  }));
  router.post('/accounts/outlook/device', asyncHandler(async (req, res) => { res.status(201).json(await service.startOutlookDevice(user(req))); }));
  router.post('/accounts/outlook/device/:pollId', asyncHandler(async (req, res) => {
    res.json(await service.pollOutlookDevice(user(req), String(req.params.pollId)));
  }));
  router.delete('/accounts/:id', asyncHandler(async (req, res) => { res.json(service.removeAccount(user(req), String(req.params.id))); }));
  router.get('/messages', asyncHandler(async (req, res) => {
    res.json(await service.messages(user(req), {
      accountId: optionalText(req.query.accountId, '账户'), query: optionalText(req.query.q, '搜索条件'), limit: limit(req.query.limit),
    }));
  }));
  router.get('/messages/:accountId/:messageId', asyncHandler(async (req, res) => {
    res.json(await service.message(user(req), String(req.params.accountId), String(req.params.messageId)));
  }));
  return router;
}
