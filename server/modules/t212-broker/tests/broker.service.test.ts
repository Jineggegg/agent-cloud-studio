import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertion, attestation, coded, enroll, fixture, ORDER, order, signedOrder, START, STUDIO, SUMMARY, TAILNET } from './broker-fixture.js';

const HEALTHY_ISOLATION = { ok: true, interopActive: false, interopBinfmt: false, interopSocket: false, windowsDrives: [] as string[], notes: [] as string[] };

test('without allowed accounts, a trusted origin or a passkey nothing is previewed and Trading 212 is not called', async () => {
  const off = fixture({ config: { allowedEnvs: [] } });
  const f = fixture();
  try {
    await assert.rejects(off.service.preview({ origin: STUDIO, order: order() }), coded('T212_TRADING_DISABLED', /allowedEnvs/));
    await assert.rejects(f.service.preview({ origin: 'https://evil.example', order: order() }), coded('T212_UNTRUSTED_ORIGIN'));
    await assert.rejects(f.service.preview({ origin: `${STUDIO}/`, order: order() }), coded('T212_UNTRUSTED_ORIGIN'));
    // Live orders always need a passkey: there is no double-confirmation path.
    await assert.rejects(f.service.preview({ origin: STUDIO, order: order() }), coded('T212_PASSKEY_REQUIRED', /注册码/));
    await assert.rejects(f.service.preview({ origin: STUDIO, order: order({ env: 'demo' }) }), coded('T212_PASSKEY_REQUIRED'));
    assert.equal(off.calls.length + f.calls.length, 0);
  } finally { off.close(); f.close(); }
});

