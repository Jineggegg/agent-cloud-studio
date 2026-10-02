import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import type { StudioT212OrderInput } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createTrading212Service } from '../trading212.service.js';
import { createTrading212OrdersService } from '../trading212-orders.service.js';

type WebAuthn = NonNullable<Parameters<typeof createTrading212OrdersService>[0]['webauthn']>;

const STUDIO = { origin: 'https://studio.ajarche.com', rpId: 'studio.ajarche.com' };
const TAILNET = { origin: 'https://desktop.tail1234.ts.net', rpId: 'desktop.tail1234.ts.net' };
const PASSWORD = 'correct horse battery staple';
const SUMMARY = {
  id: 1, currency: 'GBP', totalValue: 1620,
  cash: { availableToTrade: 1000, reservedForOrders: 0, inPies: 0 },
  investments: { currentValue: 620, totalCost: 560, realizedProfitLoss: 0, unrealizedProfitLoss: 60 },
};
// AAPL: 2 shares worth £320, so a one-share market order is estimated at £160.
const POSITIONS = [
  { instrument: { ticker: 'AAPL_US_EQ', name: 'Apple', currency: 'USD' }, quantity: 2, currentPrice: 200, averagePricePaid: 150, walletImpact: { currentValue: 320, totalCost: 260, unrealizedProfitLoss: 60 } },
];

// A fake authenticator that behaves like a real one where it matters: the assertion echoes the challenge it was
// asked to sign (as clientDataJSON does), and verification fails unless that equals the expected challenge.
function fakeWebAuthn() {
  const calls = { authentication: [] as any[], verifyAuthentication: [] as any[] };
  const credentials = ['cred-studio', 'cred-tailnet'];
  let counter = 0;
  const webauthn = {
    async generateRegistrationOptions(options: any) {
      return { challenge: `reg-${++counter}`, rp: { id: options.rpID, name: options.rpName } };
    },
    async verifyRegistrationResponse() {
      return { verified: true, registrationInfo: { credential: { id: credentials.shift(), publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] } } };
    },
    async generateAuthenticationOptions(options: any) {
      calls.authentication.push(options);
      const challenge = options.challenge instanceof Uint8Array ? Buffer.from(options.challenge).toString('base64url') : `auth-${++counter}`;
      return { challenge, rpId: options.rpID, allowCredentials: options.allowCredentials, userVerification: options.userVerification, timeout: options.timeout };
    },
    async verifyAuthenticationResponse(options: any) {
      calls.verifyAuthentication.push(options);
      if (options.response.response.signature !== 'good-signature') throw new Error('signature mismatch');
      if (options.response.response.clientDataJSON !== options.expectedChallenge) throw new Error('challenge mismatch');
      if (options.response.origin !== options.expectedOrigin || options.response.rpId !== options.expectedRPID) throw new Error('origin mismatch');
      if (!options.requireUserVerification) throw new Error('user verification must be required');
      return { verified: true, authenticationInfo: { credentialID: options.credential.id, newCounter: options.credential.counter + 1, userVerified: true } };
    },
  } as unknown as WebAuthn;
  return { webauthn, calls };
}

// What the browser returns after Face ID: an assertion by `credential` over the challenge in `options`, made on `origin`.
function signed(options: { challenge: string }, origin = STUDIO, credential = 'cred-studio', signature = 'good-signature') {
  return {
    id: credential, rawId: credential, type: 'public-key', clientExtensionResults: {},
    response: { signature, clientDataJSON: options.challenge }, origin: origin.origin, rpId: origin.rpId,
  } as any;
}

