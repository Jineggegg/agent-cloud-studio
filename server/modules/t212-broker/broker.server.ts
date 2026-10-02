import http from 'node:http';

import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

import type { StudioT212BrokerErrorBody, StudioT212OrderInput } from '@/shared/types.js';

import { BrokerError } from './broker-error.js';
import type { createBrokerService } from './broker.service.js';

type Service = Pick<ReturnType<typeof createBrokerService>,
  'status' | 'preview' | 'confirm' | 'registrationOptions' | 'register' | 'removalOptions' | 'removePasskey'>;
type Body = Record<string, unknown>;
type Route = (body: Body) => unknown;
type Options = {
  log?: (line: string) => void;
  // Requests per rolling minute across all callers (the socket gives no caller identity to limit by).
  maxRequestsPerMinute?: number;
  now?: () => number;
};

// The largest legitimate body is a WebAuthn registration response (a few KiB); anything bigger is refused.
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_REQUESTS_PER_MINUTE = 120;
// Trading 212 tickers look like AAPL_US_EQ or VODl_EQ.
const TICKER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const ID = /^[0-9a-f-]{36}$/;
const MAX_QUANTITY = 1_000_000;
const MAX_PRICE = 10_000_000;

function invalid(message: string): never {
  throw new BrokerError(message, 400, 'INVALID_REQUEST');
}
function record(value: unknown): Body {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Body : {};
}
function hasDecimals(value: number, places: number) {
  const scaled = value * 10 ** places;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}
function origin(body: Body) {
  if (typeof body.origin !== 'string' || !body.origin || body.origin.length > 200) invalid('缺少来源网址');
  return body.origin;
}
function id(body: Body) {
  if (typeof body.id !== 'string' || !ID.test(body.id)) throw new BrokerError('找不到这条记录', 404, 'NOT_FOUND');
  return body.id;
}
function orderInput(value: unknown): StudioT212OrderInput {
  const input = record(value);
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
// WebAuthn responses are verified cryptographically by the service; here only the JSON envelope is checked.
function credential(value: unknown) {
  const item = record(value);
  if (typeof item.id !== 'string' || !item.id || item.id.length > 1024 || typeof item.rawId !== 'string'
    || !Object.keys(record(item.response)).length) {
    invalid('通行密钥响应格式无效');
  }
  return item;
}
function enrollmentCode(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 64) invalid('请输入注册码');
  return value;
}
// A device name hint from Studio; reduced to plain characters because it is shown back in Settings.
function label(value: unknown) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[^\p{L}\p{N} /._-]/gu, '').trim().slice(0, 40);
  return clean || null;
}

/**
 * Used by the broker CLI (`serve`) and the broker tests: HTTP/1.1 over the broker's unix socket. HTTP (rather
 * than JSON lines) gives framing, status codes and header/request timeouts from Node's built-in server, and
 * the owner can probe it with `curl --unix-socket`. Every POST carries a JSON body of at most 64 KiB; routes only
 * parse and validate it and call the service, because every caller is untrusted (Studio's OS user can reach the
 * socket from a terminal too). Logs contain method, path, status and duration, never bodies.
 */
export function createBrokerSocketServer(service: Service, options: Options = {}) {
  const log = options.log ?? ((line: string) => console.log(`[t212-broker] ${line}`));
  const now = options.now ?? Date.now;
  const maxPerMinute = options.maxRequestsPerMinute ?? DEFAULT_MAX_REQUESTS_PER_MINUTE;
  const recent: number[] = [];

  const routes: Record<string, Route> = {
    'GET /v1/status': () => service.status(),
    'POST /v1/orders/preview': body => service.preview({
      origin: origin(body), order: orderInput(body.order), acknowledgeUnknown: body.acknowledgeUnknown === true,
    }),
    'POST /v1/orders/confirm': body => {
      const proof = body.assertion !== undefined
        ? { assertion: credential(body.assertion) as unknown as AuthenticationResponseJSON }
        : body.confirmed === true ? { confirmed: true as const } : invalid('需要通行密钥验证');
      return service.confirm({ origin: origin(body), id: id(body), proof });
    },
    'POST /v1/passkeys/registration-options': body => service.registrationOptions({ origin: origin(body), enrollmentCode: enrollmentCode(body.enrollmentCode) }),
    'POST /v1/passkeys/register': body => service.register({
      origin: origin(body), response: credential(body.response) as unknown as RegistrationResponseJSON, label: label(body.label),
    }),
    'POST /v1/passkeys/removal-options': body => service.removalOptions({ origin: origin(body), id: id(body) }),
    'POST /v1/passkeys/remove': body => {
      const proof = body.assertion !== undefined
        ? { assertion: credential(body.assertion) as unknown as AuthenticationResponseJSON }
        : { enrollmentCode: enrollmentCode(body.enrollmentCode) };
      return service.removePasskey({ origin: origin(body), id: id(body), proof });
    },
  };

  function rateLimited() {
    const time = now();
    while (recent.length && recent[0] <= time - 60_000) recent.shift();
    if (recent.length >= maxPerMinute) return true;
    recent.push(time);
    return false;
  }
  function readBody(req: http.IncomingMessage) {
    return new Promise<Body>((resolve, reject) => {
      const declared = Number(req.headers['content-length'] ?? 0);
      if (declared > MAX_BODY_BYTES) { reject(new BrokerError('请求太大', 413, 'TOO_LARGE')); req.resume(); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { reject(new BrokerError('请求太大', 413, 'TOO_LARGE')); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!size) { resolve({}); return; }
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
          resolve(parsed as Body);
        } catch { reject(new BrokerError('请求不是有效的 JSON 对象', 400, 'INVALID_REQUEST')); }
      });
      req.on('error', reject);
    });
  }

  const server = http.createServer((req, res) => {
    const started = now();
    const path = (req.url ?? '').split('?')[0];
    const key = `${req.method} ${path}`;
    const send = (status: number, payload: unknown) => {
      if (res.headersSent || res.destroyed) return;
      const text = JSON.stringify(payload);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
      res.end(text);
      log(`${key.slice(0, 80)} -> ${status} ${now() - started}ms`);
    };
    const sendError = (error: BrokerError) => send(error.statusCode, { error: error.message, code: error.code } satisfies StudioT212BrokerErrorBody);
    void (async () => {
      try {
        const route = routes[key];
        if (!route) throw new BrokerError('没有这个接口', 404, 'NOT_FOUND');
        if (rateLimited()) throw new BrokerError('请求过于频繁，请稍后再试', 429, 'RATE_LIMITED');
        if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
          throw new BrokerError('请求必须是 JSON', 415, 'UNSUPPORTED_MEDIA_TYPE');
        }
        const body = req.method === 'POST' ? await readBody(req) : {};
        send(200, await route(body));
      } catch (error) {
        if (error instanceof BrokerError) { sendError(error); return; }
        log(`internal error on ${key.slice(0, 80)}: ${error instanceof Error ? error.name : 'unknown'}`);
        sendError(new BrokerError('交易代理内部错误', 500, 'BROKER_INTERNAL'));
      }
    })();
  });
  // Slow or idle callers cannot hold connections open; Trading 212 calls themselves time out after 15 s.
  server.headersTimeout = 10_000;
  server.requestTimeout = 45_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  server.maxConnections = 32;
  return server;
}