test('enrollment codes are random, stored only as a hash, expire after ten minutes and enrol exactly one passkey', async () => {
  const f = fixture();
  try {
    const first = f.service.createEnrollmentCode();
    assert.match(first.code, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    assert.equal(Date.parse(first.expiresAt) - START, 10 * 60_000);
    assert.notEqual(f.service.createEnrollmentCode().code, first.code);
    const stored = JSON.stringify(f.database.prepare('SELECT * FROM enrollment_codes').all());
    assert.ok(!stored.includes(first.code) && !stored.includes(first.code.replace(/-/g, '')), 'only a hash is stored');

    // Typed in lower case without dashes still works; registration options alone do not use the code up.
    const typed = first.code.toLowerCase().replace(/-/g, ' ');
    const cancelled = await f.service.registrationOptions({ origin: STUDIO, enrollmentCode: typed });
    assert.equal(f.webauthnCalls.registration[0].rpID, 'studio.ajarche.com');
    assert.deepEqual(f.webauthnCalls.registration[0].authenticatorSelection, { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' });
    const options = await f.service.registrationOptions({ origin: STUDIO, enrollmentCode: first.code });
    const passkey = await f.service.register({ origin: STUDIO, response: attestation({ challenge: options.challenge, origin: STUDIO }), label: 'iPad' });
    assert.deepEqual([passkey.rpId, passkey.label], ['studio.ajarche.com', 'iPad']);
    assert.ok(f.logs.some(line => line.includes('enrolled for studio.ajarche.com')));

    // The code enrolled one passkey; the ceremony started before cannot enrol a second with it.
    await assert.rejects(f.service.register({ origin: STUDIO, response: attestation({ challenge: cancelled.challenge, origin: STUDIO, id: 'cred-2' }), label: null }),
      coded('T212_ENROLL_CODE_INVALID'));
    await assert.rejects(f.service.registrationOptions({ origin: STUDIO, enrollmentCode: first.code }), coded('T212_ENROLL_CODE_INVALID'));

    const late = f.service.createEnrollmentCode();
    f.advance(10 * 60_000 + 1);
    await assert.rejects(f.service.registrationOptions({ origin: STUDIO, enrollmentCode: late.code }), coded('T212_ENROLL_CODE_INVALID', /过期/));
    assert.equal(f.service.passkeys().length, 1);
    assert.ok(!f.logs.join('\n').includes(late.code), 'codes are never logged');
  } finally { f.close(); }
});

test('a registration is bound to its challenge, origin and RP ID and cannot be replayed', async () => {
  const f = fixture();
  try {
    const { code } = f.service.createEnrollmentCode();
    const options = await f.service.registrationOptions({ origin: STUDIO, enrollmentCode: code });
    // Answered from another trusted origin: refused, and the challenge is gone.
    await assert.rejects(f.service.register({ origin: TAILNET, response: attestation({ challenge: options.challenge, origin: TAILNET }), label: null }), coded('T212_PASSKEY_FAILED'));
    await assert.rejects(f.service.register({ origin: STUDIO, response: attestation({ challenge: options.challenge, origin: STUDIO }), label: null }), coded('T212_PASSKEY_FAILED'));

    const again = await f.service.registrationOptions({ origin: STUDIO, enrollmentCode: code });
    // Signed for another RP ID (a software authenticator can claim anything): the RP ID hash does not match.
    await assert.rejects(f.service.register({ origin: STUDIO, response: attestation({ challenge: again.challenge, origin: STUDIO, rpId: 'evil.example' }), label: null }), coded('T212_PASSKEY_FAILED'));
    // A response without any challenge we issued.
    await assert.rejects(f.service.register({ origin: STUDIO, response: attestation({ challenge: 'made-up', origin: STUDIO }), label: null }), coded('T212_PASSKEY_FAILED'));
    assert.deepEqual(f.service.passkeys(), []);
  } finally { f.close(); }
});

test('wrong enrollment codes are counted and lock enrollment for fifteen minutes', async () => {
  const f = fixture();
  try {
    const { code } = f.service.createEnrollmentCode();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await assert.rejects(f.service.registrationOptions({ origin: STUDIO, enrollmentCode: `WRONG-${attempt}` }), coded('T212_ENROLL_CODE_INVALID'));
    }
    await assert.rejects(f.service.registrationOptions({ origin: STUDIO, enrollmentCode: code }), (error: Error & { code?: string; statusCode?: number }) =>
      error.code === 'T212_LOCKED' && error.statusCode === 429);
    f.advance(15 * 60_000 + 1);
    const another = f.service.createEnrollmentCode();
    assert.ok(await f.service.registrationOptions({ origin: STUDIO, enrollmentCode: another.code }));
  } finally { f.close(); }
});

test('a passkey order is valued by the broker, signed for exactly this challenge and placed exactly once', async () => {
  const f = fixture();
  try {
    await enroll(f);
    const { preview, assertion: signed } = await signedOrder(f, { quantity: 1.5 });
    assert.equal(preview.requires, 'passkey');
    assert.equal(preview.estimatedValue, 240);
    assert.equal(preview.currency, 'GBP');
    assert.equal(Date.parse(preview.expiresAt) - START, 60_000);
    assert.equal(preview.authentication?.userVerification, 'required');
    assert.deepEqual(((preview.authentication ?? {}).allowCredentials as { id: string }[]).map(item => item.id), ['cred-1']);
    assert.equal(f.posts().length, 0, 'previewing never places an order');
    // The broker read the account with its own key.
    assert.ok(f.calls.every(call => call.authorization === `Basic ${Buffer.from('fake-live-key:fake-live-secret').toString('base64')}`));

    const result = await f.service.confirm({ origin: STUDIO, id: preview.id, proof: { assertion: signed } });
    assert.equal(result.method, 'passkey');
    assert.equal(result.order.id, '9001');
    const posts = f.posts();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, 'https://live.trading212.com/api/v0/equity/orders/market');
    assert.equal(posts[0].body, JSON.stringify({ ticker: 'AAPL_US_EQ', quantity: 1.5 }));
    const verification = f.webauthnCalls.verifyAuthentication.at(-1);
    assert.equal(verification.expectedChallenge, preview.authentication?.challenge);
    assert.equal(verification.expectedOrigin, STUDIO);
    assert.equal(verification.expectedRPID, 'studio.ajarche.com');

    // Replays: the same preview id, and the same assertion against a fresh preview.
    await assert.rejects(f.service.confirm({ origin: STUDIO, id: preview.id, proof: { assertion: signed } }), coded('T212_PREVIEW_GONE'));
    const fresh = await f.service.preview({ origin: STUDIO, order: order({ quantity: 1.5 }) });
    await assert.rejects(f.service.confirm({ origin: STUDIO, id: fresh.id, proof: { assertion: signed } }), coded('T212_PASSKEY_FAILED'));
    assert.equal(f.posts().length, 1, 'one signature places at most one order');

    const audit = f.audit();
    assert.deepEqual(audit.map(row => [row.status, row.method]), [['placed', 'passkey'], ['refused', 'passkey']]);
    assert.equal(audit[0].broker_order_id, '9001');
    assert.ok(audit[0].passkey_id);
    assert.ok(!JSON.stringify(audit).includes('fake-live'), 'no secret is recorded');
    assert.ok(!f.logs.join('\n').includes('fake-live'), 'no secret is logged');
  } finally { f.close(); }
});

test('challenges expire after 60 seconds and are bound to the origin and RP ID they were issued for', async () => {
  const f = fixture();
  try {
    await enroll(f);
    const stale = await signedOrder(f);
    f.advance(60_001);
    await assert.rejects(f.service.confirm({ origin: STUDIO, id: stale.preview.id, proof: { assertion: stale.assertion } }), coded('T212_PREVIEW_EXPIRED'));

    const elsewhere = await signedOrder(f);
    await assert.rejects(f.service.confirm({ origin: TAILNET, id: elsewhere.preview.id, proof: { assertion: elsewhere.assertion } }), coded('T212_UNTRUSTED_ORIGIN'));

    // An assertion signed for another RP ID, or by a passkey of another RP ID, does not verify.
    const wrongRp = await f.service.preview({ origin: STUDIO, order: order() });
    await assert.rejects(f.service.confirm({ origin: STUDIO, id: wrongRp.id, proof: { assertion: assertion({ challenge: String(wrongRp.authentication?.challenge), origin: STUDIO, rpId: 'desktop.tail1234.ts.net' }) } }),
      coded('T212_PASSKEY_FAILED'));
    // A domain without its own passkey cannot trade, even though another domain has one.
    await assert.rejects(f.service.preview({ origin: TAILNET, order: order() }), coded('T212_PASSKEY_REQUIRED', /desktop\.tail1234\.ts\.net/));
    await enroll(f, TAILNET, 'cred-tailnet');
    const tailnet = await signedOrder(f, {}, TAILNET, { id: 'cred-tailnet' });
    assert.deepEqual(((tailnet.preview.authentication ?? {}).allowCredentials as { id: string }[]).map(item => item.id), ['cred-tailnet']);
    const studioKeyOnTailnet = assertion({ challenge: String(tailnet.preview.authentication?.challenge), origin: TAILNET, id: 'cred-1' });
    await assert.rejects(f.service.confirm({ origin: TAILNET, id: tailnet.preview.id, proof: { assertion: studioKeyOnTailnet } }), coded('T212_PASSKEY_FAILED'));

    assert.equal(f.posts().length, 0);
    assert.deepEqual(f.audit().map(row => row.status), ['refused', 'refused', 'refused', 'refused']);
  } finally { f.close(); }
});

test('the signature counter must increase once an authenticator counts, and a plain confirmation is no proof', async () => {
  const f = fixture();
  try {
    await enroll(f);
    const first = await signedOrder(f, {}, STUDIO, { counter: 5 });
    await f.service.confirm({ origin: STUDIO, id: first.preview.id, proof: { assertion: first.assertion } });
    const stored = f.database.prepare('SELECT counter, last_used_at FROM passkeys').get() as { counter: number; last_used_at: string | null };
    assert.equal(stored.counter, 5);
    assert.ok(stored.last_used_at);

    // A cloned authenticator replaying an old counter is refused.
    const cloned = await signedOrder(f, { quantity: 2 }, STUDIO, { counter: 5 });
    await assert.rejects(f.service.confirm({ origin: STUDIO, id: cloned.preview.id, proof: { assertion: cloned.assertion } }), coded('T212_PASSKEY_FAILED'));
    assert.ok(f.logs.some(line => line.includes('did not increase')));
    const next = await signedOrder(f, { quantity: 0.5 }, STUDIO, { counter: 6 });
    await f.service.confirm({ origin: STUDIO, id: next.preview.id, proof: { assertion: next.assertion } });

    const unsigned = await f.service.preview({ origin: STUDIO, order: order() });
    await assert.rejects(f.service.confirm({ origin: STUDIO, id: unsigned.id, proof: { confirmed: true } }), coded('T212_PASSKEY_REQUIRED'));
    assert.equal(f.posts().length, 2);
  } finally { f.close(); }
});

test('authenticators that never count (always 0) keep working', async () => {
  const f = fixture();
  try {
    await enroll(f);
    for (const quantity of [1, 0.5]) {
      const signed = await signedOrder(f, { quantity });
      await f.service.confirm({ origin: STUDIO, id: signed.preview.id, proof: { assertion: signed.assertion } });
    }
    assert.equal(f.posts().length, 2);
  } finally { f.close(); }
});

test('failed assertions are limited: ten in fifteen minutes lock confirmations', async () => {
  const f = fixture();
  try {
    await enroll(f);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const preview = await f.service.preview({ origin: STUDIO, order: order() });
      const forged = assertion({ challenge: String(preview.authentication?.challenge), origin: STUDIO, signature: 'forged' });
      await assert.rejects(f.service.confirm({ origin: STUDIO, id: preview.id, proof: { assertion: forged } }), coded('T212_PASSKEY_FAILED'));
    }
    const real = await signedOrder(f);
    await assert.rejects(f.service.confirm({ origin: STUDIO, id: real.preview.id, proof: { assertion: real.assertion } }), coded('T212_LOCKED'));
    // A lockout does not consume the challenge, so the owner can retry after the window.
    f.advance(15 * 60_000 + 1);
    const later = await signedOrder(f);
    assert.equal((await f.service.confirm({ origin: STUDIO, id: later.preview.id, proof: { assertion: later.assertion } })).method, 'passkey');
    assert.equal(f.posts().length, 1);
  } finally { f.close(); }
});

