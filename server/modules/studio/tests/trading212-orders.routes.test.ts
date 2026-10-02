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

async function withApp(run: (call: (route: string, init?: { method?: string; body?: unknown; origin?: string | null; user?: number | null }) => Promise<{ status: number; body: any }>, posts: () => string[]) => Promise<void>) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 't212-orders-routes-'));
  const envFile = path.join(directory, '.env');
  writeFileSync(envFile, 'TRADING212_API_KEY=fake-route-key\nTRADING212_API_SECRET=fake-route-secret\n');
  const database = new Database(':memory:');
  const brokerPosts: string[] = [];
  const trading212 = createTrading212Service({
    database, envFiles: { demo: envFile },
    request: (async (url: string, init: RequestInit) => {
      if (init.method === 'POST') { brokerPosts.push(String(init.body)); return Response.json({ id: 1, status: 'NEW' }); }
      if (String(url).endsWith('/summary')) return Response.json({ currency: 'GBP', totalValue: 100, cash: { availableToTrade: 100 }, investments: {} });
      if (String(url).includes('/positions')) return Response.json([{ instrument: { ticker: 'AAPL_US_EQ' }, quantity: 1, currentPrice: 200, walletImpact: { currentValue: 160 } }]);
      return Response.json({ items: [] });
    }) as unknown as typeof fetch,
  });
  const orders = createTrading212OrdersService({ database, trading212, trading: 'demo', origins: [ORIGIN] });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = Number(req.get('x-test-user'));
    if (id) (req as express.Request & { user?: { id: number } }).user = { id };
    next();
  });
  // Mounted exactly like studio.module: the read-only router first, then the orders router on the same path.
  app.use('/trading212', createTrading212Router(trading212));
  app.use('/trading212', createTrading212OrdersRouter(orders));
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
      return { status: response.status, body: await response.json() };
    }, () => brokerPosts);
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
    assert.equal(config.body.maxOrderValue, 500);
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

    assert.equal((await call('/trading212/passkey/not-an-id', { method: 'DELETE' })).status, 404);
    assert.equal((await call('/trading212/passkey', { method: 'POST', body: { response: { id: 'x' } } })).status, 400);
  });
});
