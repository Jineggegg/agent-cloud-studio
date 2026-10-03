import assert from 'node:assert/strict';
import test from 'node:test';

import { createRateLimiter } from '../rate-limiter.service.js';

const limits = {
  perClient: { capacity: 3, refillPerSecond: 1 },
  perDoor: { capacity: 5, refillPerSecond: 1 },
};

test('a client gets its burst, then 429-style refusals with the seconds until a token is back', () => {
  const clock = { now: 0 };
  const limiter = createRateLimiter({ ...limits, now: () => clock.now });
  const client = { door: 'cloudflare', address: '198.51.100.7' } as const;
  for (let request = 0; request < 3; request += 1) assert.deepEqual(limiter.take(client), { allowed: true });
  assert.deepEqual(limiter.take(client), { allowed: false, retryAfterSeconds: 1 });
  // Refused requests take nothing, so waiting is enough.
  clock.now += 1000;
  assert.deepEqual(limiter.take(client), { allowed: true });
  assert.equal(limiter.take(client).allowed, false);
});

test('a slow refill reports a longer Retry-After', () => {
  const limiter = createRateLimiter({ perClient: { capacity: 1, refillPerSecond: 0.1 }, perDoor: { capacity: 100, refillPerSecond: 10 }, now: () => 0 });
  const client = { door: 'direct', address: '192.0.2.1' } as const;
  limiter.take(client);
  assert.deepEqual(limiter.take(client), { allowed: false, retryAfterSeconds: 10 });
});

test('a door bucket bounds a distributed flood without touching the other doors', () => {
  const limiter = createRateLimiter({ ...limits, now: () => 0 });
  let allowed = 0;
  for (let index = 0; index < 50; index += 1) {
    if (limiter.take({ door: 'cloudflare', address: `203.0.113.${index}` }).allowed) allowed += 1;
  }
  // Fifty fresh addresses still only get the public door's five tokens.
  assert.equal(allowed, 5);
  assert.deepEqual(limiter.take({ door: 'tailnet', address: '100.101.102.103' }), { allowed: true });
  assert.deepEqual(limiter.take({ door: 'direct', address: '127.0.0.1' }), { allowed: true });
});

test('client buckets are an LRU bounded by maxClients', () => {
  const clock = { now: 0 };
  const limiter = createRateLimiter({
    perClient: { capacity: 2, refillPerSecond: 0.001 },
    perDoor: { capacity: 100_000, refillPerSecond: 1000 },
    maxClients: 3,
    now: () => clock.now,
  });
  const recent = { door: 'cloudflare', address: '198.51.100.1' } as const;
  limiter.take(recent);
  limiter.take(recent);
  for (let index = 0; index < 1000; index += 1) {
    clock.now += 1;
    limiter.take({ door: 'cloudflare', address: `203.0.113.${index % 250}.${index}` });
    // Touching a client keeps it from being the least recently used one.
    if (index % 2 === 0) limiter.take(recent);
  }
  assert.ok(limiter.trackedClients() <= 3);
  // Still remembered, so still empty.
  assert.equal(limiter.take(recent).allowed, false);
});
