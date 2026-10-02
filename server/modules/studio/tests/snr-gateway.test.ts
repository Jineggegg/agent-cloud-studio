import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSnrGateway } from '../snr-gateway.service.js';

test('only fixed loopback services can be connected', () => {
  assert.throws(() => createSnrGateway({ baseUrl: 'https://example.com', validUser: () => true }), /fixed loopback/);
});

test('a grant is short lived, unpredictable and tied to an active user', () => {
  let valid = true;
  const gateway = createSnrGateway({ baseUrl: 'http://127.0.0.1:8768', validUser: () => valid });
  const grant = gateway.grant(1);
  assert.equal(grant.key.length, 64);
  assert.equal(gateway.authorized(undefined), false);
  assert.equal(gateway.authorized('wrong'), false);
  assert.equal(gateway.authorized(grant.key), true);
  gateway.revoke(1);
  assert.equal(gateway.authorized(grant.key), false);
  const second = gateway.grant(1);
  valid = false;
  assert.equal(gateway.authorized(second.key), false);
});

test('proxy does not allow arbitrary destinations or application endpoints', async () => {
  const gateway = createSnrGateway({ baseUrl: 'http://127.0.0.1:8768', validUser: () => true });
  const signal = new AbortController().signal;
  await assert.rejects(gateway.proxy('https://example.com/api/health', 'GET', undefined, undefined, signal), /不可用/);
  await assert.rejects(gateway.proxy('/api/private', 'GET', undefined, undefined, signal), /不可用/);
  await assert.rejects(gateway.proxy('/static/../../secret', 'GET', undefined, undefined, signal), /不可用/);
});

test('HTML keeps lab assets and API traffic inside the protected gateway', async () => {
  const gateway = createSnrGateway({
    baseUrl: 'http://127.0.0.1:8768', validUser: () => true,
    request: (async () => new Response('<html><head><script defer src="/static/replay.js"></script></head><body>Lab</body></html>', { headers: { 'Content-Type': 'text/html' } })) as typeof fetch,
  });
  const result = await gateway.proxy('/replay', 'GET', undefined, undefined, new AbortController().signal);
  const body = result.body.toString();
  assert.ok(body.includes('src="/api/studio/snr-site/static/replay.js"'));
  assert.ok(body.indexOf('studioFetch') < body.indexOf('defer'));
  assert.ok(body.includes("url.pathname.startsWith('/api/')"));
});