test('the cap uses the broker’s own FX-aware valuation, including limit sells and unheld tickers', async () => {
  const f = fixture({ config: { maxOrderValue: 300 } });
  try {
    await enroll(f);
    const preview = (input: Parameters<typeof order>[0]) => f.service.preview({ origin: STUDIO, order: order(input) });
    await assert.rejects(preview({ quantity: 2 }), coded('T212_ORDER_CAP', /£320\.00.*£300\.00/));
    // A limit sell is valued at no less than the shares are worth.
    await assert.rejects(preview({ side: 'sell', quantity: 2, type: 'limit', limitPrice: 0.01 }), coded('T212_ORDER_CAP'));
    await assert.rejects(preview({ side: 'sell', quantity: 3 }), /超过持仓：只持有 2 股/);
    await assert.rejects(preview({ ticker: 'TSLA_US_EQ' }), /改用限价单/);
    assert.equal((await preview({ quantity: 1, type: 'limit', limitPrice: 100 })).estimatedValue, 80);
    // TSLA is quoted in USD like the AAPL holding (£0.80 per dollar).
    const tesla = await preview({ ticker: 'TSLA_US_EQ', type: 'limit', quantity: 1, limitPrice: 300, timeValidity: 'GOOD_TILL_CANCEL' });
    assert.equal(tesla.estimatedValue, 240);
    assert.ok(tesla.warnings.some(warning => warning.includes('AAPL_US_EQ')));
    assert.ok(tesla.warnings.some(warning => warning.includes('撤单前有效')));
    // GBX is pence: 100 shares at 150p are £150.
    assert.equal((await preview({ ticker: 'VODl_EQ', type: 'limit', quantity: 100, limitPrice: 150 })).estimatedValue, 150);
    await assert.rejects(preview({ ticker: 'SAP_DE_EQ', type: 'limit', quantity: 1, limitPrice: 100 }), coded('T212_FX_UNKNOWN', /1:1/));
    await assert.rejects(preview({ ticker: 'NOPE_US_EQ', type: 'limit', quantity: 1, limitPrice: 1 }), coded('T212_UNKNOWN_INSTRUMENT'));
    assert.equal(f.posts().length, 0);
  } finally { f.close(); }

  // A forint account: valuing dollars 1:1 would understate the order hundreds of times.
  const forint = fixture({
    summary: { ...SUMMARY, currency: 'HUF' },
    positions: [{ instrument: { ticker: 'AAPL_US_EQ', currency: 'USD' }, quantity: 2, currentPrice: 200, walletImpact: { currentValue: 144_000 } }],
  });
  try {
    await enroll(forint);
    await assert.rejects(forint.service.preview({ origin: STUDIO, order: order({ ticker: 'TSLA_US_EQ', type: 'limit', quantity: 1, limitPrice: 200 }) }),
      coded('T212_ORDER_CAP', /72,000/));
  } finally { forint.close(); }
});