function fixture(options: { maxOrderValue?: string; maxDailyValue?: string; capCeiling?: string } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 't212-caps-test-'));
  const envFile = path.join(directory, 'live.env');
  writeFileSync(envFile, 'TRADING212_API_KEY=fake-live-key\nTRADING212_API_SECRET=fake-live-secret\n');
  const database = new Database(':memory:');
  let clock = Date.parse('2026-10-02T10:00:00Z');
  const brokerPosts: string[] = [];
  // Each order POST waits for this, so a test can hold confirmations in flight.
  let respondToOrder: () => Promise<Response> = async () => Response.json({ id: 1, status: 'NEW' });
  const trading212 = createTrading212Service({
    database, envFiles: { live: envFile, demo: envFile }, now: () => clock,
    request: (async (url: string, init: RequestInit) => {
      if (init.method === 'POST') { brokerPosts.push(String(init.body)); return respondToOrder(); }
      if (String(url).endsWith('/equity/account/summary')) return Response.json(SUMMARY);
      if (String(url).includes('/equity/positions')) return Response.json(POSITIONS);
      if (String(url).endsWith('/equity/metadata/instruments')) return Response.json([{ ticker: 'AAPL_US_EQ', currencyCode: 'USD' }]);
      return Response.json({ items: [], nextPagePath: null });
    }) as unknown as typeof fetch,
  });
  const { webauthn, calls } = fakeWebAuthn();
  const orders = createTrading212OrdersService({
    database, trading212, webauthn, now: () => clock, trading: 'both',
    maxOrderValue: options.maxOrderValue, maxDailyValue: options.maxDailyValue, capCeiling: options.capCeiling,
    origins: [STUDIO.origin, TAILNET.origin],
    // Stands in for the auth module's step-up, which owns every limit on passwords.
    async verifyStepUp(who, password) {
      if ((who.user as { id?: number }).id !== 1 || password !== PASSWORD) {
        throw new AppError('密码不正确', { code: 'AUTH_STEP_UP_FAILED', statusCode: 403 });
      }
    },
  });
  return {
    orders, database, calls, brokerPosts,
    advance: (ms: number) => { clock += ms; },
    onOrder: (respond: () => Promise<Response>) => { respondToOrder = respond; },
    caps: (env: 'live' | 'demo' = 'live') => orders.config(1).caps.envs[env],
    history: () => orders.config(1).capChanges,
    close: () => { database.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
type Fixture = ReturnType<typeof fixture>;

async function enablePasskey(f: Fixture, origin = STUDIO) {
  await f.orders.passkeyOptions(1, 'owner', origin, PASSWORD);
  return f.orders.registerPasskey(1, origin, { id: 'x', rawId: 'x', response: { attestationObject: 'x' } } as any);
}
async function raise(f: Fixture, values: { maxOrderValue: number; dailyLimit: number }, origin = STUDIO) {
  const challenge = await f.orders.capsChallenge(1, origin, { env: 'live', ...values });
  const credential = origin === TAILNET ? 'cred-tailnet' : 'cred-studio';
  return f.orders.updateCaps(1, origin, { env: 'live', ...values }, { challengeId: challenge.challengeId, assertion: signed(challenge.authentication, origin, credential) });
}
const order = (input: Partial<StudioT212OrderInput> = {}): StudioT212OrderInput => ({
  env: 'live', ticker: 'AAPL_US_EQ', side: 'buy', type: 'market', quantity: 1, timeValidity: 'DAY', ...input,
});
const coded = (code: string, pattern?: RegExp) => (error: Error & { code?: string }) => error.code === code && (!pattern || pattern.test(error.message));

test('caps default to the env values per account and never exceed the ceiling', () => {
  const plain = fixture();
  const custom = fixture({ maxOrderValue: '800', maxDailyValue: '1500', capCeiling: '1200' });
  const broken = fixture({ maxOrderValue: 'lots', capCeiling: '-1' });
  try {
    const config = plain.orders.config(1);
    assert.equal(config.caps.ceiling, 10_000);
    assert.deepEqual(config.caps.defaults, { maxOrderValue: 500, dailyLimit: 2000 });
    assert.equal(plain.caps('live').maxOrderValue, 500);
    assert.equal(plain.caps('demo').dailyLimit, 2000);
    assert.equal(plain.caps('live').custom, false);
    assert.equal(plain.caps('live').dailyRemaining, 2000);

    // The daily default is above the ceiling, so it is clamped to it.
    assert.deepEqual(custom.orders.config(1).caps.defaults, { maxOrderValue: 800, dailyLimit: 1200 });
    assert.equal(custom.orders.config(1).caps.ceiling, 1200);

    assert.equal(broken.orders.config(1).caps.ceiling, 10_000, 'an invalid ceiling falls back to the default');
    assert.deepEqual(broken.orders.config(1).caps.defaults, { maxOrderValue: 500, dailyLimit: 2000 });
  } finally { plain.close(); custom.close(); broken.close(); }
});

test('lowering needs only the session, is saved per account and audited; no-ops, the ceiling and order are refused', async () => {
  const f = fixture();
  try {
    // No passkey anywhere and no trusted origin: lowering still works.
    const lowered = await f.orders.updateCaps(1, null, { env: 'live', maxOrderValue: 200, dailyLimit: 600 });
    assert.equal(lowered.method, 'session');
    assert.equal(lowered.direction, 'lower');
    assert.equal(lowered.caps.maxOrderValue, 200);
    assert.equal(f.caps('live').custom, true);
    assert.equal(f.caps('demo').maxOrderValue, 500, 'caps are per account');
    const [entry] = f.history();
    assert.equal(entry.status, 'applied');
    assert.equal(entry.method, 'session');
    assert.equal(entry.origin, null);
    assert.deepEqual(entry.from, { maxOrderValue: 500, dailyLimit: 2000 });
    assert.deepEqual(entry.to, { maxOrderValue: 200, dailyLimit: 600 });

    await assert.rejects(f.orders.updateCaps(1, STUDIO, { env: 'live', maxOrderValue: 200, dailyLimit: 600 }), coded('T212_CAPS_UNCHANGED'));
    await assert.rejects(f.orders.updateCaps(1, STUDIO, { env: 'live', maxOrderValue: 200, dailyLimit: 10_001 }), coded('T212_CAP_CEILING', /10,000/));
    await assert.rejects(f.orders.updateCaps(1, STUDIO, { env: 'live', maxOrderValue: 150, dailyLimit: 100 }), coded('T212_CAPS_INVALID'));
    await assert.rejects(f.orders.capsChallenge(1, STUDIO, { env: 'live', maxOrderValue: 100, dailyLimit: 600 }), coded('T212_CAPS_NOT_RAISE'));
    assert.equal(f.history().length, 1, 'refused edits that consumed no challenge are not audited');

    // The lowered cap is what orders are checked against.
    await assert.rejects(f.orders.preview(1, STUDIO, order({ quantity: 1.5 })), coded('T212_ORDER_CAP', /£200\.00/));
  } finally { f.close(); }
});

test('without any passkey caps cannot be raised', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.orders.capsChallenge(1, STUDIO, { env: 'live', maxOrderValue: 800, dailyLimit: 2000 }), coded('T212_CAPS_PASSKEY_REQUIRED', /请先在「设置 → 交易安全」启用/));
    await assert.rejects(f.orders.updateCaps(1, STUDIO, { env: 'live', maxOrderValue: 800, dailyLimit: 2000 }), coded('T212_CAPS_PASSKEY_REQUIRED'));
    // A mixed change (one cap up, the other down) is a raise.
    await assert.rejects(f.orders.updateCaps(1, STUDIO, { env: 'live', maxOrderValue: 800, dailyLimit: 1000 }), coded('T212_CAPS_PASSKEY_REQUIRED'));
    assert.equal(f.caps().maxOrderValue, 500);
    assert.equal(f.calls.authentication.length, 0);
  } finally { f.close(); }
});

