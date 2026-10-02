import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createTrading212BrokerClient } from '../trading212-broker.client.js';
import { createTrading212OrdersService } from '../trading212-orders.service.js';

type Seen = { method: string; url: string; body: any };
type Handler = (seen: Seen, res: http.ServerResponse, req: http.IncomingMessage) => void;

const ORIGIN = 'https://studio.ajarche.com';
const STATUS = {
  version: 1, allowedEnvs: ['demo'], maxOrderValue: 250, maxOrdersPerHour: 10, origins: [ORIGIN], demoConfirm: false,
  keys: { live: false, demo: true }, currencies: {}, passkeys: [{ id: 'k1', rpId: 'studio.ajarche.com', label: 'iPad', createdAt: '2026-10-02T00:00:00Z', lastUsedAt: null }],
};

/** A stand-in for the order broker: HTTP over a unix socket, answering with whatever the test's handler decides. */
async function fakeBroker(handler: Handler) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 't212-fake-broker-'));
  const socketPath = path.join(directory, 'broker.sock');
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const entry = { method: String(req.method), url: String(req.url), body: text ? JSON.parse(text) : undefined };
      seen.push(entry);
      handler(entry, res, req);
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  return {
    socketPath, seen,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); },
  };
}
function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function reads() {
  const invalidated: string[] = [];
  return { invalidated, trading212: { lastCurrency: (env: string) => (env === 'demo' ? 'GBP' : null), invalidate: (env: 'live' | 'demo') => { invalidated.push(env); } } };
}

test('without STUDIO_T212_BROKER_SOCKET ordering is off and nothing can place an order', async () => {
  const { trading212 } = reads();
  const service = createTrading212OrdersService({ broker: null, trading212 });
  const config = await service.config();
  assert.equal(config.broker.status, 'off');
  assert.deepEqual(config.allowedEnvs, []);
  assert.match('message' in config.broker ? config.broker.message : '', /STUDIO_T212_BROKER_SOCKET/);
  await assert.rejects(service.preview(ORIGIN, { env: 'demo' }, false), (error: Error & { code?: string; statusCode?: number }) =>
    error.code === 'T212_BROKER_OFF' && error.statusCode === 503);
  await assert.rejects(service.confirm(ORIGIN, '00000000-0000-0000-0000-000000000000', { confirmed: true }), /docs\/t212-broker\.md/);
  await assert.rejects(service.passkeyOptions(ORIGIN, 'CODE'), (error: Error & { code?: string }) => error.code === 'T212_BROKER_OFF');
});

test('settings show the broker’s own configuration, falling back to Studio’s stored currency', async () => {
  const broker = await fakeBroker((_seen, res) => json(res, 200, STATUS));
  try {
    const { trading212 } = reads();
    const service = createTrading212OrdersService({ broker: createTrading212BrokerClient({ socketPath: broker.socketPath }), trading212 });
    const config = await service.config();
    assert.deepEqual(config.broker, { status: 'ok', keys: { live: false, demo: true } });
    assert.deepEqual([config.allowedEnvs, config.maxOrderValue, config.trustedOrigins, config.demoConfirm], [['demo'], 250, [ORIGIN], false]);
    assert.equal('currency' in config ? config.currency : undefined, 'GBP');
    assert.deepEqual(config.passkeys.map(item => item.rpId), ['studio.ajarche.com']);
    assert.deepEqual(broker.seen.map(item => `${item.method} ${item.url}`), ['GET /v1/status']);
  } finally { await broker.close(); }
});

