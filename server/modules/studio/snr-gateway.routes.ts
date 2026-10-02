import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import type { createSnrGateway } from './snr-gateway.service.js';

/** Used by studio.module to protect SNR assets and user-triggered edits with a short-lived scoped cookie. */
export function createSnrGatewayRouter(gateway: ReturnType<typeof createSnrGateway>) {
  const router = express.Router();
  router.use(asyncHandler(async (req, res) => {
    const key = req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith('studio-snr-access='))?.slice('studio-snr-access='.length);
    if (!gateway.authorized(key)) throw new AppError('研究入口已过期，请从 Studio 重新打开', { statusCode: 401 });
    if (!['GET', 'HEAD'].includes(req.method)) {
      const origin = req.get('origin');
      let sameOrigin = false;
      try {
        const source = origin ? new URL(origin) : null;
        const publicOrigin = process.env.STUDIO_PUBLIC_ORIGIN;
        const scheme = req.get('x-forwarded-proto') === 'https' || req.secure ? 'https:' : 'http:';
        sameOrigin = Boolean(source && (publicOrigin ? source.origin === publicOrigin : source.host === req.get('host') && source.protocol === scheme));
      } catch { /* Malformed origins are rejected below. */ }
      if (req.get('sec-fetch-site') === 'cross-site' || !sameOrigin) {
        throw new AppError('拒绝跨站研究操作', { statusCode: 403 });
      }
    }
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const contentType = req.get('content-type');
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : contentType?.includes('application/json') ? JSON.stringify(req.body) : req as unknown as RequestInit['body'];
    const result = await gateway.proxy(req.url, req.method, body, contentType, controller.signal);
    res.status(result.status).set({
      'Content-Type': result.contentType,
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'SAMEORIGIN',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    if (result.disposition) res.setHeader('Content-Disposition', result.disposition);
    res.send(result.body);
  }));
  return router;
}
