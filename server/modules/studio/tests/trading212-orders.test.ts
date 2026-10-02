import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import type { StudioT212OrderInput } from '@/shared/types.js';

import { createTrading212Service } from '../trading212.service.js';
import { createTrading212OrdersService } from '../trading212-orders.service.js';

type WebAuthn = NonNullable<Parameters<typeof createTrading212OrdersService>[0]['webauthn']>;
type Call = { url: string; method: string; body?: string; contentType?: string };

const STUDIO = { origin: 'https://studio.ajarche.com', rpId: 'studio.ajarche.com' };
const TAILNET = { origin: 'https://desktop.tail1234.ts.net', rpId: 'desktop.tail1234.ts.net' };
const SUMMARY = {
  id: 1, currency: 'GBP', totalValue: 1620,
  cash: { availableToTrade: 1000, reservedForOrders: 0, inPies: 0 },
  investments: { currentValue: 620, totalCost: 560, realizedProfitLoss: 0, unrealizedProfitLoss: 60 },
};
// AAPL: 2 shares worth £320 at $200 each, so one share is £160 and the FX rate is 0.8.
const POSITIONS = [
  { instrument: { ticker: 'AAPL_US_EQ', name: 'Apple', currency: 'USD' }, quantity: 2, currentPrice: 200, averagePricePaid: 150, walletImpact: { currentValue: 320, totalCost: 260, unrealizedProfitLoss: 60 } },
  { instrument: { ticker: 'MSFT_US_EQ', name: 'Microsoft', currency: 'USD' }, quantity: 1, currentPrice: 400, averagePricePaid: 380, walletImpact: { currentValue: 300, totalCost: 300, unrealizedProfitLoss: 0 } },
];
const ORDER = { id: 9001, status: 'NEW', ticker: 'AAPL_US_EQ', side: 'BUY', type: 'MARKET', quantity: 1.5, filledQuantity: 0, createdAt: '2026-10-02T10:00:00Z', strategy: 'QUANTITY' };

function fakeWebAuthn() {
  const calls = { registration: [] as any[], verifyRegistration: [] as any[], authentication: [] as any[], verifyAuthentication: [] as any[] };
  let counter = 0;
  const webauthn = {
    async generateRegistrationOptions(options: any) {
      calls.registration.push(options);
      return { challenge: `reg-${++counter}`, rp: { id: options.rpID, name: options.rpName } };
    },
    async verifyRegistrationResponse(options: any) {
      calls.verifyRegistration.push(options);
      return { verified: true, registrationInfo: { credential: { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] } } };
    },
    async generateAuthenticationOptions(options: any) {
      calls.authentication.push(options);
      return { challenge: `auth-${++counter}`, rpId: options.rpID, allowCredentials: options.allowCredentials, userVerification: options.userVerification };
    },
    async verifyAuthenticationResponse(options: any) {
      calls.verifyAuthentication.push(options);
      if (options.response.response.signature !== 'good-signature') throw new Error('signature mismatch');
      return { verified: true, authenticationInfo: { credentialID: options.credential.id, newCounter: 7, userVerified: true } };
    },
  } as unknown as WebAuthn;
  return { webauthn, calls };
}