test('an unreachable broker leaves settings readable and refuses orders as unreachable', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 't212-no-broker-'));
  try {
    const { trading212 } = reads();
    const service = createTrading212OrdersService({ broker: createTrading212BrokerClient({ socketPath: path.join(directory, 'missing.sock') }), trading212 });
    const config = await service.config();
    assert.equal(config.broker.status, 'unreachable');
    assert.deepEqual(config.allowedEnvs, []);
    // Nothing was sent, so even a confirmation is a definite "not placed", not an unknown outcome.
    await assert.rejects(service.confirm(ORIGIN, '00000000-0000-0000-0000-000000000000', { assertion: { id: 'x' } }), (error: Error & { code?: string; statusCode?: number }) =>
      error.code === 'T212_BROKER_UNREACHABLE' && error.statusCode === 503);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('requests are relayed with the browser origin, and broker refusals keep their status and code', async () => {
  const broker = await fakeBroker((seen, res) => {
    if (seen.url === '/v1/orders/preview') { json(res, 403, { error: '先为 studio.ajarche.com 启用通行密钥', code: 'T212_PASSKEY_REQUIRED' }); return; }
    if (seen.url === '/v1/passkeys/registration-options') { json(res, 200, { challenge: 'reg-1' }); return; }
    if (seen.url === '/v1/passkeys/register') { json(res, 200, { id: 'k2', rpId: 'studio.ajarche.com', label: seen.body.label, createdAt: 'x', lastUsedAt: null }); return; }
    if (seen.url === '/v1/passkeys/remove') { json(res, 200, { removed: true }); return; }
    json(res, 418, { error: '<b>odd</b>'.repeat(100), code: 'not a code' });
  });
  try {
    const { trading212 } = reads();
    const service = createTrading212OrdersService({ broker: createTrading212BrokerClient({ socketPath: broker.socketPath }), trading212 });
    await assert.rejects(service.preview(ORIGIN, { env: 'live', ticker: 'AAPL_US_EQ' }, true), (error: Error & { code?: string; statusCode?: number }) =>
      error.code === 'T212_PASSKEY_REQUIRED' && error.statusCode === 403 && /启用通行密钥/.test(error.message));
    assert.deepEqual(broker.seen[0].body, { origin: ORIGIN, order: { env: 'live', ticker: 'AAPL_US_EQ' }, acknowledgeUnknown: true });

    assert.deepEqual(await service.passkeyOptions(ORIGIN, 'ABCDE-FGHJK-MNPQR-STVWX'), { challenge: 'reg-1' });
    assert.deepEqual(broker.seen[1].body, { origin: ORIGIN, enrollmentCode: 'ABCDE-FGHJK-MNPQR-STVWX' });
    const passkey = await service.registerPasskey(ORIGIN, { id: 'cred' }, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)');
    assert.equal(passkey.label, 'iPhone');
    assert.deepEqual(await service.removePasskey(ORIGIN, 'k2', { enrollmentCode: 'CODE' }), { removed: true });
    assert.deepEqual(broker.seen[3].body, { origin: ORIGIN, id: 'k2', enrollmentCode: 'CODE' });

    // An unexpected answer is reduced to a bounded message and a generic code.
    await assert.rejects(service.removalOptions(ORIGIN, 'k2'), (error: Error & { code?: string; statusCode?: number }) =>
      error.code === 'T212_BROKER_ERROR' && error.statusCode === 418 && error.message.length <= 300);
  } finally { await broker.close(); }
});

test('a placed order refreshes Studio’s cached reads; a broken connection after sending is an unknown outcome', async () => {
  let mode: 'placed' | 'drop' = 'placed';
  const broker = await fakeBroker((seen, res, req) => {
    if (mode === 'drop') { req.socket.destroy(); return; }
    json(res, 200, { order: { id: '9001', status: 'NEW', ticker: 'AAPL_US_EQ' }, method: 'passkey', env: 'demo', estimatedValue: 100, currency: 'GBP' });
  });
  try {
    const { trading212, invalidated } = reads();
    const service = createTrading212OrdersService({ broker: createTrading212BrokerClient({ socketPath: broker.socketPath }), trading212 });
    const assertion = { id: 'cred', rawId: 'cred', response: { signature: 's' } };
    const result = await service.confirm(ORIGIN, '00000000-0000-0000-0000-000000000001', { assertion });
    assert.equal(result.order.id, '9001');
    assert.deepEqual(broker.seen[0].body, { origin: ORIGIN, id: '00000000-0000-0000-0000-000000000001', assertion });
    assert.deepEqual(invalidated, ['demo']);

    mode = 'drop';
    await assert.rejects(service.confirm(ORIGIN, '00000000-0000-0000-0000-000000000002', { assertion }), (error: Error & { code?: string }) =>
      error.code === 'T212_ORDER_UNKNOWN' && /订单状态未知/.test(error.message));
    assert.deepEqual(invalidated, ['demo', 'live', 'demo']);
    // The same break on a preview is just "unavailable": nothing could have been placed.
    await assert.rejects(service.preview(ORIGIN, {}, false), (error: Error & { code?: string }) => error.code === 'T212_BROKER_UNREACHABLE');
    assert.equal(broker.seen.filter(item => item.url === '/v1/orders/confirm').length, 2, 'never retried');
  } finally { await broker.close(); }
});
