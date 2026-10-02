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
// Quote currencies from /equity/metadata/instruments; VODl_EQ is quoted in pence.
const INSTRUMENTS = [
  { ticker: 'AAPL_US_EQ', currencyCode: 'USD', name: 'Apple' },
  { ticker: 'MSFT_US_EQ', currencyCode: 'USD', name: 'Microsoft' },
  { ticker: 'TSLA_US_EQ', currencyCode: 'USD', name: 'Tesla' },
  { ticker: 'VODl_EQ', currencyCode: 'GBX', name: 'Vodafone' },
  { ticker: 'SAP_DE_EQ', currencyCode: 'EUR', name: 'SAP' },
];
const PASSWORD = 'correct horse battery staple';
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

type FixtureOptions = {
  trading?: string; maxOrderValue?: string; allowLocalhost?: string; requirePasskey?: string;
  summary?: Record<string, unknown>; positions?: unknown[];
};

function fixture(options: FixtureOptions = {}) {
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
      if (String(url).endsWith('/equity/account/summary')) return Response.json(options.summary ?? SUMMARY);
      if (String(url).includes('/equity/positions')) return Response.json(options.positions ?? POSITIONS);
      if (String(url).endsWith('/equity/metadata/instruments')) return Response.json(INSTRUMENTS);
      return Response.json({ items: [], nextPagePath: null });
    }) as unknown as typeof fetch,
  });
  const { webauthn, calls: webauthnCalls } = fakeWebAuthn();
  const passwordChecks: string[] = [];
  const orders = createTrading212OrdersService({
    database, trading212, webauthn, now: () => clock,
    trading: 'trading' in options ? options.trading : 'both',
    maxOrderValue: options.maxOrderValue,
    requirePasskey: options.requirePasskey,
    allowLocalhost: options.allowLocalhost,
    origins: [STUDIO.origin, `${TAILNET.origin}/`, undefined],
    async verifyPassword(userId, password) {
      passwordChecks.push(password);
      return userId === 1 && password === PASSWORD;
    },
  });
  return {
    orders, calls, database, webauthnCalls, passwordChecks,
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

async function registerPasskey(f: ReturnType<typeof fixture>, origin = STUDIO) {
  await f.orders.passkeyOptions(1, 'owner', origin, PASSWORD);
  return f.orders.registerPasskey(1, origin, { id: 'cred-1', rawId: 'cred-1', response: { attestationObject: 'x' } } as any, 'Mozilla/5.0 (iPad; CPU OS 18_0)');
}
const coded = (code: string, pattern?: RegExp) => (error: Error & { code?: string }) => error.code === code && (!pattern || pattern.test(error.message));

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
    // TSLA is quoted in USD like the AAPL holding, whose value gives £0.80 per dollar: 3 × $300 is £720.
    await assert.rejects(f.orders.preview(1, STUDIO, order({ ticker: 'TSLA_US_EQ', type: 'limit', quantity: 3, limitPrice: 300 })), /超过单笔上限/);
    const unheld = await f.orders.preview(1, STUDIO, order({ ticker: 'TSLA_US_EQ', type: 'limit', quantity: 1, limitPrice: 300 }));
    assert.equal(unheld.estimatedValue, 240);
    assert.equal(unheld.timeValidity, 'DAY');
    assert.ok(unheld.warnings.some(warning => warning.includes('AAPL_US_EQ') && warning.includes('USD')));
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

    await assert.rejects(f.orders.preview(1, TAILNET, order({})), coded('T212_PASSKEY_REQUIRED', /studio\.ajarche\.com/),
      'a domain without its own passkey cannot fall back to the double confirmation');

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

    assert.deepEqual(await f.orders.removePasskey(1, STUDIO, passkey.id, { password: PASSWORD }), { removed: true });
    await assert.rejects(f.orders.removePasskey(1, STUDIO, passkey.id, { password: PASSWORD }), /找不到/);
    assert.equal((await f.orders.preview(1, STUDIO, order({}))).requires, 'confirm', 'without any passkey left, the double confirmation is back');
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

test('only configured origins may trade; localhost only with STUDIO_T212_ALLOW_LOCALHOST=1, whatever NODE_ENV says', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  const standard = fixture();
  const local = fixture({ allowLocalhost: '1' });
  const disabled = fixture({ allowLocalhost: '0' });
  try {
    assert.deepEqual(standard.orders.trustedOrigin('https://studio.ajarche.com'), STUDIO);
    assert.deepEqual(standard.orders.trustedOrigin('https://desktop.tail1234.ts.net'), TAILNET);
    const refused = [undefined, 'null', 'https://evil.example', 'https://studio.ajarche.com/x', 'http://localhost:3002', 'http://127.0.0.1:3001', 'http://[::1]:3001'];
    for (const header of refused) {
      assert.throws(() => standard.orders.trustedOrigin(header), (error: Error & { statusCode?: number }) => error.statusCode === 403, String(header));
    }
    assert.throws(() => disabled.orders.trustedOrigin('http://localhost:3002'), /白名单/);
    assert.equal(standard.orders.config(1).allowLocalhost, false);
    assert.deepEqual(local.orders.trustedOrigin('http://localhost:5173'), { origin: 'http://localhost:5173', rpId: 'localhost' });
    assert.deepEqual(local.orders.trustedOrigin('http://127.0.0.1:3001'), { origin: 'http://127.0.0.1:3001', rpId: '127.0.0.1' });
    assert.throws(() => local.orders.trustedOrigin('https://localhost.evil.example'));
    assert.equal(local.orders.config(1).allowLocalhost, true);
    assert.deepEqual(standard.orders.config(1).trustedOrigins, [STUDIO.origin, TAILNET.origin]);
  } finally {
    standard.close(); local.close(); disabled.close();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('broker failures are recorded, reported as unknown outcomes and never retried', async () => {
  const f = fixture();
  try {
    f.onOrder(() => new Response('', { status: 500 }));
    const first = await f.orders.preview(1, STUDIO, order({}));
    await assert.rejects(f.orders.confirm(1, STUDIO, first.id, { confirmed: true }), coded('T212_ORDER_UNKNOWN', /订单状态未知/));
    assert.equal(f.posts().length, 1);

    f.onOrder(() => Response.json({ code: 'InsufficientFreeForStocksBuy', clarification: 'Insufficient funds <script>' }, { status: 400 }));
    const second = await f.orders.preview(1, STUDIO, order({ quantity: 2 }));
    await assert.rejects(f.orders.confirm(1, STUDIO, second.id, { confirmed: true }), (error: Error & { code?: string }) =>
      error.code === 'TRADING212_ERROR' && error.message.includes('Insufficient funds') && !error.message.includes('<'));
    assert.equal(f.posts().length, 2);

    f.onOrder(() => { throw new Error('ECONNRESET fake-live-secret'); });
    const third = await f.orders.preview(1, STUDIO, order({ quantity: 0.5 }));
    await assert.rejects(f.orders.confirm(1, STUDIO, third.id, { confirmed: true }), (error: Error & { code?: string }) =>
      error.code === 'T212_ORDER_UNKNOWN' && /不会自动重试/.test(error.message) && !error.message.includes('fake-live'));
    assert.equal(f.posts().length, 3);
    const attempts = f.attempts();
    assert.deepEqual(attempts.map(row => row.status), ['unknown', 'failed', 'unknown'], 'only a definite refusal is audited as failed');
    assert.ok(!JSON.stringify(attempts).includes('fake-live'));
  } finally { f.close(); }
});

test('once any passkey exists the double confirmation is refused on every other domain, also at confirm time', async () => {
  const f = fixture({ allowLocalhost: '1' });
  const LOCALHOST = { origin: 'http://localhost:3002', rpId: 'localhost' };
  try {
    // Previewed while the user still had no passkey anywhere.
    const early = await f.orders.preview(1, TAILNET, order({}));
    assert.equal(early.requires, 'confirm');
    await registerPasskey(f);

    await assert.rejects(f.orders.confirm(1, TAILNET, early.id, { confirmed: true }), coded('T212_PASSKEY_REQUIRED'));
    await assert.rejects(f.orders.preview(1, TAILNET, order({})), coded('T212_PASSKEY_REQUIRED', /desktop\.tail1234\.ts\.net/));
    await assert.rejects(f.orders.preview(1, LOCALHOST, order({ env: 'demo' })), coded('T212_PASSKEY_REQUIRED'), 'a localhost origin is no way around Face ID');
    assert.equal(f.posts().length, 0);
    assert.deepEqual(f.attempts().map(row => [row.method, row.status]), [['confirm', 'failed']]);

    // The domain that owns the passkey still trades with Face ID.
    const studio = await f.orders.preview(1, STUDIO, order({}));
    assert.equal(studio.requires, 'passkey');
    assert.equal((await f.orders.confirm(1, STUDIO, studio.id, { assertion: goodAssertion })).method, 'passkey');
  } finally { f.close(); }
});

test('STUDIO_T212_REQUIRE_PASSKEY=1 removes the double confirmation entirely', async () => {
  const f = fixture({ requirePasskey: '1' });
  try {
    assert.equal(f.orders.config(1).requirePasskey, true);
    await assert.rejects(f.orders.preview(1, STUDIO, order({})), coded('T212_PASSKEY_REQUIRED', /STUDIO_T212_REQUIRE_PASSKEY/));
    assert.equal(f.calls.length, 0, 'refused before the broker is contacted');
    await registerPasskey(f);
    assert.equal((await f.orders.preview(1, STUDIO, order({}))).requires, 'passkey');
  } finally { f.close(); }
  const standard = fixture();
  try { assert.equal(standard.orders.config(1).requirePasskey, false); } finally { standard.close(); }
});

test('concurrent wrong passwords cannot slip past the five-attempt lock', async () => {
  const f = fixture();
  try {
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => f.orders.passkeyOptions(1, 'owner', STUDIO, `guess-${index}`)));
    assert.ok(attempts.every(result => result.status === 'rejected'));
    assert.ok(f.passwordChecks.length <= 5, `checked ${f.passwordChecks.length} passwords`);
    await assert.rejects(f.orders.passkeyOptions(1, 'owner', STUDIO, PASSWORD), coded('T212_STEP_UP_LOCKED'));
  } finally { f.close(); }
});

test('adding a passkey needs the Studio password, and repeated wrong passwords lock passkey changes', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.orders.passkeyOptions(1, 'owner', STUDIO, 'guess'), coded('T212_STEP_UP_FAILED'));
    await assert.rejects(f.orders.passkeyOptions(1, 'owner', STUDIO, ''), coded('T212_STEP_UP_FAILED'));
    assert.equal(f.webauthnCalls.registration.length, 0, 'no registration challenge without the password');
    // Without a password-gated challenge the attestation is refused.
    await assert.rejects(f.orders.registerPasskey(1, STUDIO, { id: 'cred-1', rawId: 'cred-1', response: { attestationObject: 'x' } } as any), coded('T212_PASSKEY_FAILED'));
    assert.deepEqual(f.orders.config(1).passkeys, []);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(f.orders.passkeyOptions(1, 'owner', STUDIO, `guess-${attempt}`), coded('T212_STEP_UP_FAILED'));
    }
    // Five wrong passwords in a row: even the right one is refused for fifteen minutes.
    await assert.rejects(f.orders.passkeyOptions(1, 'owner', STUDIO, PASSWORD), (error: Error & { code?: string; statusCode?: number }) =>
      error.code === 'T212_STEP_UP_LOCKED' && error.statusCode === 429);
    const checks = f.passwordChecks.length;
    f.advance(15 * 60_000 + 1);
    const passkey = await registerPasskey(f);
    assert.equal(f.passwordChecks.length, checks + 1);
    assert.equal(f.passwordChecks.at(-1), PASSWORD);
    assert.equal(passkey.rpId, STUDIO.rpId);
  } finally { f.close(); }
});