test('outcomes are audited as placed, rejected or unknown, and an unknown one holds back an identical order', async () => {
  const f = fixture();
  try {
    await enroll(f);
    f.onOrder(() => new Response('', { status: 503 }));
    // A preview of the same order made before the first outcome is known (a second tab, a forged request).
    const early = await signedOrder(f);
    const first = await signedOrder(f);
    await assert.rejects(f.service.confirm({ origin: STUDIO, id: first.preview.id, proof: { assertion: first.assertion } }), coded('T212_ORDER_UNKNOWN', /订单状态未知/));

    f.onOrder(() => Response.json({ code: 'InsufficientFreeForStocksBuy', clarification: 'Insufficient funds <script>' }, { status: 400 }));
    const second = await signedOrder(f, { quantity: 2 });
    await assert.rejects(f.service.confirm({ origin: STUDIO, id: second.preview.id, proof: { assertion: second.assertion } }), (error: Error & { code?: string }) =>
      error.code === 'TRADING212_REJECTED' && error.message.includes('Insufficient funds') && !error.message.includes('<'));

    f.onOrder(() => { throw new Error('ECONNRESET fake-live-secret'); });
    const third = await signedOrder(f, { quantity: 0.5 });
    await assert.rejects(f.service.confirm({ origin: STUDIO, id: third.preview.id, proof: { assertion: third.assertion } }), (error: Error & { code?: string }) =>
      error.code === 'T212_ORDER_UNKNOWN' && /不会自动重试/.test(error.message) && !error.message.includes('fake-live'));
    assert.equal(f.posts().length, 3, 'never retried');
    assert.deepEqual(f.audit().map(row => row.status), ['unknown', 'rejected', 'unknown']);

    // The identical order is held back for five minutes, also through the preview made before, and nothing the
    // caller sends lifts the hold: an old acknowledgeUnknown flag is ignored.
    f.onOrder(() => Response.json(ORDER));
    await assert.rejects(f.service.preview({ origin: STUDIO, order: order() }), coded('T212_ORDER_UNKNOWN_PENDING', /约 5 分钟内不接受相同的订单/));
    const flagged = { origin: STUDIO, order: order(), acknowledgeUnknown: true } as Parameters<typeof f.service.preview>[0];
    await assert.rejects(f.service.preview(flagged), coded('T212_ORDER_UNKNOWN_PENDING'));
    await assert.rejects(f.service.confirm({ origin: STUDIO, id: early.preview.id, proof: { assertion: early.assertion } }), coded('T212_ORDER_UNKNOWN_PENDING'));
    assert.equal(f.posts().length, 3, 'the held order never reached Trading 212');
    // A different order is not held; the identical one is accepted again once the hold has passed.
    assert.equal((await f.service.preview({ origin: STUDIO, order: order({ quantity: 3 }) })).requires, 'passkey');
    f.advance(4 * 60_000);
    await assert.rejects(f.service.preview({ origin: STUDIO, order: order() }), coded('T212_ORDER_UNKNOWN_PENDING', /约 1 分钟内/));
    f.advance(60_000 + 1);
    const later = await signedOrder(f);
    await f.service.confirm({ origin: STUDIO, id: later.preview.id, proof: { assertion: later.assertion } });
    assert.equal(f.posts().length, 4);
  } finally { f.close(); }
});

