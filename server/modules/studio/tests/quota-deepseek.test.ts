import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readDeepSeekQuota } from '../quota/deepseek-quota.adapter.js';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const KEY = 'test-deepseek-key';

test('without a saved key DeepSeek is unavailable and nothing is requested', async () => {
  let calls = 0;
  const snapshot = await readDeepSeekQuota({ apiKey: null, now: NOW, request: (async () => { calls++; return Response.json({}); }) as typeof fetch });
  assert.equal(calls, 0);
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.source, 'unavailable');
  assert.ok(snapshot.note);
});

test('balance_infos amounts become numeric balances from the official endpoint', async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const snapshot = await readDeepSeekQuota({
    apiKey: KEY, now: NOW,
    request: (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return Response.json({
        is_available: false,
        balance_infos: [
          { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
          { currency: 'USD', total_balance: '0.5', granted_balance: 'n/a', topped_up_balance: '0.5' },
          { currency: 'EUR', total_balance: 'oops' },
        ],
      });
    }) as unknown as typeof fetch,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.deepseek.com/user/balance');
  assert.equal(new Headers(seen[0].init?.headers).get('authorization'), `Bearer ${KEY}`);
  assert.equal(seen[0].init?.method ?? 'GET', 'GET');
  assert.deepEqual(snapshot, {
    provider: 'deepseek', available: true, windows: [], source: 'official',
    observedAt: new Date(NOW).toISOString(), stale: false, note: 'DeepSeek 余额不足，暂时无法调用',
    balances: [
      { currency: 'CNY', total: 110, granted: 10, toppedUp: 100 },
      { currency: 'USD', total: 0.5, granted: 0, toppedUp: 0.5 },
    ],
  });
  assert.ok(!JSON.stringify(snapshot).includes(KEY), 'the key never appears in the snapshot');
});

test('rejected keys, server errors and network failures become unavailable snapshots', async () => {
  const respond = (response: () => Response) => (async () => response()) as unknown as typeof fetch;
  const rejected = await readDeepSeekQuota({ apiKey: KEY, now: NOW, request: respond(() => new Response('{}', { status: 401 })) });
  assert.equal(rejected.available, false);
  assert.match(rejected.note ?? '', /无效/);
  const failing = await readDeepSeekQuota({ apiKey: KEY, now: NOW, request: respond(() => new Response('{}', { status: 503 })) });
  assert.match(failing.note ?? '', /503/);
  const malformed = await readDeepSeekQuota({ apiKey: KEY, now: NOW, request: respond(() => Response.json({ balance_infos: 'none' })) });
  assert.equal(malformed.available, false);
  const offline = await readDeepSeekQuota({ apiKey: KEY, now: NOW, request: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
  assert.equal(offline.available, false);
  assert.equal(offline.source, 'unavailable');
});
