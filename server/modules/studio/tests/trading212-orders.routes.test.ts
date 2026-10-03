import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';

import Database from 'better-sqlite3';
import express from 'express';

import { AppError } from '@/shared/utils.js';

import { createTrading212Service } from '../trading212.service.js';
import { createTrading212Router } from '../trading212.routes.js';
import { createTrading212OrdersService } from '../trading212-orders.service.js';
import { createTrading212OrdersRouter } from '../trading212-orders.routes.js';

const ORIGIN = 'https://studio.ajarche.com';

type Call = (route: string, init?: { method?: string; body?: unknown; origin?: string | null; user?: number | null }) => Promise<{ status: number; body: any; headers: Headers }>;

async function withApp(run: (call: Call, posts: () => string[], setOrderStatus: (status: number) => void) => Promise<void>) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 't212-orders-routes-'));
  const envFile = path.join(directory, '.env');
  writeFileSync(envFile, 'TRADING212_API_KEY=fake-route-key\nTRADING212_API_SECRET=fake-route-secret\n');
  const database = new Database(':memory:');
  const brokerPosts: string[] = [];
  let orderStatus = 200;
  const trading212 = createTrading212Service({
    database, envFiles: { demo: envFile },
    request: (async (url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        brokerPosts.push(String(init.body));
        return orderStatus === 200 ? Response.json({ id: 1, status: 'NEW' }) : new Response('', { status: orderStatus });
      }
      if (String(url).endsWith('/summary')) return Response.json({ currency: 'GBP', totalValue: 100, cash: { availableToTrade: 100 }, investments: {} });
      if (String(url).includes('/positions')) return Response.json([{ instrument: { ticker: 'AAPL_US_EQ' }, quantity: 1, currentPrice: 200, walletImpact: { currentValue: 160 } }]);
      return Response.json({ items: [] });
    }) as unknown as typeof fetch,
  });
  const orders = createTrading212OrdersService({
    database, trading212, trading: 'demo', origins: [ORIGIN],
    verifyStepUp: async (_who, password) => {
      if (password !== 'route-password') throw new AppError('密码不正确', { code: 'AUTH_STEP_UP_FAILED', statusCode: 403 });
    },
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = Number(req.get('x-test-user'));
    if (id) (req as express.Request & { user?: { id: number } }).user = { id };
    next();
  });
  // Mounted exactly like studio.module: the read-only router first, then the orders router on the same path.
  app.use('/trading212', createTrading212Router(trading212));
  app.use('/trading212', createTrading212OrdersRouter(orders, (req) => ({ door: 'direct', address: req.socket.remoteAddress ?? 'unknown' })));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ error: error instanceof Error ? error.message : 'error' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(async (route, init = {}) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (init.user !== null) headers['x-test-user'] = String(init.user ?? 1);
      if (init.origin !== null) headers.Origin = init.origin ?? ORIGIN;
      const response = await fetch(`${base}${route}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
      return { status: response.status, body: await response.json(), headers: response.headers };
    }, () => brokerPosts, status => { orderStatus = status; });
  } finally {
    server.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('both routers share /trading212 and the orders routes require a signed-in user and a trusted origin', async () => {
  await withApp(async (call, posts) => {
    assert.equal((await call('/trading212/status')).status, 200);
    const config = await call('/trading212/trading');
    assert.equal(config.status, 200);
    assert.deepEqual(config.body.allowedEnvs, ['demo']);
    assert.equal(config.body.caps.envs.demo.maxOrderValue, 500);
    assert.equal(config.body.caps.envs.demo.dailyLimit, 2000);
    assert.equal(config.body.caps.ceiling, 10000);
    assert.equal((await call('/trading212/trading', { user: null })).status, 401);

    const valid = { env: 'demo', ticker: 'AAPL_US_EQ', side: 'buy', type: 'market', quantity: 0.5 };
    assert.equal((await call('/trading212/orders/preview', { method: 'POST', body: valid, origin: null })).status, 403);
    assert.equal((await call('/trading212/orders/preview', { method: 'POST', body: valid, origin: 'https://evil.example' })).status, 403);
    assert.equal(posts().length, 0);
  });
});

test('order input is validated before the service runs', async () => {
  await withApp(async (call) => {
    const base = { env: 'demo', ticker: 'AAPL_US_EQ', side: 'buy', type: 'market', quantity: 1 };
    const invalid = [
      { ...base, env: 'paper' },
      { ...base, ticker: 'AAPL US' },
      { ...base, side: 'short' },
      { ...base, quantity: -1 },
      { ...base, quantity: '1' },
      { ...base, quantity: 0.1234567 },
      { ...base, limitPrice: 10 },
      { ...base, type: 'limit' },
      { ...base, type: 'limit', limitPrice: 1.23456 },
      { ...base, type: 'limit', limitPrice: 10, timeValidity: 'FOREVER' },
    ];
    for (const body of invalid) {
      const response = await call('/trading212/orders/preview', { method: 'POST', body });
      assert.equal(response.status, 400, JSON.stringify(body));
    }
  });
});

test('preview then confirm over HTTP places one order; malformed confirmations are refused', async () => {
  await withApp(async (call, posts) => {
    const preview = await call('/trading212/orders/preview', { method: 'POST', body: { env: 'demo', ticker: 'AAPL_US_EQ', side: 'sell', type: 'market', quantity: 1 } });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.requires, 'confirm');
    assert.equal(preview.body.estimatedValue, 160);

    assert.equal((await call(`/trading212/orders/${preview.body.id}/confirm`, { method: 'POST', body: {} })).status, 400);
    assert.equal((await call(`/trading212/orders/${preview.body.id}/confirm`, { method: 'POST', body: { assertion: { id: 'x' } } })).status, 400);
    assert.equal((await call('/trading212/orders/not-an-id/confirm', { method: 'POST', body: { confirmed: true } })).status, 404);

    const placed = await call(`/trading212/orders/${preview.body.id}/confirm`, { method: 'POST', body: { confirmed: true } });
    assert.equal(placed.status, 200);
    assert.equal(placed.body.order.status, 'NEW');
    assert.deepEqual(posts(), [JSON.stringify({ ticker: 'AAPL_US_EQ', quantity: -1 })]);

    assert.equal((await call('/trading212/passkey/not-an-id/remove', { method: 'POST', body: { password: 'route-password' } })).status, 404);
    assert.equal((await call('/trading212/passkey', { method: 'POST', body: { response: { id: 'x' } } })).status, 400);
  });
});

test('passkey changes need a step-up: a password to add, a password or that passkey to remove', async () => {
  await withApp(async (call) => {
    const id = '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f';
    assert.equal((await call('/trading212/passkey/options', { method: 'POST', body: {} })).status, 400);
    assert.equal((await call('/trading212/passkey/options', { method: 'POST', body: { password: 42 } })).status, 400);
    assert.equal((await call('/trading212/passkey/options', { method: 'POST', body: { password: 'x'.repeat(1025) } })).status, 400);
    assert.equal((await call('/trading212/passkey/options', { method: 'POST', body: { password: 'wrong' } })).status, 403);
    assert.equal((await call('/trading212/passkey/options', { method: 'POST', body: { password: 'route-password' }, origin: 'https://evil.example' })).status, 403);
    const options = await call('/trading212/passkey/options', { method: 'POST', body: { password: 'route-password' } });
    assert.equal(options.status, 200);
    assert.equal(options.body.authenticatorSelection.userVerification, 'required');

    // Removal: no proof is malformed; a valid proof for a passkey that does not exist is a 404.
    assert.equal((await call(`/trading212/passkey/${id}/remove`, { method: 'POST', body: {} })).status, 400);
    assert.equal((await call(`/trading212/passkey/${id}/remove`, { method: 'POST', body: { assertion: { id: 'x' } } })).status, 400);
    assert.equal((await call(`/trading212/passkey/${id}/remove`, { method: 'POST', body: { password: 'route-password' } })).status, 404);
    assert.equal((await call(`/trading212/passkey/${id}/remove/options`, { method: 'POST' })).status, 404);
    assert.equal((await call(`/trading212/passkey/${id}/remove`, { method: 'POST', body: { password: 'route-password' }, user: null })).status, 401);
  });
});

test('cap edits are validated in the route; lowering works from any page, raising needs a trusted origin and a passkey', async () => {
  await withApp(async (call) => {
    const invalid = [
      {}, { env: 'paper', maxOrderValue: 100, dailyLimit: 200 }, { env: 'demo', maxOrderValue: '100', dailyLimit: 200 },
      { env: 'demo', maxOrderValue: 0, dailyLimit: 200 }, { env: 'demo', maxOrderValue: -1, dailyLimit: 200 },
      { env: 'demo', maxOrderValue: 100.123, dailyLimit: 200 }, { env: 'demo', maxOrderValue: 100, dailyLimit: null },
      { env: 'demo', maxOrderValue: 100, dailyLimit: 1e12 },
      { env: 'demo', maxOrderValue: 100, dailyLimit: 200, challengeId: 'not-an-id', assertion: { id: 'x', rawId: 'x', response: { a: 1 } } },
      { env: 'demo', maxOrderValue: 100, dailyLimit: 200, challengeId: '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f' },
    ];
    for (const body of invalid) {
      assert.equal((await call('/trading212/caps', { method: 'PUT', body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await call('/trading212/caps', { method: 'PUT', body: { env: 'demo', maxOrderValue: 100, dailyLimit: 200 }, user: null })).status, 401);

    // Lowering needs neither a passkey nor an allowlisted page.
    const lowered = await call('/trading212/caps', { method: 'PUT', body: { env: 'demo', maxOrderValue: 100, dailyLimit: 200 }, origin: null });
    assert.equal(lowered.status, 200);
    assert.equal(lowered.body.method, 'session');
    assert.equal(lowered.body.caps.maxOrderValue, 100);
    assert.equal(lowered.body.caps.dailyRemaining, 200);
    const config = await call('/trading212/trading');
    assert.equal(config.body.caps.envs.demo.dailyLimit, 200);
    assert.equal(config.body.capChanges[0].direction, 'lower');

    // Above the ceiling, from an untrusted page, or without any passkey, nothing is raised.
    assert.equal((await call('/trading212/caps', { method: 'PUT', body: { env: 'demo', maxOrderValue: 100, dailyLimit: 10_001 } })).status, 400);
    assert.equal((await call('/trading212/caps/challenge', { method: 'POST', body: { env: 'demo', maxOrderValue: 300, dailyLimit: 600 }, origin: 'https://evil.example' })).status, 403);
    assert.equal((await call('/trading212/caps/challenge', { method: 'POST', body: { env: 'demo', maxOrderValue: 300, dailyLimit: 600 } })).status, 403);
    assert.equal((await call('/trading212/caps', { method: 'PUT', body: { env: 'demo', maxOrderValue: 300, dailyLimit: 600 } })).status, 403);
    const after = (await call('/trading212/trading')).body;
    assert.equal(after.caps.envs.demo.maxOrderValue, 100);
    // Applied changes and refused raises are listed apart.
    assert.deepEqual(after.capChanges.map((item: { direction: string }) => item.direction), ['lower']);
    assert.ok(after.capRefusals.length >= 2);
  });
});

test('a malformed raise naming a challenge is still audited, and repeated refusals get 429 with Retry-After', async () => {
  await withApp(async (call) => {
    const id = '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f';
    const malformed = await call('/trading212/caps', { method: 'PUT', body: { challengeId: id, env: 'demo', maxOrderValue: 'lots', dailyLimit: 600 } });
    assert.equal(malformed.status, 400);
    const [entry] = (await call('/trading212/trading')).body.capRefusals;
    assert.equal(entry.method, 'passkey');
    assert.equal(entry.reason, '上限必须是大于 0 的数字，最多 2 位小数');
    // An assertion without a challenge id is a raise attempt as well.
    assert.equal((await call('/trading212/caps', { method: 'PUT', body: { env: 'demo', maxOrderValue: 300, dailyLimit: 600, assertion: { id: 'x', rawId: 'x', response: { a: 1 } } } })).status, 400);
    assert.equal((await call('/trading212/trading')).body.capRefusals.length, 2);

    const raise = { env: 'demo', maxOrderValue: 900, dailyLimit: 2000 };
    for (let index = 0; index < 8; index += 1) assert.equal((await call('/trading212/caps', { method: 'PUT', body: raise })).status, 403);
    const limited = await call('/trading212/caps', { method: 'PUT', body: raise });
    assert.equal(limited.status, 429);
    assert.match(limited.body.error, /次数过多/);
    const wait = Number(limited.headers.get('retry-after'));
    assert.ok(wait > 3500 && wait <= 3600, String(wait));
    assert.equal((await call('/trading212/trading')).body.capRefusals.length, 10);
    // Lowering is never rate-limited.
    assert.equal((await call('/trading212/caps', { method: 'PUT', body: { env: 'demo', maxOrderValue: 100, dailyLimit: 200 } })).status, 200);
  });
});

test('an identical order after an unknown outcome needs acknowledgeUnknown to be literally true', async () => {
  await withApp(async (call, posts, setOrderStatus) => {
    const order = { env: 'demo', ticker: 'AAPL_US_EQ', side: 'sell', type: 'market', quantity: 1 };
    setOrderStatus(504);
    const preview = await call('/trading212/orders/preview', { method: 'POST', body: order });
    const unknown = await call(`/trading212/orders/${preview.body.id}/confirm`, { method: 'POST', body: { confirmed: true } });
    assert.equal(unknown.status, 502);
    assert.match(unknown.body.error, /订单状态未知/);
    setOrderStatus(200);

    assert.equal((await call('/trading212/orders/preview', { method: 'POST', body: order })).status, 409);
    assert.equal((await call('/trading212/orders/preview', { method: 'POST', body: { ...order, acknowledgeUnknown: 'true' } })).status, 409);
    const acknowledged = await call('/trading212/orders/preview', { method: 'POST', body: { ...order, acknowledgeUnknown: true } });
    assert.equal(acknowledged.status, 200);
    assert.equal(posts().length, 1);
  });
});

test('the trading mode is validated in the route; narrowing works from any page, widening needs a trusted origin and a passkey', async () => {
  await withApp(async (call, posts) => {
    const config = await call('/trading212/trading');
    assert.deepEqual(config.body.allowedEnvs, ['demo']);
    assert.deepEqual(config.body.tradingMode, { mode: 'demo', ceiling: 'demo', custom: false, updatedAt: null });
    assert.deepEqual(config.body.modeChanges, []);

    const id = '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f';
    const invalid = [
      {}, { mode: 'paper' }, { mode: 1 }, { mode: 'DEMO' },
      { mode: 'demo', challengeId: 'not-an-id', assertion: { id: 'x', rawId: 'x', response: { a: 1 } } },
      { mode: 'demo', challengeId: id },
    ];
    for (const body of invalid) assert.equal((await call('/trading212/mode', { method: 'PUT', body })).status, 400, JSON.stringify(body));
    assert.equal((await call('/trading212/mode/challenge', { method: 'POST', body: { mode: 'paper' } })).status, 400);
    assert.equal((await call('/trading212/mode', { method: 'PUT', body: { mode: 'off' }, user: null })).status, 401);
    assert.equal((await call('/trading212/mode/challenge', { method: 'POST', body: { mode: 'demo' }, user: null })).status, 401);

    // Narrowing (here: off) needs neither a passkey nor an allowlisted page, and previews stop at once.
    const off = await call('/trading212/mode', { method: 'PUT', body: { mode: 'off' }, origin: null });
    assert.equal(off.status, 200);
    assert.equal(off.body.method, 'session');
    assert.deepEqual(off.body.allowedEnvs, []);
    assert.equal(off.body.tradingMode.mode, 'off');
    const preview = await call('/trading212/orders/preview', { method: 'POST', body: { env: 'demo', ticker: 'AAPL_US_EQ', side: 'sell', type: 'market', quantity: 1 } });
    assert.equal(preview.status, 403);
    assert.match(preview.body.error, /模拟盘下单已在「设置 → 交易安全」关闭/);

    // Outside STUDIO_T212_TRADING=demo, from an untrusted page, or without a passkey, nothing is widened.
    const live = await call('/trading212/mode', { method: 'PUT', body: { mode: 'live' } });
    assert.equal(live.status, 403);
    assert.match(live.body.error, /服务器未开启实盘下单/);
    assert.equal((await call('/trading212/mode/challenge', { method: 'POST', body: { mode: 'demo' }, origin: 'https://evil.example' })).status, 403);
    const challenge = await call('/trading212/mode/challenge', { method: 'POST', body: { mode: 'demo' } });
    assert.equal(challenge.status, 403);
    assert.match(challenge.body.error, /启用面容 ID 后才能开启/);
    assert.equal((await call('/trading212/mode', { method: 'PUT', body: { mode: 'demo' } })).status, 403);

    const after = (await call('/trading212/trading')).body;
    assert.deepEqual(after.allowedEnvs, []);
    assert.deepEqual(after.modeChanges.map((item: { from: string; to: string }) => [item.from, item.to]), [['demo', 'off']]);
    // Two malformed attempts that named a challenge, the ceiling and the passkey-less widening.
    assert.equal(after.modeRefusals.length, 4);

    // Repeated refusals get a 429 with Retry-After; narrowing is never limited.
    for (let index = 0; index < 6; index += 1) assert.equal((await call('/trading212/mode', { method: 'PUT', body: { mode: 'demo' } })).status, 403);
    const limited = await call('/trading212/mode', { method: 'PUT', body: { mode: 'demo' } });
    assert.equal(limited.status, 429);
    assert.match(limited.body.error, /次数过多/);
    const wait = Number(limited.headers.get('retry-after'));
    assert.ok(wait > 3500 && wait <= 3600, String(wait));
    assert.equal(posts().length, 0);
  });
});
