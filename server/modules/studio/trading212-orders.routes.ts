import express from 'express';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

import { AppError, asyncHandler } from '@/shared/utils.js';
import type {
  StudioRequestClient, StudioT212CapsInput, StudioT212CapsRequest, StudioT212ModeRequest, StudioT212OrderInput, StudioT212TradingMode,
} from '@/shared/types.js';

import type { createTrading212OrdersService } from './trading212-orders.service.js';

// Trading 212 tickers look like AAPL_US_EQ or VODl_EQ.
const TICKER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const ID = /^[0-9a-f-]{36}$/;
const MAX_QUANTITY = 1_000_000;
const MAX_PRICE = 10_000_000;
const MAX_PASSWORD_LENGTH = 1024;
// Transport bound for a cap; the real limit is STUDIO_T212_CAP_CEILING, checked by the caps service.
const MAX_CAP = 10_000_000;

type AuthenticatedRequest = express.Request & { user?: { id?: number; username?: string } };

function invalid(message: string): never {
  throw new AppError(message, { statusCode: 400, code: 'INVALID_ORDER' });
}
function user(req: express.Request) {
  const id = Number((req as AuthenticatedRequest).user?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError('需要登录', { statusCode: 401 });
  return id;
}
function hasDecimals(value: number, places: number) {
  const scaled = value * 10 ** places;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function orderInput(body: unknown): StudioT212OrderInput {
  const input = record(body);
  if (input.env !== 'live' && input.env !== 'demo') invalid('账户必须为 live 或 demo');
  const ticker = typeof input.ticker === 'string' ? input.ticker.trim() : '';
  if (!TICKER.test(ticker)) invalid('代码格式无效，例如 AAPL_US_EQ');
  if (input.side !== 'buy' && input.side !== 'sell') invalid('方向必须为买入或卖出');
  if (input.type !== 'market' && input.type !== 'limit') invalid('类型必须为市价或限价');
  const quantity = input.quantity;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_QUANTITY || !hasDecimals(quantity, 6)) {
    invalid('数量必须是大于 0 的数字，最多 6 位小数');
  }
  const timeValidity = input.timeValidity ?? 'DAY';
  if (timeValidity !== 'DAY' && timeValidity !== 'GOOD_TILL_CANCEL') invalid('有效期必须为 DAY 或 GOOD_TILL_CANCEL');
  if (input.type === 'market') {
    if (input.limitPrice !== undefined) invalid('市价单不需要限价');
    return { env: input.env, ticker, side: input.side, type: 'market', quantity, timeValidity: 'DAY' };
  }
  const limitPrice = input.limitPrice;
  if (typeof limitPrice !== 'number' || !Number.isFinite(limitPrice) || limitPrice <= 0 || limitPrice > MAX_PRICE || !hasDecimals(limitPrice, 4)) {
    invalid('限价必须是大于 0 的数字，最多 4 位小数');
  }
  return { env: input.env, ticker, side: input.side, type: 'limit', quantity, limitPrice, timeValidity };
}
// WebAuthn credentials are verified cryptographically by the service; the route only checks the JSON envelope.
function credentialJson(value: unknown) {
  const credential = record(value);
  if (typeof credential.id !== 'string' || !credential.id || typeof credential.rawId !== 'string' || !Object.keys(record(credential.response)).length) {
    invalid('通行密钥响应格式无效');
  }
  return credential;
}
function proof(body: unknown) {
  const input = record(body);
  if (input.assertion !== undefined) return { assertion: credentialJson(input.assertion) as unknown as AuthenticationResponseJSON };
  if (input.confirmed === true) return { confirmed: true as const };
  return invalid('需要面容 ID / 触控 ID 验证或二次确认');
}
// The Studio account password for a passkey change; bcrypt only reads 72 bytes, the cap just bounds the request.
function password(body: unknown) {
  const value = record(body).password;
  if (typeof value !== 'string' || !value || value.length > MAX_PASSWORD_LENGTH) invalid('需要输入 Studio 登录密码');
  return value;
}
// Removing a passkey needs the Studio password or an assertion from that passkey.
function stepUp(body: unknown) {
  const input = record(body);
  if (input.assertion !== undefined) return { assertion: credentialJson(input.assertion) as unknown as AuthenticationResponseJSON };
  return { password: password(body) };
}
function capsInput(body: unknown): StudioT212CapsInput {
  const input = record(body);
  if (input.env !== 'live' && input.env !== 'demo') invalid('账户必须为 live 或 demo');
  const values = [input.maxOrderValue, input.dailyLimit];
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_CAP || !hasDecimals(value, 2)) {
      invalid('上限必须是大于 0 的数字，最多 2 位小数');
    }
  }
  return { env: input.env, maxOrderValue: input.maxOrderValue as number, dailyLimit: input.dailyLimit as number };
}
// PUT /caps: the challenge id is read first and passed on verbatim, so the service can spend it (and audit the
// attempt) even when the rest of the body is malformed; that case is reported as `invalid` instead of thrown here.
// A raise carries the challenge id and its assertion together; a lowering carries neither.
function capsRequest(body: unknown): StudioT212CapsRequest {
  const input = record(body);
  const named = input.challengeId !== undefined || input.assertion !== undefined;
  const challengeId = typeof input.challengeId === 'string' ? input.challengeId.slice(0, 64) : named ? '' : undefined;
  const spend = challengeId === undefined ? {} : { challengeId };
  try {
    const caps = capsInput(input);
    if (challengeId === undefined) return { input: caps };
    if (!ID.test(challengeId)) invalid('面容 ID 验证编号无效，请重新提交');
    return { ...spend, input: caps, assertion: credentialJson(input.assertion) as unknown as AuthenticationResponseJSON };
  } catch (error) {
    if (error instanceof AppError) return { ...spend, invalid: error.message };
    throw error;
  }
}
function tradingMode(value: unknown): StudioT212TradingMode {
  if (value !== 'off' && value !== 'demo' && value !== 'live' && value !== 'both') invalid('交易模式必须为 off、demo、live 或 both');
  return value;
}
// PUT /mode, read like PUT /caps: the challenge id first and verbatim, so the service can spend it (and audit the
// attempt) even when the rest of the body is malformed. A widening carries the challenge id and its assertion; a
// narrowing carries neither.
function modeRequest(body: unknown): StudioT212ModeRequest {
  const input = record(body);
  const named = input.challengeId !== undefined || input.assertion !== undefined;
  const challengeId = typeof input.challengeId === 'string' ? input.challengeId.slice(0, 64) : named ? '' : undefined;
  const spend = challengeId === undefined ? {} : { challengeId };
  try {
    const mode = tradingMode(input.mode);
    if (challengeId === undefined) return { mode };
    if (!ID.test(challengeId)) invalid('面容 ID 验证编号无效，请重新选择');
    return { ...spend, mode, assertion: credentialJson(input.assertion) as unknown as AuthenticationResponseJSON };
  } catch (error) {
    if (error instanceof AppError) return { ...spend, invalid: error.message };
    throw error;
  }
}
// A 429 from the caps or trading-mode service carries its wait, which also goes out as Retry-After.
async function withRetryAfter<T>(res: express.Response, work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    const wait = error instanceof AppError && error.statusCode === 429 ? (error.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds : undefined;
    if (typeof wait === 'number') res.setHeader('Retry-After', String(wait));
    throw error;
  }
}
function passkeyId(value: unknown) {
  const id = String(value);
  if (!ID.test(id)) throw new AppError('找不到这把通行密钥', { statusCode: 404 });
  return id;
}
function previewId(value: unknown) {
  const id = String(value);
  if (!ID.test(id)) throw new AppError('这笔订单预览不存在、已使用或已过期，请重新预览', { statusCode: 404, code: 'T212_PREVIEW_GONE' });
  return id;
}