function fixture(options: { trading?: string; maxOrderValue?: string; development?: boolean } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 't212-orders-test-'));
  const live = path.join(directory, 'live.env');
  const demo = path.join(directory, 'demo.env');
  writeFileSync(live, 'TRADING212_API_KEY=fake-live-key\nTRADING212_API_SECRET=fake-live-secret\n');
  writeFileSync(demo, 'TRADING212_API_KEY=fake-demo-key\nTRADING212_API_SECRET=fake-demo-secret\n');
  const database = new Database(':memory:');
  const calls: Call[] = [];
  let clock = Date.parse('2026-10-02T10:00:00Z');
  let respondToOrder: (url: string) => Response = () => Response.json(ORDER);
  const trading212 = createTrading212Service({
    database, envFiles: { live, demo }, now: () => clock,
    request: (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url: String(url), method: String(init.method), body: init.body as string | undefined, contentType: headers['Content-Type'] });
      if (init.method === 'POST') return respondToOrder(String(url));
      if (String(url).endsWith('/equity/account/summary')) return Response.json(SUMMARY);
      if (String(url).includes('/equity/positions')) return Response.json(POSITIONS);
      return Response.json({ items: [], nextPagePath: null });
    }) as unknown as typeof fetch,
  });
  const { webauthn, calls: webauthnCalls } = fakeWebAuthn();
  const orders = createTrading212OrdersService({
    database, trading212, webauthn, now: () => clock,
    trading: 'trading' in options ? options.trading : 'both',
    maxOrderValue: options.maxOrderValue,
    origins: [STUDIO.origin, `${TAILNET.origin}/`, undefined],
    development: options.development ?? false,
  });
  return {
    orders, calls, database, webauthnCalls,
    posts: () => calls.filter(call => call.method === 'POST'),
    advance: (ms: number) => { clock += ms; },
    onOrder: (respond: (url: string) => Response) => { respondToOrder = respond; },
    attempts: () => database.prepare('SELECT * FROM studio_t212_orders ORDER BY row_id').all() as Record<string, unknown>[],
    close: () => { database.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

const order = (input: Partial<StudioT212OrderInput>): StudioT212OrderInput => ({
  env: 'live', ticker: 'AAPL_US_EQ', side: 'buy', type: 'market', quantity: 1, timeValidity: 'DAY', ...input,
});
const goodAssertion = { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: { signature: 'good-signature' }, clientExtensionResults: {} } as any;
const badAssertion = { ...goodAssertion, response: { signature: 'forged' } } as any;

async function registerPasskey(f: ReturnType<typeof fixture>) {
  await f.orders.passkeyOptions(1, 'owner', STUDIO);
  return f.orders.registerPasskey(1, STUDIO, { id: 'cred-1', rawId: 'cred-1', response: { attestationObject: 'x' } } as any, 'Mozilla/5.0 (iPad; CPU OS 18_0)');
}

test('trading is off by default and refuses every account before contacting the broker', async () => {
  const off = fixture({ trading: undefined });
  const demoOnly = fixture({ trading: 'demo' });
  try {
    assert.deepEqual(off.orders.config(1).allowedEnvs, []);
    await assert.rejects(off.orders.preview(1, STUDIO, order({})), (error: Error) => /STUDIO_T212_TRADING=live/.test(error.message));
    await assert.rejects(off.orders.preview(1, STUDIO, order({ env: 'demo' })), /模拟盘下单未开启/);
    assert.equal(off.calls.length, 0);

    assert.deepEqual(demoOnly.orders.config(1).allowedEnvs, ['demo']);
    await assert.rejects(demoOnly.orders.preview(1, STUDIO, order({ env: 'live' })), /实盘下单未开启/);
    const preview = await demoOnly.orders.preview(1, STUDIO, order({ env: 'demo' }));
    assert.equal(preview.env, 'demo');
    assert.ok(demoOnly.calls.every(call => call.url.startsWith('https://demo.trading212.com/')));
  } finally { off.close(); demoOnly.close(); }
});

test('a held market buy is estimated in the account currency, double-confirmed and POSTed exactly once', async () => {
  const f = fixture();
  try {
    const preview = await f.orders.preview(1, STUDIO, order({ quantity: 1.5 }));
    assert.equal(preview.estimatedValue, 240);
    assert.equal(preview.currency, 'GBP');
    assert.equal(preview.requires, 'confirm');
    assert.equal('authentication' in preview, false);
    assert.ok(preview.warnings.some(warning => warning.includes('实盘')));
    assert.equal(Date.parse(preview.expiresAt) - Date.parse('2026-10-02T10:00:00Z'), 60_000);
    assert.equal(f.posts().length, 0, 'previewing never places an order');
    const summaryReads = () => f.calls.filter(call => call.url.endsWith('/equity/account/summary')).length;
    const readsBefore = summaryReads();

    const result = await f.orders.confirm(1, STUDIO, preview.id, { confirmed: true });
    assert.equal(result.method, 'confirm');
    assert.deepEqual(result.order, {
      id: '9001', status: 'NEW', ticker: 'AAPL_US_EQ', side: 'BUY', type: 'MARKET', quantity: 1.5, filledQuantity: 0, limitPrice: null, createdAt: '2026-10-02T10:00:00Z',
    });
    const posts = f.posts();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, 'https://live.trading212.com/api/v0/equity/orders/market');
    assert.equal(posts[0].body, JSON.stringify({ ticker: 'AAPL_US_EQ', quantity: 1.5 }));
    assert.equal(posts[0].contentType, 'application/json');

    await assert.rejects(f.orders.confirm(1, STUDIO, preview.id, { confirmed: true }), /不存在、已使用或已过期/);
    assert.equal(f.posts().length, 1, 'a preview places at most one order');

    await f.orders.preview(1, STUDIO, order({}));
    assert.equal(summaryReads(), readsBefore + 1, 'the cached overview is dropped after an order');

    const attempts = f.attempts();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, 'placed');
    assert.equal(attempts[0].method, 'confirm');
    assert.equal(attempts[0].broker_order_id, '9001');
    assert.ok(!JSON.stringify(attempts).includes('fake-live'), 'no secret is recorded');
  } finally { f.close(); }
});