test('an unexpected throw after the slot is reserved settles it: unknown once the order may have been sent, error before', async () => {
  // Sent: placeOrder fails in a way it never reports as a value (a bug after the request went out).
  const sent = fixture({ wrap: { trading212: client => ({ ...client, placeOrder: async () => { throw new TypeError('bug after the request'); } }) } });
  try {
    await enroll(sent);
    const signed = await signedOrder(sent);
    await assert.rejects(sent.service.confirm({ origin: STUDIO, id: signed.preview.id, proof: { assertion: signed.assertion } }),
      coded('T212_ORDER_UNKNOWN', /订单状态未知/));
    assert.deepEqual(sent.audit().map(row => [row.status, row.error]), [['unknown', '交易代理在提交订单时出错，订单状态未知']]);
    assert.ok(sent.audit()[0].passkey_id, 'the verified passkey is recorded');
    // It counts like any unknown outcome: the identical order is held back.
    await assert.rejects(sent.service.preview({ origin: STUDIO, order: order() }), coded('T212_ORDER_UNKNOWN_PENDING'));
  } finally { sent.close(); }

  // Not sent: an internal failure while verifying the passkey, before placeOrder was called.
  const early = fixture({
    config: { maxOrdersPerHour: 1 },
    wrap: {
      webauthn: webauthn => ({
        ...webauthn,
        verifyAuthenticationResponse: (async () => ({ verified: true, get authenticationInfo(): never { throw new RangeError('database is locked'); } })) as unknown as typeof webauthn.verifyAuthenticationResponse,
      }),
    },
  });
  try {
    await enroll(early);
    const signed = await signedOrder(early);
    await assert.rejects(early.service.confirm({ origin: STUDIO, id: signed.preview.id, proof: { assertion: signed.assertion } }), /database is locked/);
    assert.deepEqual(early.audit().map(row => row.status), ['error']);
    assert.equal(early.posts().length, 0);
    // 'error' counts against nothing: with an hourly limit of one, the next order may still go through.
    assert.ok(await early.service.preview({ origin: STUDIO, order: order() }));
  } finally { early.close(); }
});