/**
 * Used by studio.module, mounted at /api/studio/trading212 behind authentication next to the read-only
 * router, for passkey-gated order placement and passkey management. Read paths stay on the read-only router.
 * Every passkey change needs a step-up (the Studio password, or that passkey for its own removal). Order caps are
 * lowered with the session alone; raising them needs a Face ID / Touch ID challenge for the exact new values. The
 * trading mode (which accounts may place orders, within STUDIO_T212_TRADING) works the same way: narrowing with the
 * session, adding an account with a challenge for the exact new mode.
 */
export function createTrading212OrdersRouter(
  service: ReturnType<typeof createTrading212OrdersService>,
  // The auth module's request classifier, so a step-up is counted for the right client.
  readClient: (req: express.Request) => StudioRequestClient,
) {
  // The signed-in user (with its session id) and the client, for the auth step-up.
  const stepUpWho = (req: express.Request) => ({ user: (req as AuthenticatedRequest).user, client: readClient(req) });
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/trading', (req, res) => { res.json(service.config(user(req))); });
  router.post('/orders/preview', asyncHandler(async (req, res) => {
    const userId = user(req);
    const origin = service.trustedOrigin(req.get('origin'));
    // Only a literal true acknowledges that an identical order with an unknown outcome did not go through.
    const acknowledgeUnknown = record(req.body).acknowledgeUnknown === true;
    res.json(await service.preview(userId, origin, orderInput(req.body), { acknowledgeUnknown }));
  }));
  router.post('/orders/:id/confirm', asyncHandler(async (req, res) => {
    const userId = user(req);
    const origin = service.trustedOrigin(req.get('origin'));
    res.json(await service.confirm(userId, origin, previewId(req.params.id), proof(req.body)));
  }));
  router.post('/passkey/options', asyncHandler(async (req, res) => {
    const userId = user(req);
    const origin = service.trustedOrigin(req.get('origin'));
    res.json(await service.passkeyOptions(userId, (req as AuthenticatedRequest).user?.username, origin, password(req.body), stepUpWho(req)));
  }));
  router.post('/passkey', asyncHandler(async (req, res) => {
    const userId = user(req);
    const origin = service.trustedOrigin(req.get('origin'));
    const response = credentialJson(record(req.body).response) as unknown as RegistrationResponseJSON;
    res.status(201).json(await service.registerPasskey(userId, origin, response, req.get('user-agent')));
  }));
  router.post('/passkey/:id/remove/options', asyncHandler(async (req, res) => {
    const userId = user(req);
    const origin = service.trustedOrigin(req.get('origin'));
    res.json(await service.removalOptions(userId, origin, passkeyId(req.params.id)));
  }));
  router.post('/passkey/:id/remove', asyncHandler(async (req, res) => {
    const userId = user(req);
    const origin = service.trustedOrigin(req.get('origin'));
    res.json(await service.removePasskey(userId, origin, passkeyId(req.params.id), stepUp(req.body), stepUpWho(req)));
  }));
  router.post('/caps/challenge', asyncHandler(async (req, res) => {
    const userId = user(req);
    const origin = service.trustedOrigin(req.get('origin'));
    const input = capsInput(req.body);
    res.json(await withRetryAfter(res, () => service.capsChallenge(userId, origin, input)));
  }));
  router.put('/caps', asyncHandler(async (req, res) => {
    const userId = user(req);
    // Lowering works from any signed-in page; raising is refused by the service unless the origin is trusted.
    const origin = service.optionalTrustedOrigin(req.get('origin'));
    const request = capsRequest(req.body);
    res.json(await withRetryAfter(res, () => service.updateCaps(userId, origin, request)));
  }));
  router.post('/mode/challenge', asyncHandler(async (req, res) => {
    const userId = user(req);
    const origin = service.trustedOrigin(req.get('origin'));
    const mode = tradingMode(record(req.body).mode);
    res.json(await withRetryAfter(res, () => service.modeChallenge(userId, origin, mode)));
  }));
  router.put('/mode', asyncHandler(async (req, res) => {
    const userId = user(req);
    // Narrowing (including off) works from any signed-in page; widening is refused unless the origin is trusted.
    const origin = service.optionalTrustedOrigin(req.get('origin'));
    const request = modeRequest(req.body);
    res.json(await withRetryAfter(res, () => service.updateMode(userId, origin, request)));
  }));
  return router;
}