test('a raise is bound to its values, user and origin, verified against the stored passkey with user verification', async () => {
  const f = fixture();
  try {
    const passkey = await enablePasskey(f);
    const input = { env: 'live' as const, maxOrderValue: 800, dailyLimit: 3000 };
    const challenge = await f.orders.capsChallenge(1, STUDIO, input);
    const options = f.calls.authentication.at(-1);
    assert.equal(options.userVerification, 'required');
    assert.equal(options.rpID, STUDIO.rpId);
    assert.equal(options.timeout, 60_000);
    assert.deepEqual(options.allowCredentials.map((item: { id: string }) => item.id), ['cred-studio']);
    assert.equal(Date.parse(challenge.expiresAt) - Date.parse('2026-10-02T10:00:00Z'), 60_000);

    // Another user cannot redeem this user's challenge.
    await assert.rejects(f.orders.updateCaps(2, STUDIO, input, { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) }), coded('T212_CAPS_CHALLENGE_GONE'));

    const saved = await f.orders.updateCaps(1, STUDIO, input, { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) });
    assert.equal(saved.method, 'passkey');
    assert.equal(saved.direction, 'raise');
    assert.equal(saved.caps.maxOrderValue, 800);
    assert.equal(saved.caps.dailyLimit, 3000);
    const verify = f.calls.verifyAuthentication.at(-1);
    assert.equal(verify.requireUserVerification, true);
    assert.equal(verify.expectedOrigin, STUDIO.origin);
    assert.equal(verify.expectedRPID, STUDIO.rpId);
    const stored = f.database.prepare('SELECT counter, last_used_at FROM studio_t212_passkeys WHERE id = ?').get(passkey.id) as { counter: number; last_used_at: string };
    assert.equal(stored.counter, 1, 'the signature counter advanced');
    assert.ok(stored.last_used_at);
    const [entry] = f.history();
    assert.equal(entry.status, 'applied');
    assert.equal(entry.method, 'passkey');
    assert.equal(entry.origin, STUDIO.origin);

    // The raised cap now admits a £480 order.
    const preview = await f.orders.preview(1, STUDIO, order({ quantity: 3 }));
    assert.equal(preview.maxOrderValue, 800);
    assert.equal(preview.dailyLimit, 3000);
  } finally { f.close(); }
});

