import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import type { createStudioService } from './studio.service.js';
import type { createSnrGateway } from './snr-gateway.service.js';

/** Used by studio.module and route tests to expose only authenticated Studio operations. */
export function createStudioRouter(service: ReturnType<typeof createStudioService>, gateway: ReturnType<typeof createSnrGateway>) {
  const router = express.Router();
  const user = (req: express.Request) => {
    const id = Number((req as express.Request & { user?: { id?: number } }).user?.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new AppError('需要登录', { statusCode: 401 });
    return id;
  };
  const text = (value: unknown) => {
    if (typeof value !== 'string') throw new AppError('请求字段格式无效', { statusCode: 400 });
    return value;
  };
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/status', asyncHandler(async (req, res) => { res.json(service.status(user(req))); }));
  router.put('/deepseek/key', asyncHandler(async (req, res) => { res.json(service.saveKey(user(req), text(req.body?.apiKey))); }));
  router.delete('/deepseek/key', asyncHandler(async (req, res) => { res.json(service.removeKey(user(req))); }));
  router.post('/deepseek/test', asyncHandler(async (req, res) => { res.json(await service.testKey(user(req))); }));
  router.get('/snr', asyncHandler(async (req, res) => { user(req); res.json(await service.snrStatus()); }));
  router.post('/snr/access', asyncHandler(async (req, res) => {
    const access = gateway.grant(user(req));
    res.cookie('studio-snr-access', access.key, {
      httpOnly: true, sameSite: 'strict', secure: process.env.STUDIO_PUBLIC_ORIGIN?.startsWith('https://') || req.secure || req.get('x-forwarded-proto') === 'https',
      path: '/api/studio/snr-site', maxAge: access.maxAge,
    });
    res.json({ url: access.url });
  }));
  router.post('/snr/close', asyncHandler(async (req, res) => {
    gateway.revoke(user(req));
    res.clearCookie('studio-snr-access', { path: '/api/studio/snr-site', httpOnly: true, sameSite: 'strict' });
    res.json({ closed: true });
  }));
  // `space` selects which home-screen chat app owns the history; it defaults to the DeepSeek app.
  const space = (value: unknown) => value === undefined ? undefined : text(value);
  router.get('/conversations', asyncHandler(async (req, res) => { res.json(service.listConversations(user(req), space(req.query.space))); }));
  router.post('/conversations', asyncHandler(async (req, res) => {
    res.status(201).json(service.createConversation(user(req), text(req.body?.model), space(req.body?.space)));
  }));
  router.get('/conversations/:id', asyncHandler(async (req, res) => { res.json(service.conversation(user(req), String(req.params.id))); }));
  router.delete('/conversations/:id', asyncHandler(async (req, res) => { res.json(service.removeConversation(user(req), String(req.params.id))); }));
  router.post('/conversations/:id/messages', asyncHandler(async (req, res) => {
    const includeSnr = req.body?.includeSnr ?? false;
    if (typeof includeSnr !== 'boolean') throw new AppError('SNR 上下文选项格式无效', { statusCode: 400 });
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    res.json(await service.send(user(req), String(req.params.id), text(req.body?.text), includeSnr, controller.signal));
  }));
  return router;
}