test('sells send a negative quantity and can never exceed the holding', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.orders.preview(1, STUDIO, order({ side: 'sell', quantity: 3 })), /超过持仓：只持有 2 股/);
    await assert.rejects(f.orders.preview(1, STUDIO, order({ side: 'sell', ticker: 'TSLA_US_EQ', type: 'limit', limitPrice: 10 })), /没有持有 TSLA_US_EQ/);

    // Limit at $210 converts with the position's FX rate: 2 × 210 × 0.8 = £336.
    const preview = await f.orders.preview(1, STUDIO, order({ side: 'sell', quantity: 2, type: 'limit', limitPrice: 210, timeValidity: 'GOOD_TILL_CANCEL' }));
    assert.equal(preview.estimatedValue, 336);
    assert.ok(preview.warnings.some(warning => warning.includes('撤单前有效')));
    f.onOrder(() => Response.json({ ...ORDER, side: 'SELL', type: 'LIMIT', quantity: -2, limitPrice: 210 }));
    const result = await f.orders.confirm(1, STUDIO, preview.id, { confirmed: true });
    assert.equal(result.order.limitPrice, 210);
    const posts = f.posts();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, 'https://live.trading212.com/api/v0/equity/orders/limit');
    assert.equal(posts[0].body, JSON.stringify({ ticker: 'AAPL_US_EQ', quantity: -2, limitPrice: 210, timeValidity: 'GOOD_TILL_CANCEL' }));
  } finally { f.close(); }
});

test('the per-order cap is enforced server-side and unheld tickers need a limit order', async () => {
  const f = fixture({ maxOrderValue: '500' });
  try {
    await assert.rejects(f.orders.preview(1, STUDIO, order({ quantity: 4 })), (error: Error & { code?: string }) =>
      error.code === 'T212_ORDER_CAP' && error.message.includes('£640.00') && error.message.includes('£500.00'));
    await assert.rejects(f.orders.preview(1, STUDIO, order({ ticker: 'TSLA_US_EQ' })), /改用限价单/);
    await assert.rejects(f.orders.preview(1, STUDIO, order({ ticker: 'TSLA_US_EQ', type: 'limit', quantity: 2, limitPrice: 300 })), /超过单笔上限/);
    const unheld = await f.orders.preview(1, STUDIO, order({ ticker: 'TSLA_US_EQ', type: 'limit', quantity: 1, limitPrice: 300 }));
    assert.equal(unheld.estimatedValue, 300);
    assert.equal(unheld.timeValidity, 'DAY');
    assert.ok(unheld.warnings.some(warning => warning.includes('没有换算汇率')));
    assert.equal(f.posts().length, 0);
    assert.equal(f.orders.config(1).maxOrderValue, 500);
  } finally { f.close(); }
  const invalidCap = fixture({ maxOrderValue: 'lots' });
  try {
    assert.equal(invalidCap.orders.config(1).maxOrderValue, 500, 'an invalid cap falls back to the default');
  } finally { invalidCap.close(); }
});

