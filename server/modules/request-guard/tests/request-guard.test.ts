import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import type { StudioRequestClient } from '@/shared/types.js';

import { createRequestGuard, REQUEST_TIER_LIMITS, WEBSOCKET_CONNECTION_LIMITS } from '../request-guard.service.js';

// Stands in for the auth module's readRequestClient (tested there): the test names the client in
// headers, so one process can play many clients and doors.
function readTestClient(request: { headers: IncomingMessage['headers'] }): StudioRequestClient {
  const door = request.headers['x-test-door'];
  return {
    door: door === 'cloudflare' || door === 'tailnet' ? door : 'direct',
    address: String(request.headers['x-test-address'] ?? 'unknown'),
  };
}

function upgrade(door: string, address: string): IncomingMessage {
  return { headers: { 'x-test-door': door, 'x-test-address': address } } as unknown as IncomingMessage;
}

async function withGuardedApp(guard: ReturnType<typeof createRequestGuard>, run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(guard.middleware);
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
  app.post('/api/auth/login', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/projects', (_req, res) => { res.json({ ok: true }); });
  app.get('/index.html', (_req, res) => { res.send('page'); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const as = (door: string, address: string) => ({ 'x-test-door': door, 'x-test-address': address });

test('public endpoints are stricter than the API and answer 429 with Retry-After', async () => {
  const guard = createRequestGuard({ readClient: readTestClient, now: () => 0, logWarn: () => undefined });
  await withGuardedApp(guard, async (baseUrl) => {
    const burst = REQUEST_TIER_LIMITS.public.perClient.capacity;
    for (let request = 0; request < burst; request += 1) {
      const response = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: as('cloudflare', '198.51.100.7') });
      assert.equal(response.status, 200);
    }
    const limited = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: as('cloudflare', '198.51.100.7') });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '2');
    assert.deepEqual(await limited.json(), {
      success: false,
      error: { code: 'RATE_LIMITED', message: '请求太频繁，请稍后再试', details: { retryAfterSeconds: 2 } },
    });
    // /health shares the public budget.
    assert.equal((await fetch(`${baseUrl}/health`, { headers: as('cloudflare', '198.51.100.7') })).status, 429);
    // The API and static tiers are separate budgets for the same client.
    assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: as('cloudflare', '198.51.100.7') })).status, 200);
    assert.equal((await fetch(`${baseUrl}/index.html`, { headers: as('cloudflare', '198.51.100.7') })).status, 200);
    // Another client of the same door is unaffected.
    assert.equal((await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: as('cloudflare', '198.51.100.8') })).status, 200);
  });
});

test('a public flood drains only the public door: the Tailscale door keeps working', async () => {
  const guard = createRequestGuard({ readClient: readTestClient, now: () => 0, logWarn: () => undefined });
  await withGuardedApp(guard, async (baseUrl) => {
    const doorCapacity = REQUEST_TIER_LIMITS.public.perDoor.capacity;
    let refused = 0;
    // Many addresses, each within its own client budget, together exceed the door bucket.
    for (let index = 0; index < doorCapacity + 20; index += 1) {
      const response = await fetch(`${baseUrl}/health`, { headers: as('cloudflare', `203.0.${Math.floor(index / 250)}.${index % 250}`) });
      if (response.status === 429) refused += 1;
    }
    assert.equal(refused, 20);
    assert.equal((await fetch(`${baseUrl}/health`, { headers: as('tailnet', '100.101.102.103') })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: as('tailnet', '100.101.102.103') })).status, 200);
  });
});

test('WebSocket upgrades are rate limited and capped per client and per door', () => {
  const guard = createRequestGuard({
    readClient: readTestClient,
    now: () => 0,
    logWarn: () => undefined,
    connectionLimits: { perClient: 2, perDoor: 3 },
    limits: { upgrade: { perClient: { capacity: 100, refillPerSecond: 1 }, perDoor: { capacity: 100, refillPerSecond: 1 } } },
  });
  const releaseA = guard.trackConnection(upgrade('cloudflare', '198.51.100.7'));
  guard.trackConnection(upgrade('cloudflare', '198.51.100.7'));
  assert.deepEqual(guard.admitUpgrade(upgrade('cloudflare', '198.51.100.7')), { allowed: false, statusCode: 429, retryAfterSeconds: 30, reason: 'connections' });
  assert.deepEqual(guard.admitUpgrade(upgrade('cloudflare', '198.51.100.8')), { allowed: true });
  guard.trackConnection(upgrade('cloudflare', '198.51.100.8'));
  // The door is full now, but the tailnet door has its own count.
  assert.equal(guard.admitUpgrade(upgrade('cloudflare', '198.51.100.9')).allowed, false);
  assert.deepEqual(guard.admitUpgrade(upgrade('tailnet', '100.101.102.103')), { allowed: true });
  releaseA();
  releaseA();
  assert.deepEqual(guard.admitUpgrade(upgrade('cloudflare', '198.51.100.7')), { allowed: true });

  const strict = createRequestGuard({ readClient: readTestClient, now: () => 0, logWarn: () => undefined });
  const burst = REQUEST_TIER_LIMITS.upgrade.perClient.capacity;
  for (let attempt = 0; attempt < burst; attempt += 1) assert.equal(strict.admitUpgrade(upgrade('direct', '192.0.2.1')).allowed, true);
  assert.deepEqual(strict.admitUpgrade(upgrade('direct', '192.0.2.1')), { allowed: false, statusCode: 429, retryAfterSeconds: 2, reason: 'rate' });
  assert.ok(WEBSOCKET_CONNECTION_LIMITS.perClient >= 16);
});

test('rate-limit warnings name the door only and are throttled per client', async () => {
  const warnings: string[] = [];
  const guard = createRequestGuard({ readClient: readTestClient, now: () => 0, logWarn: (message) => warnings.push(message) });
  await withGuardedApp(guard, async (baseUrl) => {
    for (let request = 0; request < REQUEST_TIER_LIMITS.public.perClient.capacity + 5; request += 1) {
      await fetch(`${baseUrl}/health`, { headers: as('cloudflare', '198.51.100.7') });
    }
  });
  assert.deepEqual(warnings, ['[request-guard] Rate limit reached (public tier, cloudflare door)']);
});