test('orders a killed broker left pending become unknown at the next start and keep counting', async () => {
  const f = fixture({ config: { maxOrdersPerHour: 1 } });
  try {
    await enroll(f);
    // What a broker killed between reserving the slot and recording the outcome leaves behind.
    f.repository.recordPendingAudit({
      previewId: 'p1', env: 'live', ticker: 'AAPL_US_EQ', side: 'buy', type: 'market', quantity: 1, limitPrice: null,
      estimatedValue: 160, currency: 'GBP', method: 'passkey', rpId: 'studio.ajarche.com', passkeyId: null,
    }, START);
    assert.equal(f.service.recoverInterruptedOrders(), 1);
    assert.equal(f.service.recoverInterruptedOrders(), 0, 'only once');
    assert.deepEqual(f.audit().map(row => [row.status, row.error]), [['unknown', '交易代理在下单途中停止，订单状态未知：请在 Trading 212 核对']]);
    assert.ok(f.logs.some(line => line.includes('marked 1 interrupted order(s) as unknown')));
  } finally { f.close(); }
});

test('the daily value cap is per account and per currency, and status reports each account\'s budget', async () => {
  const f = fixture({ config: { maxDailyOrderValue: 300 } });
  try {
    await enroll(f);
    const live = await signedOrder(f, { env: 'live', quantity: 1 });
    await f.service.confirm({ origin: STUDIO, id: live.preview.id, proof: { assertion: live.assertion } });
    // £160 of live orders do not use up the demo account's budget.
    const demo = await signedOrder(f, { env: 'demo', quantity: 1 });
    await f.service.confirm({ origin: STUDIO, id: demo.preview.id, proof: { assertion: demo.assertion } });
    await assert.rejects(f.service.preview({ origin: STUDIO, order: order({ env: 'live', quantity: 1 }) }), coded('T212_DAILY_LIMIT', /实盘账户 .*还剩 £140\.00/));
    await assert.rejects(f.service.preview({ origin: STUDIO, order: order({ env: 'demo', quantity: 1 }) }), coded('T212_DAILY_LIMIT', /模拟盘账户/));
    assert.deepEqual(f.service.status().dailyOrderValue, {
      live: { currency: 'GBP', used: 160, remaining: 140 }, demo: { currency: 'GBP', used: 160, remaining: 140 },
    });
    // An order recorded in another currency (an account whose currency changed) is not added 1:1 to this one.
    f.repository.recordAudit({
      previewId: 'old', env: 'live', ticker: 'TSLA_US_EQ', side: 'buy', type: 'limit', quantity: 1, limitPrice: 250, estimatedValue: 250,
      currency: 'USD', method: 'passkey', rpId: 'studio.ajarche.com', passkeyId: null, status: 'placed',
    }, START - 1);
    assert.deepEqual(f.service.status().dailyOrderValue.live, { currency: 'GBP', used: 160, remaining: 140 });
    f.advance(24 * 60 * 60_000 + 1);
    assert.deepEqual(f.service.status().dailyOrderValue.live, { currency: 'GBP', used: 0, remaining: 300 });
  } finally { f.close(); }
  const off = fixture();
  try { assert.equal(off.service.status().dailyOrderValue.live, undefined, 'no account read yet and no orders: no figures'); } finally { off.close(); }
});

test('demo orders may skip the passkey only when the owner configured it; live never can', async () => {
  const f = fixture({ config: { demoConfirmWithoutPasskey: true } });
  try {
    const demo = await f.service.preview({ origin: STUDIO, order: order({ env: 'demo' }) });
    assert.equal(demo.requires, 'confirm');
    assert.equal('authentication' in demo, false);
    await assert.rejects(f.service.confirm({ origin: STUDIO, id: (await f.service.preview({ origin: STUDIO, order: order({ env: 'demo' }) })).id,
      proof: { assertion: assertion({ challenge: 'x', origin: STUDIO }) } }), coded('T212_CONFIRM_REQUIRED'));
    const result = await f.service.confirm({ origin: STUDIO, id: demo.id, proof: { confirmed: true } });
    assert.equal(result.method, 'confirm');
    assert.equal(f.posts()[0].url, 'https://demo.trading212.com/api/v0/equity/orders/market');
    await assert.rejects(f.service.preview({ origin: STUDIO, order: order({ env: 'live' }) }), coded('T212_PASSKEY_REQUIRED'));
    assert.equal(f.service.status().demoConfirm, true);
  } finally { f.close(); }
});

test('the hourly order limit and the pending-challenge limit bound abuse through the socket', async () => {
  const f = fixture({ config: { maxOrdersPerHour: 2 } });
  try {
    await enroll(f);
    for (const quantity of [1, 0.5]) {
      const signed = await signedOrder(f, { quantity });
      await f.service.confirm({ origin: STUDIO, id: signed.preview.id, proof: { assertion: signed.assertion } });
    }
    await assert.rejects(f.service.preview({ origin: STUDIO, order: order() }), coded('T212_HOURLY_LIMIT'));
    f.advance(60 * 60_000 + 1);
    for (let index = 0; index < 50; index += 1) await f.service.preview({ origin: STUDIO, order: order() });
    await assert.rejects(f.service.preview({ origin: STUDIO, order: order() }), coded('T212_TOO_MANY_PENDING'));
    f.advance(60_001);
    assert.ok(await f.service.preview({ origin: STUDIO, order: order() }), 'expired challenges are pruned');
  } finally { f.close(); }
});

