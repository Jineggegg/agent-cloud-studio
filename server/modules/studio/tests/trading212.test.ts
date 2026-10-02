import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import { createTrading212Service } from '../trading212.service.js';

type Call = { url: string; method?: string; authorization?: string };

function fixture(respond: (url: string) => Response | Promise<Response>) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 't212-test-'));
  const envFile = path.join(directory, '.env');
  writeFileSync(envFile, 'TRADING212_ENV=live\nTRADING212_API_KEY=fake-unit-key\nTRADING212_API_SECRET="fake-unit-secret"\n');
  const database = new Database(':memory:');
  const calls: Call[] = [];
  let clock = Date.parse('2026-10-01T17:00:00Z');
  const service = createTrading212Service({
    database, envFiles: { live: envFile },
    now: () => clock,
    request: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), method: init.method, authorization: (init.headers as Record<string, string>).Authorization });
      return respond(String(url));
    }) as unknown as typeof fetch,
  });
  return {
    service, calls, database,
    at: (iso: string) => { clock = Date.parse(iso); },
    close: () => { database.close(); rmSync(directory, { recursive: true }); },
  };
}

const summary = (totalValue: number) => ({
  id: 1, currency: 'GBP', totalValue,
  cash: { availableToTrade: 100, reservedForOrders: 0, inPies: 0 },
  investments: { currentValue: totalValue - 100, totalCost: 800, realizedProfitLoss: 12, unrealizedProfitLoss: totalValue - 900 },
});
const positions = [
  { instrument: { ticker: 'MSFT_US_EQ', name: 'Microsoft', currency: 'USD' }, quantity: 1, currentPrice: 400, averagePricePaid: 350, createdAt: '2026-01-02T00:00:00Z', walletImpact: { currentValue: 300, totalCost: 260, unrealizedProfitLoss: 40, fxImpact: null } },
  { instrument: { ticker: 'AAPL_US_EQ', name: 'Apple', currency: 'USD' }, quantity: 2, currentPrice: 200, averagePricePaid: 150, createdAt: '2026-01-01T00:00:00Z', walletImpact: { currentValue: 600, totalCost: 540, unrealizedProfitLoss: 60, fxImpact: 3 } },
];

test('reads credentials from the .env file, uses HTTP Basic GETs and never returns secrets', async () => {
  const f = fixture(url => Response.json(url.endsWith('/summary') ? summary(1000) : url.includes('/positions') ? positions : { items: [], nextPagePath: null }));
  try {
    const status = f.service.status();
    assert.deepEqual(status.map(item => [item.env, item.configured]), [['live', true], ['demo', false]]);
    const overview = await f.service.overview('live');
    assert.equal(overview.totalValue, 1000);
    assert.deepEqual(overview.positions.map(item => item.ticker), ['AAPL_US_EQ', 'MSFT_US_EQ']);
    assert.equal(overview.positions[0].fx, 3);
    assert.equal(overview.positions[1].fx, null);
    assert.ok(f.calls.every(call => call.method === 'GET' && call.url.startsWith('https://live.trading212.com/api/v0/')));
    assert.ok(f.calls.every(call => call.authorization === `Basic ${Buffer.from('fake-unit-key:fake-unit-secret').toString('base64')}`));
    const exposed = JSON.stringify([status, overview]);
    assert.ok(!exposed.includes('fake-unit-key') && !exposed.includes('fake-unit-secret'));
    await assert.rejects(f.service.overview('demo'), /未配置/);
  } finally { f.close(); }
});

test('repeat views reuse cached responses to stay inside Trading 212 rate limits', async () => {
  const f = fixture(url => Response.json(url.endsWith('/summary') ? summary(1000) : url.includes('/positions') ? positions : { items: [] }));
  try {
    await Promise.all([f.service.overview('live'), f.service.overview('live')]);
    await f.service.overview('live');
    assert.equal(f.calls.filter(call => call.url.endsWith('/equity/account/summary')).length, 1);
  } finally { f.close(); }
});

test('day changes come from stored snapshots and exclude deposits', async () => {
  let value = 1000;
  const transactions = { items: [{ type: 'DEPOSIT', amount: 50, currency: 'GBP', dateTime: '2026-10-02T07:00:00Z' }, { type: 'FEE', amount: -1, dateTime: '2026-10-02T07:30:00Z' }], nextPagePath: null };
  const f = fixture(url => Response.json(url.endsWith('/summary') ? summary(value) : url.includes('/positions') ? [] : transactions));
  try {
    f.at('2026-10-01T17:00:00Z');
    const first = await f.service.overview('live');
    assert.equal(first.changes.today, null);
    f.at('2026-10-02T09:00:00Z');
    value = 1100;
    const second = await f.service.overview('live');
    assert.equal(second.changes.today?.amount, 50);
    assert.equal(second.changes.today?.flowAdjusted, true);
    assert.equal(second.changes.yesterday, null);
    f.at('2026-10-03T09:00:00Z');
    value = 1080;
    const third = await f.service.overview('live');
    assert.equal(third.changes.today?.amount, -20);
    assert.equal(third.changes.yesterday?.amount, 50);
    assert.equal(f.service.history('live', 0).length, 3);
    assert.equal(f.service.history('live', 1).length, 2);
  } finally { f.close(); }
});

test('snapshots are throttled to one per ten minutes', async () => {
  const f = fixture(url => Response.json(url.endsWith('/summary') ? summary(1000) : url.includes('/positions') ? [] : { items: [] }));
  try {
    f.at('2026-10-01T17:00:00Z');
    await f.service.overview('live');
    f.at('2026-10-01T17:05:00Z');
    await f.service.overview('live');
    f.at('2026-10-01T17:11:00Z');
    await f.service.overview('live');
    assert.equal(f.service.history('live', 0).length, 2);
  } finally { f.close(); }
});

test('broker errors become safe messages', async () => {
  const unauthorized = fixture(() => new Response('{"message":"bad key fake-unit-key"}', { status: 401 }));
  const limited = fixture(() => new Response('', { status: 429 }));
  const offline = fixture(() => { throw new Error('ECONNRESET fake-unit-secret'); });
  try {
    await assert.rejects(unauthorized.service.overview('live'), (error: Error) => /认证失败/.test(error.message) && !error.message.includes('fake-unit'));
    await assert.rejects(limited.service.overview('live'), /过于频繁/);
    await assert.rejects(offline.service.overview('live'), (error: Error) => /无法连接/.test(error.message) && !error.message.includes('fake-unit'));
  } finally { unauthorized.close(); limited.close(); offline.close(); }
});

test('activity lists recent fills and dividends newest first', async () => {
  const f = fixture(url => Response.json(url.includes('/history/orders') ? {
    items: [{ order: { id: 7, side: 'SELL', ticker: 'AAPL_US_EQ', instrument: { name: 'Apple' }, status: 'FILLED', createdAt: '2026-09-30T10:00:00Z' }, fill: { price: 210, quantity: 1, filledAt: '2026-09-30T10:00:01Z', walletImpact: { currency: 'GBP', netValue: 160, realisedProfitLoss: 35 } } }],
  } : { items: [{ ticker: 'MSFT_US_EQ', instrument: { name: 'Microsoft' }, amount: 1.2, currency: 'GBP', paidOn: '2026-10-01T00:00:00Z', quantity: 1, reference: 'd1' }] }));
  try {
    const items = await f.service.activity('live');
    assert.deepEqual(items.map(item => [item.kind, item.ticker]), [['dividend', 'MSFT_US_EQ'], ['sell', 'AAPL_US_EQ']]);
    assert.equal(items[1].realized, 35);
  } finally { f.close(); }
});