test('removing a passkey needs the Studio password, or that passkey itself on its own domain', async () => {
  const f = fixture();
  try {
    const passkey = await registerPasskey(f);
    await assert.rejects(f.orders.removePasskey(1, STUDIO, passkey.id, { password: 'guess' }), coded('T212_STEP_UP_FAILED'));
    await assert.rejects(f.orders.removePasskey(2, STUDIO, passkey.id, { password: PASSWORD }), /找不到/, 'another user cannot remove it');
    await assert.rejects(f.orders.removePasskey(1, STUDIO, passkey.id, { assertion: goodAssertion }), coded('T212_STEP_UP_FAILED'),
      'an assertion needs a removal challenge first');

    // Only the passkey's own domain can authorise its removal with it.
    await assert.rejects(f.orders.removalOptions(1, TAILNET, passkey.id), coded('T212_STEP_UP_FAILED', /studio\.ajarche\.com/));
    const options = await f.orders.removalOptions(1, STUDIO, passkey.id);
    assert.equal(options.userVerification, 'required');
    assert.deepEqual(options.allowCredentials?.map(item => item.id), ['cred-1']);
    await assert.rejects(f.orders.removePasskey(1, STUDIO, passkey.id, { assertion: badAssertion }), coded('T212_STEP_UP_FAILED'));
    assert.equal(f.orders.config(1).passkeys.length, 1, 'still enabled after failed step-ups');

    await f.orders.removalOptions(1, STUDIO, passkey.id);
    assert.deepEqual(await f.orders.removePasskey(1, STUDIO, passkey.id, { assertion: goodAssertion }), { removed: true });
    const verification = f.webauthnCalls.verifyAuthentication.at(-1);
    assert.equal(verification.expectedRPID, STUDIO.rpId);
    assert.equal(verification.requireUserVerification, true);
    assert.deepEqual(f.orders.config(1).passkeys, []);

    // The password works from any trusted domain.
    const again = await registerPasskey(f);
    assert.deepEqual(await f.orders.removePasskey(1, TAILNET, again.id, { password: PASSWORD }), { removed: true });
    assert.equal(f.posts().length, 0);
  } finally { f.close(); }
});