test('removing a passkey needs an assertion from a passkey of the same RP ID or an enrollment code', async () => {
  const f = fixture();
  try {
    const ipad = await enroll(f, STUDIO, 'cred-1');
    const iphone = await enroll(f, STUDIO, 'cred-2');
    await assert.rejects(f.service.removalOptions({ origin: TAILNET, id: ipad.id }), coded('T212_STEP_UP_REQUIRED'));
    await assert.rejects(f.service.removePasskey({ origin: STUDIO, id: ipad.id, proof: { assertion: assertion({ challenge: 'none', origin: STUDIO }) } }),
      coded('T212_STEP_UP_FAILED'), 'an assertion needs a removal challenge');

    const options = await f.service.removalOptions({ origin: STUDIO, id: ipad.id });
    assert.deepEqual(options.allowCredentials?.map(item => item.id), ['cred-1', 'cred-2']);
    // The challenge is bound to the passkey it was issued for.
    await assert.rejects(f.service.removePasskey({ origin: STUDIO, id: iphone.id, proof: { assertion: assertion({ challenge: options.challenge, origin: STUDIO, id: 'cred-2' }) } }),
      coded('T212_STEP_UP_FAILED'));
    const retry = await f.service.removalOptions({ origin: STUDIO, id: ipad.id });
    await assert.rejects(f.service.removePasskey({ origin: STUDIO, id: ipad.id, proof: { assertion: assertion({ challenge: retry.challenge, origin: STUDIO, id: 'cred-2', signature: 'forged' }) } }),
      coded('T212_STEP_UP_FAILED'));
    assert.equal(f.service.passkeys().length, 2);

    // The iPhone's passkey authorises removing the lost iPad's.
    const valid = await f.service.removalOptions({ origin: STUDIO, id: ipad.id });
    assert.deepEqual(await f.service.removePasskey({ origin: STUDIO, id: ipad.id, proof: { assertion: assertion({ challenge: valid.challenge, origin: STUDIO, id: 'cred-2' }) } }), { removed: true });

    await assert.rejects(f.service.removePasskey({ origin: TAILNET, id: iphone.id, proof: { enrollmentCode: 'AAAAA-AAAAA-AAAAA-AAAAA' } }), coded('T212_ENROLL_CODE_INVALID'));
    const { code } = f.service.createEnrollmentCode();
    assert.deepEqual(await f.service.removePasskey({ origin: TAILNET, id: iphone.id, proof: { enrollmentCode: code } }), { removed: true });
    await assert.rejects(f.service.removePasskey({ origin: TAILNET, id: iphone.id, proof: { enrollmentCode: code } }), coded('T212_PASSKEY_NOT_FOUND'));
    assert.deepEqual(f.service.passkeys(), []);
    assert.equal(f.posts().length, 0);
  } finally { f.close(); }
});

test('status reports configuration and passkeys but never key material', async () => {
  const f = fixture({ config: { allowedEnvs: ['demo'], maxOrderValue: 250 } });
  const keyless = fixture({ keys: false });
  try {
    await enroll(f);
    const status = f.service.status();
    assert.deepEqual([status.allowedEnvs, status.maxOrderValue, status.maxOrdersPerHour, status.origins], [['demo'], 250, 10, [STUDIO, TAILNET]]);
    assert.deepEqual(status.keys, { live: true, demo: true });
    assert.deepEqual(status.passkeys.map(item => item.rpId), ['studio.ajarche.com']);
    assert.ok(!JSON.stringify(status).includes('fake-'));
    assert.deepEqual(keyless.service.status().keys, { live: false, demo: false });
  } finally { f.close(); keyless.close(); }
});