test('values changed after the challenge are refused and audited, and the challenge is spent', async () => {
  const f = fixture();
  try {
    await enablePasskey(f);
    const challenge = await f.orders.capsChallenge(1, STUDIO, { env: 'live', maxOrderValue: 800, dailyLimit: 2000 });
    const assertion = signed(challenge.authentication);
    for (const tampered of [{ maxOrderValue: 5000, dailyLimit: 6000 }, { maxOrderValue: 800, dailyLimit: 2000.01 }]) {
      const fresh = await f.orders.capsChallenge(1, STUDIO, { env: 'live', maxOrderValue: 800, dailyLimit: 2000 });
      await assert.rejects(f.orders.updateCaps(1, STUDIO, { env: 'live', ...tampered }, { challengeId: fresh.challengeId, assertion: signed(fresh.authentication) }), coded('T212_CAPS_TAMPERED'));
    }
    // Another account than the one Face ID approved.
    await assert.rejects(f.orders.updateCaps(1, STUDIO, { env: 'demo', maxOrderValue: 800, dailyLimit: 2000 }, { challengeId: challenge.challengeId, assertion }), coded('T212_CAPS_TAMPERED'));
    // The challenge was consumed by the refused attempt, so the honest values cannot reuse it either.
    await assert.rejects(f.orders.updateCaps(1, STUDIO, { env: 'live', maxOrderValue: 800, dailyLimit: 2000 }, { challengeId: challenge.challengeId, assertion }), coded('T212_CAPS_CHALLENGE_GONE'));
    assert.equal(f.caps('live').maxOrderValue, 500);
    assert.equal(f.caps('demo').maxOrderValue, 500);
    const refused = f.history().filter(item => item.status === 'refused');
    assert.equal(refused.length, 3);
    assert.ok(refused.every(item => item.reason?.includes('不一致')));
    assert.equal(f.calls.verifyAuthentication.length, 0, 'tampered values never reach signature verification');
  } finally { f.close(); }
});