test('a limit sell is valued at no less than the shares are worth, so a low limit cannot slip past the cap', async () => {
  const f = fixture({ maxOrderValue: '300' });
  try {
    // Two AAPL shares are worth £320.
    await assert.rejects(f.orders.preview(1, STUDIO, order({ side: 'sell', quantity: 2 })), coded('T212_ORDER_CAP'));
    await assert.rejects(f.orders.preview(1, STUDIO, order({ side: 'sell', quantity: 2, type: 'limit', limitPrice: 0.01 })),
      coded('T212_ORDER_CAP', /£320\.00/));
    const one = await f.orders.preview(1, STUDIO, order({ side: 'sell', quantity: 1, type: 'limit', limitPrice: 0.01 }));
    assert.equal(one.estimatedValue, 160);
    // A limit buy is still valued at its limit: 1 × $100 × 0.8.
    assert.equal((await f.orders.preview(1, STUDIO, order({ quantity: 1, type: 'limit', limitPrice: 100 }))).estimatedValue, 80);
    assert.equal(f.posts().length, 0);
  } finally { f.close(); }
});

test('unheld tickers are converted from their quote currency, and refused when no exchange rate is known', async () => {
  const f = fixture();
  const instrumentReads = () => f.calls.filter(call => call.url.endsWith('/equity/metadata/instruments')).length;
  try {
    // GBX is pence: 100 shares at 150p are £150.
    const vodafone = await f.orders.preview(1, STUDIO, order({ ticker: 'VODl_EQ', type: 'limit', quantity: 100, limitPrice: 150 }));
    assert.equal(vodafone.estimatedValue, 150);
    assert.ok(vodafone.warnings.some(warning => warning.includes('GBX')));
    await assert.rejects(f.orders.preview(1, STUDIO, order({ ticker: 'SAP_DE_EQ', type: 'limit', quantity: 1, limitPrice: 100 })),
      coded('T212_FX_UNKNOWN', /EUR.*1:1/));
    await assert.rejects(f.orders.preview(1, STUDIO, order({ ticker: 'NOPE_US_EQ', type: 'limit', quantity: 1, limitPrice: 1 })), coded('T212_UNKNOWN_INSTRUMENT'));

    // The instrument list is read once a day, also across orders (which drop the account caches).
    const tesla = await f.orders.preview(1, STUDIO, order({ ticker: 'TSLA_US_EQ', type: 'limit', quantity: 1, limitPrice: 100 }));
    await f.orders.confirm(1, STUDIO, tesla.id, { confirmed: true });
    await f.orders.preview(1, STUDIO, order({ ticker: 'TSLA_US_EQ', type: 'limit', quantity: 2, limitPrice: 100 }));
    assert.equal(instrumentReads(), 1);
    f.advance(24 * 60 * 60_000 + 1);
    await f.orders.preview(1, STUDIO, order({ ticker: 'TSLA_US_EQ', type: 'limit', quantity: 2, limitPrice: 100 }));
    assert.equal(instrumentReads(), 2);
  } finally { f.close(); }

  // A forint account: a dollar is worth hundreds of HUF, so 1:1 would understate the order hundreds of times.
  const forint = { ...SUMMARY, currency: 'HUF', cash: { availableToTrade: 1_000_000, reservedForOrders: 0, inPies: 0 } };
  const noDollars = fixture({ summary: forint, positions: [] });
  try {
    await assert.rejects(noDollars.orders.preview(1, STUDIO, order({ ticker: 'TSLA_US_EQ', type: 'limit', quantity: 1, limitPrice: 200 })),
      coded('T212_FX_UNKNOWN', /HUF/));
  } finally { noDollars.close(); }
  const withDollars = fixture({
    summary: forint,
    positions: [{ instrument: { ticker: 'AAPL_US_EQ', name: 'Apple', currency: 'USD' }, quantity: 2, currentPrice: 200, walletImpact: { currentValue: 144_000, totalCost: 140_000, unrealizedProfitLoss: 4000 } }],
  });
  try {
    // 360 HUF per dollar from the AAPL holding: 1 × $200 is 72,000 HUF, far above the 500 cap.
    await assert.rejects(withDollars.orders.preview(1, STUDIO, order({ ticker: 'TSLA_US_EQ', type: 'limit', quantity: 1, limitPrice: 200 })),
      coded('T212_ORDER_CAP', /72,000/));
    assert.equal(withDollars.posts().length, 0);
  } finally { withDollars.close(); }
});