test('status carries the broker-recorded passkey provenance and the live isolation state', async () => {
  // A software authenticator the attacker enrolled would attest as multi-device and backed up, and would
  // likely show a different AAGUID than the owner's platform passkey — the CLI/Settings show these, not the label.
  const f = fixture({ isolation: { ...HEALTHY_ISOLATION, ok: false, interopActive: true, interopBinfmt: true, windowsDrives: ['/mnt/c'], notes: ['note'] } });
  try {
    const code = f.service.createEnrollmentCode().code;
    const options = await f.service.registrationOptions({ origin: STUDIO, enrollmentCode: code });
    await f.service.register({
      origin: STUDIO, label: 'iPad',
      response: attestation({ challenge: options.challenge, origin: STUDIO, aaguid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', deviceType: 'multiDevice', backedUp: true }),
    });
    const passkey = f.service.status().passkeys[0];
    assert.equal(passkey.aaguid, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(passkey.multiDevice, true);
    assert.equal(passkey.backedUp, true);
    assert.equal(passkey.label, 'iPad');
    assert.ok(passkey.credentialIdPrefix.length > 0 && passkey.credentialIdPrefix.length <= 16);
    // The enrollment log records the provenance, not just the Studio-supplied label.
    assert.ok(f.logs.some(line => line.includes('aaaaaaaa-bbbb') && line.includes('multi-device')));

    const status = f.service.status();
    assert.equal(status.isolation.ok, false);
    assert.equal(status.isolation.interopActive, true);
    assert.deepEqual(status.isolation.windowsDrives, ['/mnt/c']);
  } finally { f.close(); }
});

test('a daily cumulative value cap holds back further orders until the 24h window rolls', async () => {
  const f = fixture({ config: { maxDailyOrderValue: 300 } });
  try {
    await enroll(f);
    // One AAPL share is valued at £160 by the broker; the first order fits under the £300 daily cap.
    const first = await signedOrder(f, { quantity: 1 });
    await f.service.confirm({ origin: STUDIO, id: first.preview.id, proof: { assertion: first.assertion } });
    // 160 + 160 would exceed 300, so the next preview is refused before any passkey prompt.
    await assert.rejects(f.service.preview({ origin: STUDIO, order: order({ quantity: 1 }) }), coded('T212_DAILY_LIMIT', /每日累计上限/));
    assert.equal(f.posts().length, 1);
    // After 24 hours the window clears and trading resumes.
    f.advance(24 * 60 * 60_000 + 1);
    const later = await signedOrder(f, { quantity: 1 });
    await f.service.confirm({ origin: STUDIO, id: later.preview.id, proof: { assertion: later.assertion } });
    assert.equal(f.posts().length, 2);
  } finally { f.close(); }
});

test('a live cooldown spaces out live orders but leaves demo orders alone', async () => {
  const f = fixture({ config: { liveOrderCooldownSeconds: 60, demoConfirmWithoutPasskey: true } });
  try {
    await enroll(f);
    const first = await signedOrder(f, { env: 'live', quantity: 1 });
    await f.service.confirm({ origin: STUDIO, id: first.preview.id, proof: { assertion: first.assertion } });
    // A second live order within the cooldown is refused, at preview and (for a preview made earlier) at confirm.
    await assert.rejects(f.service.preview({ origin: STUDIO, order: order({ env: 'live' }) }), coded('T212_LIVE_COOLDOWN', /实盘冷却/));
    // Demo orders are not subject to the live cooldown.
    const demo = await f.service.preview({ origin: STUDIO, order: order({ env: 'demo' }) });
    assert.equal(demo.requires, 'passkey');
    f.advance(60_000 + 1);
    const third = await signedOrder(f, { env: 'live', quantity: 0.5 });
    await f.service.confirm({ origin: STUDIO, id: third.preview.id, proof: { assertion: third.assertion } });
    assert.equal(f.posts().filter(call => call.url.includes('live.trading212')).length, 2);
  } finally { f.close(); }
});

test('concurrent confirmations cannot exceed the hourly limit (the slot is reserved before any await)', async () => {
  const f = fixture({ config: { maxOrdersPerHour: 10 } });
  try {
    await enroll(f);
    // Build more signed orders than the limit, each with its own single-use challenge.
    const signed = [];
    for (let index = 0; index < 15; index += 1) signed.push(await signedOrder(f, { quantity: 1 }));
    // Confirm them all at once: each confirm reserves its slot synchronously before it awaits the signature
    // check, so the ones past the limit see the reservations and are refused instead of all placing.
    const results = await Promise.allSettled(signed.map(item => f.service.confirm({ origin: STUDIO, id: item.preview.id, proof: { assertion: item.assertion } })));
    const placed = results.filter(result => result.status === 'fulfilled');
    const refused = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(placed.length, 10, 'exactly the hourly limit is placed');
    assert.equal(f.posts().length, 10, 'no more orders reached Trading 212 than the limit');
    assert.ok(refused.every(result => (result.reason as { code?: string }).code === 'T212_HOURLY_LIMIT'));
    // The audit has ten placed rows and nothing left pending.
    const audit = f.audit();
    assert.equal(audit.filter(row => row.status === 'placed').length, 10);
    assert.equal(audit.filter(row => row.status === 'pending').length, 0);
  } finally { f.close(); }
});