test('a challenge cannot be replayed, expires after 60 seconds and needs a valid signature', async () => {
  const f = fixture();
  try {
    await enablePasskey(f);
    const input = { env: 'live' as const, maxOrderValue: 700, dailyLimit: 2000 };
    const challenge = await f.orders.capsChallenge(1, STUDIO, input);
    const proof = { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) };
    await f.orders.updateCaps(1, STUDIO, input, proof);
    // Replaying the same proof, even after lowering again, is refused.
    await f.orders.updateCaps(1, STUDIO, { env: 'live', maxOrderValue: 500, dailyLimit: 2000 });
    await assert.rejects(f.orders.updateCaps(1, STUDIO, input, proof), coded('T212_CAPS_CHALLENGE_GONE'));
    assert.equal(f.caps().maxOrderValue, 500);

    const late = await f.orders.capsChallenge(1, STUDIO, input);
    f.advance(60_001);
    await assert.rejects(f.orders.updateCaps(1, STUDIO, input, { challengeId: late.challengeId, assertion: signed(late.authentication) }), coded('T212_CAPS_CHALLENGE_EXPIRED'));

    const forged = await f.orders.capsChallenge(1, STUDIO, input);
    await assert.rejects(f.orders.updateCaps(1, STUDIO, input, { challengeId: forged.challengeId, assertion: signed(forged.authentication, STUDIO, 'cred-studio', 'forged') }), coded('T212_CAPS_PASSKEY_FAILED'));
    // A signature over another challenge (for example a stolen order assertion) does not fit this one.
    const other = await f.orders.capsChallenge(1, STUDIO, input);
    await assert.rejects(f.orders.updateCaps(1, STUDIO, input, { challengeId: other.challengeId, assertion: signed({ challenge: 'auth-1' }) }), coded('T212_CAPS_PASSKEY_FAILED'));
    assert.equal(f.caps().maxOrderValue, 500);
    assert.deepEqual(f.history().slice(0, 3).map(item => item.status), ['refused', 'refused', 'refused']);
  } finally { f.close(); }
});

test('a raise needs a passkey of the request’s own domain, finished on the same origin', async () => {
  const f = fixture();
  try {
    await enablePasskey(f, STUDIO);
    const input = { env: 'live' as const, maxOrderValue: 900, dailyLimit: 2000 };
    // Face ID exists only on studio.ajarche.com; the Tailscale domain cannot raise.
    await assert.rejects(f.orders.capsChallenge(1, TAILNET, input), coded('T212_CAPS_PASSKEY_REQUIRED', /studio\.ajarche\.com/));
    // A challenge issued on one origin cannot be finished on another, nor from an untrusted page.
    const challenge = await f.orders.capsChallenge(1, STUDIO, input);
    await assert.rejects(f.orders.updateCaps(1, null, input, { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) }), coded('T212_UNTRUSTED_ORIGIN'));
    const again = await f.orders.capsChallenge(1, STUDIO, input);
    await assert.rejects(f.orders.updateCaps(1, TAILNET, input, { challengeId: again.challengeId, assertion: signed(again.authentication, TAILNET) }), coded('T212_CAPS_WRONG_ORIGIN'));

    // With passkeys on both domains, the studio credential still cannot approve a raise on the Tailscale domain.
    await enablePasskey(f, TAILNET);
    const tailnet = await f.orders.capsChallenge(1, TAILNET, input);
    assert.deepEqual(f.calls.authentication.at(-1).allowCredentials.map((item: { id: string }) => item.id), ['cred-tailnet']);
    await assert.rejects(f.orders.updateCaps(1, TAILNET, input, { challengeId: tailnet.challengeId, assertion: signed(tailnet.authentication, STUDIO, 'cred-studio') }), coded('T212_CAPS_PASSKEY_FAILED'));
    assert.equal(f.caps().maxOrderValue, 500);
    const saved = await raise(f, input, TAILNET);
    assert.equal(saved.caps.maxOrderValue, 900);
  } finally { f.close(); }
});

test('the ceiling cannot be exceeded even with Face ID', async () => {
  const f = fixture({ capCeiling: '1000' });
  try {
    await enablePasskey(f);
    await assert.rejects(f.orders.capsChallenge(1, STUDIO, { env: 'live', maxOrderValue: 500, dailyLimit: 1000.5 }), coded('T212_CAP_CEILING'));
    const saved = await raise(f, { maxOrderValue: 1000, dailyLimit: 1000 });
    assert.equal(saved.caps.dailyLimit, 1000);
  } finally { f.close(); }
  // A ceiling lowered later caps values saved under the old one.
  const later = fixture({ capCeiling: '300' });
  try {
    later.database.exec("INSERT INTO studio_t212_caps VALUES (1, 'live', 900, 5000, '2026-10-01T00:00:00Z')");
    assert.equal(later.caps().maxOrderValue, 300);
    assert.equal(later.caps().dailyLimit, 300);
  } finally { later.close(); }
});

