import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import type { createTrading212OrdersService } from './trading212-orders.service.js';

type Json = Record<string, unknown>;
type AuthenticatedRequest = express.Request & { user?: { id?: number } };

const ID = /^[0-9a-f-]{36}$/;
const ORDER_FIELDS = ['env', 'ticker', 'side', 'type', 'quantity', 'limitPrice', 'timeValidity'] as const;
const MAX_CODE_LENGTH = 64;

function invalid(message: string): never {
  throw new AppError(message, { statusCode: 400, code: 'INVALID_ORDER' });
}
function requireUser(req: express.Request) {
  const id = Number((req as AuthenticatedRequest).user?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError('需要登录', { statusCode: 401 });
}
function record(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}
// The browser's Origin header, exactly scheme://host[:port]. Whether it may trade is the broker's decision.
function origin(req: express.Request) {
  const header = req.get('origin');
  let url: URL | null = null;
  try { url = header ? new URL(header) : null; } catch { url = null; }
  if (!url || url.origin !== header) throw new AppError('无法确认请求来自哪个网址，请从 Studio 页面操作', { statusCode: 403, code: 'T212_UNTRUSTED_ORIGIN' });
  return url.origin;
}
// Only the order fields are forwarded; the broker validates their values again because it trusts no caller.
function order(body: unknown) {
  const input = record(body);
  return Object.fromEntries(ORDER_FIELDS.filter(field => input[field] !== undefined).map(field => [field, input[field]]));
}
// WebAuthn responses are verified by the broker; Studio only checks the JSON envelope.
function credential(value: unknown) {
  const item = record(value);
  if (typeof item.id !== 'string' || !item.id || typeof item.rawId !== 'string' || !Object.keys(record(item.response)).length) invalid('通行密钥响应格式无效');
  return item;
}
function enrollmentCode(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_CODE_LENGTH) invalid('需要输入注册码（在服务器上用 studio-trader enroll-code 生成）');
  return value;
}
function id(value: unknown, message: string, code?: string) {
  const text = String(value);
  if (!ID.test(text)) throw new AppError(message, { statusCode: 404, code });
  return text;
}

/**
 * Used by studio.module, mounted at /api/studio/trading212 behind authentication next to the read-only router.
 * Every order and passkey change is decided by the order broker: a preview returns its single-use passkey
 * challenge, confirming needs the assertion (demo may use a plain confirmation only if the broker allows it),
 * and passkey enrollment or removal needs an enrollment code printed on the server, or an existing passkey.
 */
export function createTrading212OrdersRouter(service: ReturnType<typeof createTrading212OrdersService>) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/trading', asyncHandler(async (req, res) => {
    requireUser(req);
    res.json(await service.config());
  }));
  router.post('/orders/preview', asyncHandler(async (req, res) => {
    requireUser(req);
    // Only a literal true acknowledges that an identical order with an unknown outcome did not go through.
    res.json(await service.preview(origin(req), order(req.body), record(req.body).acknowledgeUnknown === true));
  }));
  router.post('/orders/:id/confirm', asyncHandler(async (req, res) => {
    requireUser(req);
    const body = record(req.body);
    const proof = body.assertion !== undefined ? { assertion: credential(body.assertion) }
      : body.confirmed === true ? { confirmed: true as const } : invalid('需要面容 ID / 触控 ID 验证');
    const previewId = id(req.params.id, '这笔订单预览不存在、已使用或已过期，请重新预览', 'T212_PREVIEW_GONE');
    res.json(await service.confirm(origin(req), previewId, proof));
  }));
  router.post('/passkey/options', asyncHandler(async (req, res) => {
    requireUser(req);
    res.json(await service.passkeyOptions(origin(req), enrollmentCode(record(req.body).enrollmentCode)));
  }));
  router.post('/passkey', asyncHandler(async (req, res) => {
    requireUser(req);
    res.status(201).json(await service.registerPasskey(origin(req), credential(record(req.body).response), req.get('user-agent')));
  }));
  router.post('/passkey/:id/remove/options', asyncHandler(async (req, res) => {
    requireUser(req);
    res.json(await service.removalOptions(origin(req), id(req.params.id, '找不到这把通行密钥')));
  }));
  router.post('/passkey/:id/remove', asyncHandler(async (req, res) => {
    requireUser(req);
    const body = record(req.body);
    const proof = body.assertion !== undefined ? { assertion: credential(body.assertion) } : { enrollmentCode: enrollmentCode(body.enrollmentCode) };
    res.json(await service.removePasskey(origin(req), id(req.params.id, '找不到这把通行密钥'), proof));
  }));
  return router;
}