test('previews expire after 60 seconds, are single-use and are bound to their origin', async () => {
  const f = fixture();
  try {
    const stale = await f.orders.preview(1, STUDIO, order({}));
    f.advance(60_001);
    await assert.rejects(f.orders.confirm(1, STUDIO, stale.id, { confirmed: true }), /超过 60 秒/);
    await assert.rejects(f.orders.confirm(1, STUDIO, stale.id, { confirmed: true }), /不存在、已使用或已过期/);

    const elsewhere = await f.orders.preview(1, STUDIO, order({}));
    await assert.rejects(f.orders.confirm(1, TAILNET, elsewhere.id, { confirmed: true }), /同一个网址/);
    const someoneElse = await f.orders.preview(1, STUDIO, order({}));
    await assert.rejects(f.orders.confirm(2, STUDIO, someoneElse.id, { confirmed: true }), /不存在/);

    assert.equal(f.posts().length, 0);
    assert.deepEqual(f.attempts().map(row => row.status), ['failed', 'failed']);
  } finally { f.close(); }
});

test('passkeys are per domain: Face ID is required where one exists and a failed check places nothing', async () => {
  const f = fixture();
  try {
    const passkey = await registerPasskey(f);
    assert.equal(passkey.rpId, 'studio.ajarche.com');
    assert.equal(passkey.label, 'iPad');
    const [registration] = f.webauthnCalls.registration;
    assert.equal(registration.rpID, 'studio.ajarche.com');
    assert.deepEqual(registration.authenticatorSelection, { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' });
    assert.equal(f.webauthnCalls.verifyRegistration[0].expectedChallenge, 'reg-1');
    assert.equal(f.webauthnCalls.verifyRegistration[0].expectedOrigin, STUDIO.origin);
    assert.equal(f.webauthnCalls.verifyRegistration[0].requireUserVerification, true);
    assert.deepEqual(f.orders.config(1).passkeys.map(item => item.rpId), ['studio.ajarche.com']);
    assert.deepEqual(f.orders.config(2).passkeys, [], 'passkeys belong to one user');

    const tailnet = await f.orders.preview(1, TAILNET, order({}));
    assert.equal(tailnet.requires, 'confirm', 'the Tailscale domain has no passkey of its own');

    const preview = await f.orders.preview(1, STUDIO, order({}));
    assert.equal(preview.requires, 'passkey');
    assert.equal(preview.authentication?.userVerification, 'required');
    assert.deepEqual(preview.authentication?.allowCredentials?.map(item => item.id), ['cred-1']);
    await assert.rejects(f.orders.confirm(1, STUDIO, preview.id, { confirmed: true }), /请用通行密钥确认/);

    const forged = await f.orders.preview(1, STUDIO, order({}));
    await assert.rejects(f.orders.confirm(1, STUDIO, forged.id, { assertion: badAssertion }), (error: Error & { statusCode?: number }) =>
      error.statusCode === 403 && /通行密钥验证失败/.test(error.message));
    assert.equal(f.posts().length, 0);

    const real = await f.orders.preview(1, STUDIO, order({}));
    const result = await f.orders.confirm(1, STUDIO, real.id, { assertion: goodAssertion });
    assert.equal(result.method, 'passkey');
    assert.equal(f.posts().length, 1);
    const verification = f.webauthnCalls.verifyAuthentication.at(-1);
    assert.equal(verification.expectedChallenge, real.authentication?.challenge);
    assert.equal(verification.expectedRPID, 'studio.ajarche.com');
    assert.equal(verification.requireUserVerification, true);
    const stored = f.database.prepare('SELECT counter, last_used_at FROM studio_t212_passkeys').get() as { counter: number; last_used_at: string | null };
    assert.equal(stored.counter, 7);
    assert.ok(stored.last_used_at);
    assert.deepEqual(f.attempts().map(row => [row.method, row.status]), [['confirm', 'failed'], ['passkey', 'failed'], ['passkey', 'placed']]);

    assert.deepEqual(f.orders.removePasskey(1, passkey.id), { removed: true });
    assert.throws(() => f.orders.removePasskey(1, passkey.id), /找不到/);
    assert.equal((await f.orders.preview(1, STUDIO, order({}))).requires, 'confirm');
  } finally { f.close(); }
});

test('a passkey enabled after a preview makes that double confirmation insufficient', async () => {
  const f = fixture();
  try {
    const preview = await f.orders.preview(1, STUDIO, order({}));
    await registerPasskey(f);
    await assert.rejects(f.orders.confirm(1, STUDIO, preview.id, { confirmed: true }), /重新预览/);
    assert.equal(f.posts().length, 0);
  } finally { f.close(); }
});

test('only configured origins may trade; localhost only in development', () => {
  const production = fixture();
  const development = fixture({ development: true });
  try {
    assert.deepEqual(production.orders.trustedOrigin('https://studio.ajarche.com'), STUDIO);
    assert.deepEqual(production.orders.trustedOrigin('https://desktop.tail1234.ts.net'), TAILNET);
    for (const header of [undefined, 'null', 'https://evil.example', 'https://studio.ajarche.com/x', 'http://localhost:5173']) {
      assert.throws(() => production.orders.trustedOrigin(header), (error: Error & { statusCode?: number }) => error.statusCode === 403, String(header));
    }
    assert.deepEqual(development.orders.trustedOrigin('http://localhost:5173'), { origin: 'http://localhost:5173', rpId: 'localhost' });
    assert.throws(() => development.orders.trustedOrigin('https://localhost.evil.example'));
    assert.deepEqual(production.orders.config(1).trustedOrigins, [STUDIO.origin, TAILNET.origin]);
  } finally { production.close(); development.close(); }
});

test('broker failures are recorded, reported as unknown outcomes and never retried', async () => {
  const f = fixture();
  try {
    f.onOrder(() => new Response('', { status: 500 }));
    const first = await f.orders.preview(1, STUDIO, order({}));
    await assert.rejects(f.orders.confirm(1, STUDIO, first.id, { confirmed: true }), /订单状态未知/);
    assert.equal(f.posts().length, 1);

    f.onOrder(() => Response.json({ code: 'InsufficientFreeForStocksBuy', clarification: 'Insufficient funds <script>' }, { status: 400 }));
    const second = await f.orders.preview(1, STUDIO, order({}));
    await assert.rejects(f.orders.confirm(1, STUDIO, second.id, { confirmed: true }), (error: Error) =>
      error.message.includes('Insufficient funds') && !error.message.includes('<'));
    assert.equal(f.posts().length, 2);

    f.onOrder(() => { throw new Error('ECONNRESET fake-live-secret'); });
    const third = await f.orders.preview(1, STUDIO, order({}));
    await assert.rejects(f.orders.confirm(1, STUDIO, third.id, { confirmed: true }), (error: Error) =>
      /不会自动重试/.test(error.message) && !error.message.includes('fake-live'));
    assert.equal(f.posts().length, 3);
    const attempts = f.attempts();
    assert.deepEqual(attempts.map(row => row.status), ['failed', 'failed', 'failed']);
    assert.ok(!JSON.stringify(attempts).includes('fake-live'));
  } finally { f.close(); }
});