test('the rolling daily cap counts placed and unknown orders and holds against parallel confirmations', async () => {
  const f = fixture();
  try {
    // Daily £300: one £160 order fits, two do not.
    await f.orders.updateCaps(1, STUDIO, { env: 'live', maxOrderValue: 200, dailyLimit: 300 });
    const first = await f.orders.preview(1, STUDIO, order());
    const second = await f.orders.preview(1, STUDIO, order());
    assert.equal(first.dailyRemaining, 300);

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.onOrder(async () => { await gate; return Response.json({ id: 7, status: 'NEW' }); });
    // Settled together straight away, so the early refusal of the second is observed rather than left unhandled.
    const confirmations = Promise.allSettled([
      f.orders.confirm(1, STUDIO, first.id, { confirmed: true }),
      f.orders.confirm(1, STUDIO, second.id, { confirmed: true }),
    ]);
    // While the first waits for the broker, its value is reserved.
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.caps().dailyUsed, 160);
    assert.equal(f.brokerPosts.length, 1);
    release();
    const outcomes = await confirmations;
    assert.deepEqual(outcomes.map(item => item.status), ['fulfilled', 'rejected']);
    assert.equal((outcomes[1] as PromiseRejectedResult).reason.code, 'T212_DAILY_CAP');
    assert.match((outcomes[1] as PromiseRejectedResult).reason.message, /还剩 £140\.00/);
    assert.equal(f.brokerPosts.length, 1, 'only one order reached the broker');
    assert.equal(f.caps().dailyUsed, 160);
    assert.equal(f.caps().dailyRemaining, 140);

    // A new preview over the remaining allowance is refused up front.
    await assert.rejects(f.orders.preview(1, STUDIO, order()), coded('T212_DAILY_CAP'));
    // A broker refusal frees its reservation; an unknown outcome counts.
    await f.orders.updateCaps(1, STUDIO, { env: 'live', maxOrderValue: 200, dailyLimit: 299 });
    f.onOrder(async () => new Response('{"code":"InsufficientFunds"}', { status: 400 }));
    f.advance(24 * 60 * 60_000);
    assert.equal(f.caps().dailyUsed, 0, 'the window rolls after 24 hours');
    const refused = await f.orders.preview(1, STUDIO, order());
    await assert.rejects(f.orders.confirm(1, STUDIO, refused.id, { confirmed: true }));
    assert.equal(f.caps().dailyUsed, 0);
    f.onOrder(async () => new Response('', { status: 504 }));
    const unknown = await f.orders.preview(1, STUDIO, order());
    await assert.rejects(f.orders.confirm(1, STUDIO, unknown.id, { confirmed: true }), coded('T212_ORDER_UNKNOWN'));
    assert.equal(f.caps().dailyUsed, 160);
    assert.equal(f.caps('demo').dailyUsed, 0, 'the daily cap is per account');
  } finally { f.close(); }
});

test('the service itself refuses non-finite, non-positive and sub-penny caps, and audits them once a challenge is spent', async () => {
  const f = fixture();
  try {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5, 100.005]) {
      await assert.rejects(f.orders.updateCaps(1, STUDIO, { env: 'live', maxOrderValue: bad, dailyLimit: 600 }), coded('T212_CAPS_INVALID'), String(bad));
      await assert.rejects(f.orders.updateCaps(1, STUDIO, { env: 'live', maxOrderValue: 100, dailyLimit: bad }), coded('T212_CAPS_INVALID'), String(bad));
    }
    assert.equal(f.history().length, 0);
    assert.equal(f.caps().custom, false);

    await enablePasskey(f);
    const challenge = await f.orders.capsChallenge(1, STUDIO, { env: 'live', maxOrderValue: 800, dailyLimit: 2000 });
    const proof = { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) };
    await assert.rejects(f.orders.updateCaps(1, STUDIO, { env: 'live', maxOrderValue: 800, dailyLimit: 20_000 }, proof), coded('T212_CAP_CEILING'));
    // The refused attempt spent the challenge, so the approved values cannot follow with it.
    await assert.rejects(f.orders.updateCaps(1, STUDIO, { env: 'live', maxOrderValue: 800, dailyLimit: 2000 }, proof), coded('T212_CAPS_CHALLENGE_GONE'));
    const [entry] = f.history();
    assert.equal(entry.status, 'refused');
    assert.match(entry.reason ?? '', /STUDIO_T212_CAP_CEILING/);
    assert.equal(f.caps().maxOrderValue, 500);
  } finally { f.close(); }
});

