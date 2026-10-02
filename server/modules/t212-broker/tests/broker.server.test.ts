import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createBrokerSocketServer } from '../broker.server.js';

import { assertion, enroll, fixture, STUDIO } from './broker-fixture.js';

type Reply = { status: number; body: any };

function request(socketPath: string, method: string, route: string, body?: unknown, contentType = 'application/json') {
  return new Promise<Reply>((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ socketPath, method, path: route, headers: payload === undefined ? {} : { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(payload) } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function withSocket(run: (call: (method: string, route: string, body?: unknown, contentType?: string) => Promise<Reply>, f: ReturnType<typeof fixture>, logs: string[]) => Promise<void>,
  options: { maxRequestsPerMinute?: number } = {}) {
  const f = fixture();
  const directory = mkdtempSync(path.join(os.tmpdir(), 't212-broker-socket-'));
  const socketPath = path.join(directory, 'broker.sock');
  const logs: string[] = [];
  const server = createBrokerSocketServer(f.service, { log: line => logs.push(line), ...options });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  try {
    await run((method, route, body, contentType) => request(socketPath, method, route, body, contentType), f, logs);
  } finally {
    await new Promise(resolve => server.close(resolve));
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const ORDER_BODY = { env: 'live', ticker: 'AAPL_US_EQ', side: 'buy', type: 'market', quantity: 1 };

test('status is served over the unix socket and errors are { error, code } JSON', async () => {
  await withSocket(async call => {
    const status = await call('GET', '/v1/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.version, 1);
    assert.deepEqual(status.body.allowedEnvs, ['live', 'demo']);
    const missing = await call('GET', '/v1/orders');
    assert.deepEqual([missing.status, missing.body.code], [404, 'NOT_FOUND']);
    assert.equal(typeof missing.body.error, 'string');
  });
});

test('request bodies are size-capped, must be JSON objects and are validated before the service runs', async () => {
  await withSocket(async (call, f) => {
    assert.equal((await call('POST', '/v1/orders/preview', { origin: STUDIO, order: ORDER_BODY, padding: 'x'.repeat(70 * 1024) })).status, 413);
    assert.equal((await call('POST', '/v1/orders/preview', 'origin=x', 'application/x-www-form-urlencoded')).status, 415);
    assert.deepEqual((await call('POST', '/v1/orders/preview', '{not json')).body.code, 'INVALID_REQUEST');
    assert.equal((await call('POST', '/v1/orders/preview', '[1]')).status, 400);
    for (const bad of [{ ...ORDER_BODY, ticker: '../x' }, { ...ORDER_BODY, quantity: 1e-7 }, { ...ORDER_BODY, env: 'paper' }, { ...ORDER_BODY, type: 'limit' }, { ...ORDER_BODY, limitPrice: 5 }]) {
      const reply = await call('POST', '/v1/orders/preview', { origin: STUDIO, order: bad });
      assert.deepEqual([reply.status, reply.body.code], [400, 'INVALID_REQUEST'], JSON.stringify(bad));
    }
    assert.equal((await call('POST', '/v1/orders/preview', { order: ORDER_BODY })).status, 400, 'origin is required');
    assert.equal(f.calls.length, 0, 'nothing reached Trading 212');
  });
});

test('a caller without the passkey cannot place an order through the socket', async () => {
  await withSocket(async (call, f, logs) => {
    // No passkey enrolled yet: the preview itself is refused.
    assert.deepEqual((await call('POST', '/v1/orders/preview', { origin: STUDIO, order: ORDER_BODY })).body.code, 'T212_PASSKEY_REQUIRED');
    // Registration options need an enrollment code that only the broker's OS user can print.
    const enrolment = await call('POST', '/v1/passkeys/registration-options', { origin: STUDIO, enrollmentCode: 'guess-guess-guess-guess' });
    assert.deepEqual([enrolment.status, enrolment.body.code], [403, 'T212_ENROLL_CODE_INVALID']);

    await enroll(f);
    const preview = await call('POST', '/v1/orders/preview', { origin: STUDIO, order: ORDER_BODY });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.requires, 'passkey');
    // A forged assertion, a plain confirmation and an unknown preview id are all refused.
    const forged = assertion({ challenge: preview.body.authentication.challenge, origin: STUDIO, signature: 'forged' });
    assert.deepEqual((await call('POST', '/v1/orders/confirm', { origin: STUDIO, id: preview.body.id, assertion: forged })).body.code, 'T212_PASSKEY_FAILED');
    const second = await call('POST', '/v1/orders/preview', { origin: STUDIO, order: ORDER_BODY });
    assert.deepEqual((await call('POST', '/v1/orders/confirm', { origin: STUDIO, id: second.body.id, confirmed: true })).body.code, 'T212_PASSKEY_REQUIRED');
    assert.equal((await call('POST', '/v1/orders/confirm', { origin: STUDIO, id: '00000000-0000-0000-0000-000000000000', confirmed: true })).status, 404);
    assert.equal(f.posts().length, 0);

    const third = await call('POST', '/v1/orders/preview', { origin: STUDIO, order: ORDER_BODY, padding: 'secret-marker' });
    const signed = assertion({ challenge: third.body.authentication.challenge, origin: STUDIO });
    const placed = await call('POST', '/v1/orders/confirm', { origin: STUDIO, id: third.body.id, assertion: signed });
    assert.deepEqual([placed.status, placed.body.order.id], [200, '9001']);
    assert.equal(f.posts().length, 1);
    assert.ok(logs.some(line => line.startsWith('POST /v1/orders/confirm -> 200')));
    assert.ok(!logs.join('\n').includes('secret-marker') && !logs.join('\n').includes('good-signature'), 'bodies are never logged');
  });
});

test('requests over the per-minute limit are refused', async () => {
  await withSocket(async call => {
    for (let index = 0; index < 3; index += 1) assert.equal((await call('GET', '/v1/status')).status, 200);
    const limited = await call('GET', '/v1/status');
    assert.deepEqual([limited.status, limited.body.code], [429, 'RATE_LIMITED']);
  }, { maxRequestsPerMinute: 3 });
});
