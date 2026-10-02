import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import { createTrading212BrokerClient } from '../trading212-broker.client.js';
import { createTrading212OrdersRouter } from '../trading212-orders.routes.js';
import { createTrading212OrdersService } from '../trading212-orders.service.js';

const ORIGIN = 'https://studio.ajarche.com';
const PREVIEW_ID = '11111111-2222-3333-4444-555555555555';

type Call = (route: string, init?: { method?: string; body?: unknown; origin?: string | null; user?: number | null }) => Promise<{ status: number; body: any }>;
type Seen = { url: string; body: any };

async function withApp(run: (call: Call, seen: Seen[]) => Promise<void>, options: { broker?: boolean } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 't212-orders-routes-'));
  const socketPath = path.join(directory, 'broker.sock');
  const seen: Seen[] = [];
  // The fake broker answers every call with what the request asked for, so the tests can see what Studio relayed.
  const broker = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      seen.push({ url: String(req.url), body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/v1/status'
        ? { version: 1, allowedEnvs: ['demo'], maxOrderValue: 500, maxOrdersPerHour: 10, origins: [ORIGIN], demoConfirm: false, keys: { live: false, demo: true }, currencies: { demo: 'GBP' }, passkeys: [] }
        : { relayed: req.url }));
    });
  });
  await new Promise<void>(resolve => broker.listen(socketPath, resolve));
  const service = createTrading212OrdersService({
    broker: options.broker === false ? null : createTrading212BrokerClient({ socketPath }),
    trading212: { lastCurrency: () => null, invalidate: () => {} },
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = Number(req.get('x-test-user'));
    if (id) (req as express.Request & { user?: { id: number } }).user = { id };
    next();
  });
  app.use('/trading212', createTrading212OrdersRouter(service));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ error: error instanceof Error ? error.message : 'error', code: error instanceof AppError ? error.code : undefined });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(async (route, init = {}) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (iPad; CPU OS 18_0)' };
      if (init.user !== null) headers['x-test-user'] = String(init.user ?? 1);
      if (init.origin !== null) headers.Origin = init.origin ?? ORIGIN;
      const response = await fetch(`${base}${route}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
      return { status: response.status, body: await response.json() };
    }, seen);
  } finally {
    server.close();
    broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('routes need a signed-in user and an exact Origin header before anything reaches the broker', async () => {
  await withApp(async (call, seen) => {
    assert.equal((await call('/trading212/trading', { user: null })).status, 401);
    assert.equal((await call('/trading212/orders/preview', { method: 'POST', body: {}, user: null })).status, 401);
    for (const origin of [null, 'null', `${ORIGIN}/`, 'not a url']) {
      const reply = await call('/trading212/orders/preview', { method: 'POST', body: { env: 'demo' }, origin });
      assert.deepEqual([reply.status, reply.body.code], [403, 'T212_UNTRUSTED_ORIGIN'], String(origin));
    }
    assert.equal(seen.length, 0);
    const config = await call('/trading212/trading');
    assert.equal(config.status, 200);
    assert.deepEqual([config.body.broker.status, config.body.allowedEnvs, config.body.currency], ['ok', ['demo'], 'GBP']);
  });
});

test('only order fields and the origin are relayed; the broker validates the values', async () => {
  await withApp(async (call, seen) => {
    // An acknowledgeUnknown flag (any value) is not relayed: the broker's hold after an unknown outcome cannot be lifted from Studio.
    for (const acknowledgeUnknown of ['yes', true]) {
      const body = { env: 'demo', ticker: 'AAPL_US_EQ', side: 'buy', type: 'limit', quantity: 1, limitPrice: 10, timeValidity: 'DAY', userId: 7, acknowledgeUnknown };
      assert.equal((await call('/trading212/orders/preview', { method: 'POST', body })).status, 200);
      assert.deepEqual(seen.at(-1), {
        url: '/v1/orders/preview',
        body: { origin: ORIGIN, order: { env: 'demo', ticker: 'AAPL_US_EQ', side: 'buy', type: 'limit', quantity: 1, limitPrice: 10, timeValidity: 'DAY' } },
      });
    }
  });
});

test('confirming relays the passkey assertion and rejects malformed proofs and ids', async () => {
  await withApp(async (call, seen) => {
    const assertion = { id: 'cred', rawId: 'cred', type: 'public-key', response: { signature: 'sig' } };
    assert.equal((await call(`/trading212/orders/${PREVIEW_ID}/confirm`, { method: 'POST', body: { assertion } })).status, 200);
    assert.deepEqual(seen[0], { url: '/v1/orders/confirm', body: { origin: ORIGIN, id: PREVIEW_ID, assertion } });
    assert.equal((await call(`/trading212/orders/${PREVIEW_ID}/confirm`, { method: 'POST', body: {} })).status, 400);
    assert.equal((await call(`/trading212/orders/${PREVIEW_ID}/confirm`, { method: 'POST', body: { assertion: { id: 'x' } } })).status, 400);
    assert.equal((await call('/trading212/orders/not-an-id/confirm', { method: 'POST', body: { confirmed: true } })).status, 404);
    assert.equal(seen.length, 1);
  });
});

test('passkey enrollment asks for the enrollment code, not the Studio password', async () => {
  await withApp(async (call, seen) => {
    const missing = await call('/trading212/passkey/options', { method: 'POST', body: { password: 'studio-password' } });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /注册码/);
    assert.equal((await call('/trading212/passkey/options', { method: 'POST', body: { enrollmentCode: 'ABCDE-FGHJK-MNPQR-STVWX' } })).status, 200);
    assert.deepEqual(seen[0].body, { origin: ORIGIN, enrollmentCode: 'ABCDE-FGHJK-MNPQR-STVWX' });

    const response = { id: 'cred', rawId: 'cred', type: 'public-key', response: { attestationObject: 'x' } };
    assert.equal((await call('/trading212/passkey', { method: 'POST', body: { response } })).status, 201);
    assert.deepEqual(seen[1].body, { origin: ORIGIN, response, label: 'iPad' });

    assert.equal((await call(`/trading212/passkey/${PREVIEW_ID}/remove/options`, { method: 'POST', body: {} })).status, 200);
    assert.deepEqual(seen[2].body, { origin: ORIGIN, id: PREVIEW_ID });
    assert.equal((await call(`/trading212/passkey/${PREVIEW_ID}/remove`, { method: 'POST', body: { password: 'studio-password' } })).status, 400);
    assert.equal((await call(`/trading212/passkey/${PREVIEW_ID}/remove`, { method: 'POST', body: { enrollmentCode: 'CODE-CODE' } })).status, 200);
    assert.deepEqual(seen[3].body, { origin: ORIGIN, id: PREVIEW_ID, enrollmentCode: 'CODE-CODE' });
  });
});

test('without a broker the settings explain it and every order route answers 503', async () => {
  await withApp(async (call, seen) => {
    const config = await call('/trading212/trading');
    assert.deepEqual([config.status, config.body.broker.status, config.body.allowedEnvs], [200, 'off', []]);
    const preview = await call('/trading212/orders/preview', { method: 'POST', body: { env: 'demo' } });
    assert.deepEqual([preview.status, preview.body.code], [503, 'T212_BROKER_OFF']);
    assert.equal((await call('/trading212/passkey/options', { method: 'POST', body: { enrollmentCode: 'X' } })).status, 503);
    assert.equal(seen.length, 0);
  }, { broker: false });
});