test('two parallel submissions of one challenge save at most once', async () => {
  const f = fixture();
  try {
    await enablePasskey(f);
    const input = { env: 'live' as const, maxOrderValue: 900, dailyLimit: 3000 };
    const challenge = await f.orders.capsChallenge(1, STUDIO, input);
    const proof = { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) };
    const outcomes = await Promise.allSettled([f.orders.updateCaps(1, STUDIO, input, proof), f.orders.updateCaps(1, STUDIO, input, proof)]);
    assert.deepEqual(outcomes.map(item => item.status).sort(), ['fulfilled', 'rejected']);
    const refused = outcomes.find((item): item is PromiseRejectedResult => item.status === 'rejected');
    assert.equal(refused?.reason.code, 'T212_CAPS_CHALLENGE_GONE');
    assert.equal(f.calls.verifyAuthentication.length, 1, 'only one attempt reached signature verification');
    assert.equal(f.history().filter(item => item.status === 'applied').length, 1);
  } finally { f.close(); }
});

test('parallel Face ID confirmations reserve after their own verification and cannot exceed the daily cap', async () => {
  const f = fixture();
  try {
    await enablePasskey(f);
    await f.orders.updateCaps(1, STUDIO, { env: 'live', maxOrderValue: 200, dailyLimit: 400 });
    const previews = [await f.orders.preview(1, STUDIO, order()), await f.orders.preview(1, STUDIO, order()), await f.orders.preview(1, STUDIO, order())];
    assert.ok(previews.every(item => item.requires === 'passkey' && item.dailyRemaining === 400));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.onOrder(async () => { await gate; return Response.json({ id: 8, status: 'NEW' }); });
    const confirmations = Promise.allSettled(previews.map(item => f.orders.confirm(1, STUDIO, item.id, { assertion: signed(item.authentication!) })));
    await new Promise(resolve => setTimeout(resolve, 20));
    release();
    const outcomes = await confirmations;
    // £160 each against £400: two fit, the third is refused before reaching the broker.
    assert.deepEqual(outcomes.map(item => item.status), ['fulfilled', 'fulfilled', 'rejected']);
    assert.equal((outcomes[2] as PromiseRejectedResult).reason.code, 'T212_DAILY_CAP');
    assert.equal(f.brokerPosts.length, 2);
    assert.equal(f.caps().dailyUsed, 320);
    assert.equal(f.caps().dailyRemaining, 80);
  } finally { f.close(); }
});

test('caps lowered between preview and confirmation stop the order', async () => {
  const f = fixture();
  try {
    const preview = await f.orders.preview(1, STUDIO, order());
    await f.orders.updateCaps(1, STUDIO, { env: 'live', maxOrderValue: 100, dailyLimit: 1000 });
    await assert.rejects(f.orders.confirm(1, STUDIO, preview.id, { confirmed: true }), coded('T212_ORDER_CAP', /单笔上限已改为 £100\.00/));
    const next = await f.orders.preview(1, STUDIO, order({ type: 'limit', quantity: 0.5, limitPrice: 200 }));
    await f.orders.updateCaps(1, STUDIO, { env: 'live', maxOrderValue: 50, dailyLimit: 60 });
    await assert.rejects(f.orders.confirm(1, STUDIO, next.id, { confirmed: true }), coded('T212_ORDER_CAP'));
    assert.equal(f.brokerPosts.length, 0);
  } finally { f.close(); }
});