test('after an unknown outcome an identical order is held back for a few minutes unless explicitly acknowledged', async () => {
  const f = fixture();
  try {
    const parallel = await f.orders.preview(1, STUDIO, order({}));
    f.onOrder(() => new Response('', { status: 503 }));
    const first = await f.orders.preview(1, STUDIO, order({}));
    await assert.rejects(f.orders.confirm(1, STUDIO, first.id, { confirmed: true }), coded('T212_ORDER_UNKNOWN'));
    assert.deepEqual(f.attempts().map(row => row.status), ['unknown']);
    f.onOrder(() => Response.json(ORDER));

    await assert.rejects(f.orders.preview(1, STUDIO, order({})), (error: Error & { code?: string; statusCode?: number }) =>
      error.code === 'T212_ORDER_UNKNOWN_PENDING' && error.statusCode === 409 && /Trading 212/.test(error.message));
    await assert.rejects(f.orders.confirm(1, STUDIO, parallel.id, { confirmed: true }), coded('T212_ORDER_UNKNOWN_PENDING'),
      'a preview made before the unknown outcome cannot place the same order either');
    assert.equal(f.posts().length, 1);

    // A different order is not affected; the same order goes through once acknowledged.
    assert.equal((await f.orders.preview(1, STUDIO, order({ quantity: 2 }))).requires, 'confirm');
    assert.equal((await f.orders.preview(1, STUDIO, order({ env: 'demo' }))).env, 'demo');
    const acknowledged = await f.orders.preview(1, STUDIO, order({}), { acknowledgeUnknown: true });
    assert.ok(acknowledged.warnings.some(warning => warning.includes('状态未知')));
    await f.orders.confirm(1, STUDIO, acknowledged.id, { confirmed: true });
    assert.equal(f.posts().length, 2);

    // The hold ends after five minutes.
    f.advance(5 * 60_000 + 1);
    assert.equal((await f.orders.preview(1, STUDIO, order({}))).requires, 'confirm');
  } finally { f.close(); }
});
