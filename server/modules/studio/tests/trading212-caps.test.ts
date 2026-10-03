import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import type { StudioT212CapsInput, StudioT212OrderInput } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createTrading212Service } from '../trading212.service.js';
import { createTrading212OrdersService } from '../trading212-orders.service.js';

type WebAuthn = NonNullable<Parameters<typeof createTrading212OrdersService>[0]['webauthn']>;
type Origin = { origin: string; rpId: string };

const STUDIO = { origin: 'https://studio.ajarche.com', rpId: 'studio.ajarche.com' };
const TAILNET = { origin: 'https://desktop.tail1234.ts.net', rpId: 'desktop.tail1234.ts.net' };
// Two sessions of the same user: the owner's iPad and a stolen token used from elsewhere.
const OWNER = { sessionId: 'owner-session-1', clientKey: 'tailnet 100.64.1.2', client: 'Tailscale 100.64.*.*' };
const THIEF = { sessionId: 'thief-session-2', clientKey: 'cloudflare 203.0.113.9', client: '公网 203.0.*.*' };
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
  // A second call is what a restarted Studio does: a fresh service on the same database.
  const start = () => createTrading212OrdersService({
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
  const orders = start();
  return {
    orders, database, webauthn, calls, brokerPosts, restart: start,
    advance: (ms: number) => { clock += ms; },
    onOrder: (respond: () => Promise<Response>) => { respondToOrder = respond; },
    caps: (env: 'live' | 'demo' = 'live') => orders.config(1).caps.envs[env],
    history: () => orders.config(1).capChanges,
    refusals: () => orders.config(1).capRefusals,
    issued: () => (database.prepare("SELECT COUNT(*) AS count FROM studio_t212_cap_changes WHERE status = 'issued'").get() as { count: number }).count,
    orderStatuses: () => (database.prepare('SELECT status FROM studio_t212_orders ORDER BY row_id').all() as { status: string }[]).map(row => row.status),
    close: () => { database.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
type Fixture = ReturnType<typeof fixture>;

async function enablePasskey(f: Fixture, origin = STUDIO) {
  await f.orders.passkeyOptions(1, 'owner', origin, PASSWORD);
  return f.orders.registerPasskey(1, origin, { id: 'x', rawId: 'x', response: { attestationObject: 'x' } } as any);
}
// PUT /caps as the router hands it over: the caps, plus the challenge id and assertion for a raise.
function update(f: Fixture, origin: Origin | null, input: StudioT212CapsInput, proof?: { challengeId: string; assertion: unknown }, userId = 1) {
  return f.orders.updateCaps(userId, origin, proof ? { challengeId: proof.challengeId, input, assertion: proof.assertion as any } : { input });
}
async function raise(f: Fixture, values: { maxOrderValue: number; dailyLimit: number }, origin = STUDIO) {
  const challenge = await f.orders.capsChallenge(1, origin, { env: 'live', ...values });
  const credential = origin === TAILNET ? 'cred-tailnet' : 'cred-studio';
  return update(f, origin, { env: 'live', ...values }, { challengeId: challenge.challengeId, assertion: signed(challenge.authentication, origin, credential) });
}
const order = (input: Partial<StudioT212OrderInput> = {}): StudioT212OrderInput => ({
  env: 'live', ticker: 'AAPL_US_EQ', side: 'buy', type: 'market', quantity: 1, timeValidity: 'DAY', ...input,
});
const coded = (code: string, pattern?: RegExp) => (error: Error & { code?: string }) => error.code === code && (!pattern || pattern.test(error.message));
const live = (maxOrderValue: number, dailyLimit: number): StudioT212CapsInput => ({ env: 'live', maxOrderValue, dailyLimit });

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
    const lowered = await update(f, null, live(200, 600));
    assert.equal(lowered.method, 'session');
    assert.equal(lowered.direction, 'lower');
    assert.equal(lowered.env, 'live');
    assert.equal(lowered.caps.maxOrderValue, 200);
    assert.equal(f.caps('live').custom, true);
    assert.equal(f.caps('demo').maxOrderValue, 500, 'caps are per account');
    const [entry] = f.history();
    assert.equal(entry.status, 'applied');
    assert.equal(entry.method, 'session');
    assert.equal(entry.origin, null);
    assert.deepEqual(entry.from, { maxOrderValue: 500, dailyLimit: 2000 });
    assert.deepEqual(entry.to, { maxOrderValue: 200, dailyLimit: 600 });

    await assert.rejects(update(f, STUDIO, live(200, 600)), coded('T212_CAPS_UNCHANGED'));
    await assert.rejects(update(f, STUDIO, live(150, 100)), coded('T212_CAPS_INVALID'));
    await assert.rejects(f.orders.capsChallenge(1, STUDIO, live(100, 600)), coded('T212_CAPS_NOT_RAISE'));
    assert.equal(f.refusals().length, 0, 'invalid lowerings and no-ops are not raise attempts');
    // Above the ceiling is an attempted raise: refused and audited.
    await assert.rejects(update(f, STUDIO, live(200, 10_001)), coded('T212_CAP_CEILING', /10,000/));
    assert.equal(f.history().length, 1);
    assert.equal(f.refusals().length, 1);

    // The lowered cap is what orders are checked against.
    await assert.rejects(f.orders.preview(1, STUDIO, order({ quantity: 1.5 })), coded('T212_ORDER_CAP', /£200\.00/));
  } finally { f.close(); }
});

test('without any passkey caps cannot be raised, and the attempts are audited', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.orders.capsChallenge(1, STUDIO, live(800, 2000)), coded('T212_CAPS_PASSKEY_REQUIRED', /请先在「设置 → 交易安全」启用/));
    await assert.rejects(update(f, STUDIO, live(800, 2000)), coded('T212_CAPS_PASSKEY_REQUIRED'));
    // A mixed change (one cap up, the other down) is a raise.
    await assert.rejects(update(f, STUDIO, live(800, 1000)), coded('T212_CAPS_PASSKEY_REQUIRED'));
    assert.equal(f.caps().maxOrderValue, 500);
    assert.equal(f.calls.authentication.length, 0);
    assert.equal(f.issued(), 0);
    const refusals = f.refusals();
    assert.deepEqual(refusals.map(item => [item.method, item.direction, item.status]), [['session', 'raise', 'refused'], ['session', 'raise', 'refused']]);
    assert.deepEqual(refusals[0].to, { maxOrderValue: 800, dailyLimit: 1000 });
  } finally { f.close(); }
});

test('a raise is bound to its values, user and origin, verified against the stored passkey with user verification', async () => {
  const f = fixture();
  try {
    const passkey = await enablePasskey(f);
    const input = live(800, 3000);
    const challenge = await f.orders.capsChallenge(1, STUDIO, input);
    const options = f.calls.authentication.at(-1);
    assert.equal(options.userVerification, 'required');
    assert.equal(options.rpID, STUDIO.rpId);
    assert.equal(options.timeout, 60_000);
    assert.deepEqual(options.allowCredentials.map((item: { id: string }) => item.id), ['cred-studio']);
    assert.equal(Date.parse(challenge.expiresAt) - Date.parse('2026-10-02T10:00:00Z'), 60_000);
    assert.equal(f.issued(), 1, 'issuing the challenge is audited');

    // Another user cannot redeem this user's challenge, nor burn it.
    await assert.rejects(update(f, STUDIO, input, { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) }, 2), coded('T212_CAPS_CHALLENGE_GONE'));

    const saved = await update(f, STUDIO, input, { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) });
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
    const challenge = await f.orders.capsChallenge(1, STUDIO, live(800, 2000));
    const assertion = signed(challenge.authentication);
    for (const tampered of [live(5000, 6000), live(800, 2000.01)]) {
      const fresh = await f.orders.capsChallenge(1, STUDIO, live(800, 2000));
      await assert.rejects(update(f, STUDIO, tampered, { challengeId: fresh.challengeId, assertion: signed(fresh.authentication) }), coded('T212_CAPS_TAMPERED'));
    }
    // Another account than the one Face ID approved.
    await assert.rejects(update(f, STUDIO, { env: 'demo', maxOrderValue: 800, dailyLimit: 2000 }, { challengeId: challenge.challengeId, assertion }), coded('T212_CAPS_TAMPERED'));
    // The challenge was consumed by the refused attempt, so the honest values cannot reuse it either.
    await assert.rejects(update(f, STUDIO, live(800, 2000), { challengeId: challenge.challengeId, assertion }), coded('T212_CAPS_CHALLENGE_GONE'));
    assert.equal(f.caps('live').maxOrderValue, 500);
    assert.equal(f.caps('demo').maxOrderValue, 500);
    const refused = f.refusals();
    assert.equal(refused.length, 4);
    assert.ok(refused.slice(1).every(item => item.reason?.includes('不一致')));
    assert.match(refused[0].reason ?? '', /已经用过/);
    assert.equal(f.calls.verifyAuthentication.length, 0, 'tampered values never reach signature verification');
  } finally { f.close(); }
});

test('a malformed raise that names a challenge burns it and is audited; challenge issuance is audited too', async () => {
  const f = fixture();
  try {
    await enablePasskey(f);
    const challenge = await f.orders.capsChallenge(1, STUDIO, live(800, 2000));
    // What the router hands over when the rest of the body did not parse.
    await assert.rejects(f.orders.updateCaps(1, STUDIO, { challengeId: challenge.challengeId, invalid: '上限必须是大于 0 的数字，最多 2 位小数' }), coded('T212_CAPS_INVALID'));
    // Gone, even for the approved values with a valid signature.
    await assert.rejects(update(f, STUDIO, live(800, 2000), { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) }), coded('T212_CAPS_CHALLENGE_GONE'));
    assert.equal(f.calls.verifyAuthentication.length, 0);
    const [gone, malformed] = f.refusals();
    assert.match(gone.reason ?? '', /已经用过/);
    // The malformed attempt is recorded with the values its challenge was issued for.
    assert.equal(malformed.env, 'live');
    assert.equal(malformed.method, 'passkey');
    assert.deepEqual(malformed.from, { maxOrderValue: 500, dailyLimit: 2000 });
    assert.deepEqual(malformed.to, { maxOrderValue: 800, dailyLimit: 2000 });

    // A malformed raise naming no challenge of this user is audited without values; a malformed lowering is not.
    await assert.rejects(f.orders.updateCaps(1, STUDIO, { challengeId: '', invalid: '面容 ID 验证编号无效，请重新提交' }), coded('T212_CAPS_INVALID'));
    const [unknown] = f.refusals();
    assert.equal(unknown.env, null);
    assert.equal(unknown.to, null);
    await assert.rejects(f.orders.updateCaps(1, STUDIO, { invalid: '账户必须为 live 或 demo' }), coded('T212_CAPS_INVALID'));
    assert.equal(f.refusals().length, 3);
    assert.equal(f.issued(), 1);
    assert.equal(f.caps().maxOrderValue, 500);
  } finally { f.close(); }
});

test('a challenge cannot be replayed, expires after 60 seconds and needs a valid signature', async () => {
  const f = fixture();
  try {
    await enablePasskey(f);
    const input = live(700, 2000);
    const challenge = await f.orders.capsChallenge(1, STUDIO, input);
    const proof = { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) };
    await update(f, STUDIO, input, proof);
    // Replaying the same proof, even after lowering again, is refused.
    await update(f, STUDIO, live(500, 2000));
    await assert.rejects(update(f, STUDIO, input, proof), coded('T212_CAPS_CHALLENGE_GONE'));
    assert.equal(f.caps().maxOrderValue, 500);

    const late = await f.orders.capsChallenge(1, STUDIO, input);
    f.advance(60_001);
    await assert.rejects(update(f, STUDIO, input, { challengeId: late.challengeId, assertion: signed(late.authentication) }), coded('T212_CAPS_CHALLENGE_EXPIRED'));

    const forged = await f.orders.capsChallenge(1, STUDIO, input);
    await assert.rejects(update(f, STUDIO, input, { challengeId: forged.challengeId, assertion: signed(forged.authentication, STUDIO, 'cred-studio', 'forged') }), coded('T212_CAPS_PASSKEY_FAILED'));
    // A signature over another challenge (for example a stolen order assertion) does not fit this one.
    const other = await f.orders.capsChallenge(1, STUDIO, input);
    await assert.rejects(update(f, STUDIO, input, { challengeId: other.challengeId, assertion: signed({ challenge: 'auth-1' }) }), coded('T212_CAPS_PASSKEY_FAILED'));
    assert.equal(f.caps().maxOrderValue, 500);
    assert.equal(f.refusals().length, 4);
    assert.deepEqual(f.history().map(item => item.direction), ['lower', 'raise']);
  } finally { f.close(); }
});

test('a raise needs a passkey of the request’s own domain, finished on the same origin', async () => {
  const f = fixture();
  try {
    await enablePasskey(f, STUDIO);
    const input = live(900, 2000);
    // Face ID exists only on studio.ajarche.com; the Tailscale domain cannot raise.
    await assert.rejects(f.orders.capsChallenge(1, TAILNET, input), coded('T212_CAPS_PASSKEY_REQUIRED', /studio\.ajarche\.com/));
    // A challenge issued on one origin cannot be finished on another, nor from an untrusted page.
    const challenge = await f.orders.capsChallenge(1, STUDIO, input);
    await assert.rejects(update(f, null, input, { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) }), coded('T212_UNTRUSTED_ORIGIN'));
    const again = await f.orders.capsChallenge(1, STUDIO, input);
    await assert.rejects(update(f, TAILNET, input, { challengeId: again.challengeId, assertion: signed(again.authentication, TAILNET) }), coded('T212_CAPS_WRONG_ORIGIN'));

    // With passkeys on both domains, the studio credential still cannot approve a raise on the Tailscale domain.
    await enablePasskey(f, TAILNET);
    const tailnet = await f.orders.capsChallenge(1, TAILNET, input);
    assert.deepEqual(f.calls.authentication.at(-1).allowCredentials.map((item: { id: string }) => item.id), ['cred-tailnet']);
    await assert.rejects(update(f, TAILNET, input, { challengeId: tailnet.challengeId, assertion: signed(tailnet.authentication, STUDIO, 'cred-studio') }), coded('T212_CAPS_PASSKEY_FAILED'));
    assert.equal(f.caps().maxOrderValue, 500);
    const saved = await raise(f, input, TAILNET);
    assert.equal(saved.caps.maxOrderValue, 900);
  } finally { f.close(); }
});

test('the ceiling cannot be exceeded even with Face ID', async () => {
  const f = fixture({ capCeiling: '1000' });
  try {
    await enablePasskey(f);
    await assert.rejects(f.orders.capsChallenge(1, STUDIO, live(500, 1000.5)), coded('T212_CAP_CEILING'));
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

test('the service itself refuses non-finite, non-positive and sub-penny caps, and audits them once a challenge is spent', async () => {
  const f = fixture();
  try {
    for (const bad of [Number.NaN, 0, -5, 100.005]) {
      await assert.rejects(update(f, STUDIO, live(bad, 600)), coded('T212_CAPS_INVALID'), String(bad));
      await assert.rejects(update(f, STUDIO, live(100, bad)), coded('T212_CAPS_INVALID'), String(bad));
    }
    await assert.rejects(update(f, STUDIO, live(Number.POSITIVE_INFINITY, 600)), coded('T212_CAPS_INVALID'));
    assert.equal(f.history().length, 0);
    assert.equal(f.caps().custom, false);

    await enablePasskey(f);
    const challenge = await f.orders.capsChallenge(1, STUDIO, live(800, 2000));
    const proof = { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) };
    await assert.rejects(update(f, STUDIO, live(800, 20_000), proof), coded('T212_CAP_CEILING'));
    // The refused attempt spent the challenge, so the approved values cannot follow with it.
    await assert.rejects(update(f, STUDIO, live(800, 2000), proof), coded('T212_CAPS_CHALLENGE_GONE'));
    const ceilingRefusal = f.refusals().find(item => item.reason?.includes('STUDIO_T212_CAP_CEILING') && item.method === 'passkey');
    assert.ok(ceilingRefusal);
    assert.equal(f.caps().maxOrderValue, 500);
  } finally { f.close(); }
});

test('two parallel submissions of one challenge save at most once', async () => {
  const f = fixture();
  try {
    await enablePasskey(f);
    const input = live(900, 3000);
    const challenge = await f.orders.capsChallenge(1, STUDIO, input);
    const proof = { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) };
    const outcomes = await Promise.allSettled([update(f, STUDIO, input, proof), update(f, STUDIO, input, proof)]);
    assert.deepEqual(outcomes.map(item => item.status).sort(), ['fulfilled', 'rejected']);
    const refused = outcomes.find((item): item is PromiseRejectedResult => item.status === 'rejected');
    assert.equal(refused?.reason.code, 'T212_CAPS_CHALLENGE_GONE');
    assert.equal(f.calls.verifyAuthentication.length, 1, 'only one attempt reached signature verification');
    assert.equal(f.history().length, 1);
  } finally { f.close(); }
});

test('caps and their audit row are saved together or not at all', async () => {
  const f = fixture();
  try {
    f.database.exec(`CREATE TRIGGER audit_down BEFORE INSERT ON studio_t212_cap_changes WHEN NEW.status = 'applied'
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    await assert.rejects(update(f, STUDIO, live(200, 600)), /audit unavailable/);
    assert.equal(f.caps().custom, false);
    assert.equal(f.caps().maxOrderValue, 500);
    f.database.exec('DROP TRIGGER audit_down');
    await update(f, STUDIO, live(200, 600));
    assert.equal(f.caps().maxOrderValue, 200);
    assert.equal(f.history().length, 1);
  } finally { f.close(); }
});

test('challenges and refused raises are limited per session and hour with a Retry-After; expired ones never count', async () => {
  const f = fixture();
  const limited = (seconds: number, pattern?: RegExp) => (error: Error & { code?: string; statusCode?: number; details?: { retryAfterSeconds?: number } }) =>
    error.code === 'T212_CAPS_RATE_LIMITED' && error.statusCode === 429 && error.details?.retryAfterSeconds === seconds && (!pattern || pattern.test(error.message));
  try {
    await enablePasskey(f);
    const input = live(800, 2000);
    // Ten at once: five stay open and five are replaced by newer ones of the same session; all ten count.
    for (let index = 0; index < 10; index += 1) await f.orders.capsChallenge(1, STUDIO, input);
    await assert.rejects(f.orders.capsChallenge(1, STUDIO, input), limited(3600, /发起提高上限的次数过多/));
    assert.equal(f.issued(), 10, 'refused issuance adds no row');
    // Once the open ones expire they stop counting, so a review left to time out costs nothing.
    f.advance(61_000);
    for (let index = 0; index < 5; index += 1) await f.orders.capsChallenge(1, STUDIO, input);
    await assert.rejects(f.orders.capsChallenge(1, STUDIO, input), coded('T212_CAPS_RATE_LIMITED'));
    f.advance(60 * 60_000);

    // Refused raises: ten are audited, the next gets a 429 and no row, yet challenges are still issued.
    for (let index = 0; index < 10; index += 1) await assert.rejects(update(f, STUDIO, input), coded('T212_CAPS_PASSKEY_REQUIRED'));
    await assert.rejects(update(f, STUDIO, input), limited(3600, /被拒绝的次数过多/));
    assert.equal(f.refusals().length, 10);
    const challenge = await f.orders.capsChallenge(1, STUDIO, input);
    const saved = await update(f, STUDIO, input, { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) });
    assert.equal(saved.method, 'passkey');
    const lowered = await update(f, STUDIO, live(400, 2000));
    assert.equal(lowered.method, 'session');
    assert.deepEqual(f.history()[0].to, { maxOrderValue: 400, dailyLimit: 2000 });
  } finally { f.close(); }
});

test('only real Face ID failures gate new raise challenges', async () => {
  const f = fixture();
  try {
    await enablePasskey(f);
    const input = live(800, 2000);
    for (let index = 0; index < 5; index += 1) {
      const challenge = await f.orders.capsChallenge(1, STUDIO, input);
      await assert.rejects(update(f, STUDIO, input, { challengeId: challenge.challengeId, assertion: signed(challenge.authentication, STUDIO, 'cred-studio', 'forged') }), coded('T212_CAPS_PASSKEY_FAILED'));
      const next = await f.orders.capsChallenge(1, STUDIO, input);
      await assert.rejects(update(f, STUDIO, live(5000, 6000), { challengeId: next.challengeId, assertion: signed(next.authentication) }), coded('T212_CAPS_TAMPERED'));
      f.advance(61_000);
    }
    await assert.rejects(f.orders.capsChallenge(1, STUDIO, input), coded('T212_CAPS_RATE_LIMITED', /验证失败的次数过多/));
    assert.equal(f.caps().maxOrderValue, 500);
  } finally { f.close(); }
});

test('a stolen session cannot lock the owner out of raising caps, evict or burn the owner’s challenge', async () => {
  const f = fixture();
  try {
    await enablePasskey(f);
    const input = live(800, 2000);
    const owner = await f.orders.capsChallenge(1, STUDIO, input, OWNER);
    // The thief burns its own budgets: refusals, open challenges and replacements.
    for (let index = 0; index < 10; index += 1) await assert.rejects(f.orders.updateCaps(1, STUDIO, { input }, THIEF), coded('T212_CAPS_PASSKEY_REQUIRED'));
    await assert.rejects(f.orders.updateCaps(1, STUDIO, { input }, THIEF), coded('T212_CAPS_RATE_LIMITED'));
    for (let index = 0; index < 10; index += 1) await f.orders.capsChallenge(1, STUDIO, input, THIEF);
    await assert.rejects(f.orders.capsChallenge(1, STUDIO, input, THIEF), coded('T212_CAPS_RATE_LIMITED'));
    // Naming the owner's challenge from the thief's session neither redeems nor spends it.
    await assert.rejects(f.orders.updateCaps(1, STUDIO, { challengeId: owner.challengeId, input, assertion: signed(owner.authentication) }, THIEF), coded('T212_CAPS_RATE_LIMITED'));

    // The owner's challenge is still open, and the owner can still ask for new ones.
    const saved = await f.orders.updateCaps(1, STUDIO, { challengeId: owner.challengeId, input, assertion: signed(owner.authentication) }, OWNER);
    assert.equal(saved.method, 'passkey');
    await f.orders.capsChallenge(1, STUDIO, live(900, 2000), OWNER);

    // Settings shows who asked: the thief's refusals and challenges under its own session and masked client.
    const config = f.orders.config(1, OWNER);
    assert.ok(config.capRefusals.every(item => item.session === 'thief-se' && item.client === THIEF.client && !item.currentSession));
    assert.deepEqual(config.capChanges[0].session, 'owner-se');
    assert.equal(config.capChanges[0].currentSession, true);
    const requests = config.stepUpRequests;
    assert.deepEqual(requests.filter(item => item.currentSession).map(item => item.outcome), ['pending', 'used']);
    const thief = requests.filter(item => !item.currentSession);
    assert.ok(thief.length >= 10 && thief.every(item => item.client === THIEF.client && item.kind === 'caps'));
    assert.deepEqual([...new Set(thief.map(item => item.outcome))].sort(), ['pending', 'replaced']);
  } finally { f.close(); }
});

test('a raise whose caps changed after the review is refused as stale, without counting against the session', async () => {
  const f = fixture();
  try {
    await enablePasskey(f);
    const challenge = await f.orders.capsChallenge(1, STUDIO, live(800, 3000));
    // The reply carries what the review must show: the server's caps now and the new ones.
    assert.equal(challenge.env, 'live');
    assert.deepEqual(challenge.from, { maxOrderValue: 500, dailyLimit: 2000 });
    assert.deepEqual(challenge.to, { maxOrderValue: 800, dailyLimit: 3000 });
    // Another tab lowers the daily cap meanwhile.
    await update(f, STUDIO, live(500, 1500));
    await assert.rejects(update(f, STUDIO, live(800, 3000), { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) }), coded('T212_CAPS_STALE'));
    assert.equal(f.caps().dailyLimit, 1500);
    assert.equal(f.calls.verifyAuthentication.length, 0);
    assert.equal(f.refusals()[0].reason?.includes('作废'), true);
    // A fresh review from the new state goes through.
    const fresh = await f.orders.capsChallenge(1, STUDIO, live(800, 3000));
    assert.deepEqual(fresh.from, { maxOrderValue: 500, dailyLimit: 1500 });
    await update(f, STUDIO, live(800, 3000), { challengeId: fresh.challengeId, assertion: signed(fresh.authentication) });
    assert.equal(f.caps().dailyLimit, 3000);
  } finally { f.close(); }
});

test('refused rows are pruned per session and client, rows from before sessions too, and never hide applied changes', async () => {
  const f = fixture();
  try {
    await update(f, STUDIO, live(400, 2000));
    await assert.rejects(update(f, STUDIO, live(900, 2000)), coded('T212_CAPS_PASSKEY_REQUIRED'));
    // The stored client key is a hash of the unmasked client, never the address itself.
    const { client_key: key } = f.database.prepare("SELECT client_key FROM studio_t212_cap_changes WHERE status = 'refused'").get() as { client_key: string };
    assert.ok(key && !key.includes('unknown'));
    const insert = f.database.prepare(`INSERT INTO studio_t212_cap_changes (user_id, env, direction, method, status, reason, created_at, session_id, client_key)
      VALUES (?, 'live', 'raise', 'session', 'refused', 'old junk', '2026-09-01T00:00:00Z', ?, ?)`);
    for (let index = 0; index < 150; index += 1) insert.run(1, '', key);
    for (let index = 0; index < 120; index += 1) insert.run(1, null, null);
    for (let index = 0; index < 3; index += 1) insert.run(1, OWNER.sessionId, 'another-device');
    insert.run(2, '', key);
    await assert.rejects(update(f, STUDIO, live(900, 2000)), coded('T212_CAPS_PASSKEY_REQUIRED'));
    const count = (userId: number, status: string, sessionId: string | null = '') => (f.database.prepare('SELECT COUNT(*) AS count FROM studio_t212_cap_changes WHERE user_id = ? AND status = ? AND session_id IS ?')
      .get(userId, status, sessionId) as { count: number }).count;
    assert.equal(count(1, 'refused'), 100);
    assert.equal(count(1, 'refused', null), 100, 'rows from before sessions were recorded are bounded too');
    assert.equal(count(1, 'refused', OWNER.sessionId), 3, 'another session’s rows are never flushed');
    assert.equal(count(1, 'applied'), 1);
    assert.equal(count(2, 'refused'), 1, 'other users are untouched');
    assert.equal(f.refusals().length, 20);
    assert.match(f.refusals()[0].reason ?? '', /面容 ID/);
    assert.deepEqual(f.history().map(item => item.to), [{ maxOrderValue: 400, dailyLimit: 2000 }]);
  } finally { f.close(); }
});

test('audit tables written before sessions were recorded gain the new columns', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`CREATE TABLE studio_t212_cap_changes (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, env TEXT,
      old_max_order_value REAL, old_daily_limit REAL, new_max_order_value REAL, new_daily_limit REAL,
      direction TEXT NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL,
      reason TEXT, origin TEXT, passkey_id TEXT, created_at TEXT NOT NULL
    );
    INSERT INTO studio_t212_cap_changes (user_id, env, direction, method, status, created_at, old_max_order_value, old_daily_limit, new_max_order_value, new_daily_limit)
      VALUES (1, 'live', 'lower', 'session', 'applied', '2026-09-01T00:00:00Z', 500, 2000, 400, 2000);`);
    const trading212 = { overview: async () => { throw new Error('unused'); }, placeOrder: async () => ({}), lastCurrency: () => 'GBP', instrumentCurrency: async () => null };
    const orders = createTrading212OrdersService({ database, trading212: trading212 as any, trading: 'both', origins: [STUDIO.origin], verifyStepUp: async () => {} });
    const columns = (database.prepare('PRAGMA table_info(studio_t212_cap_changes)').all() as { name: string }[]).map(column => column.name);
    assert.ok(['session_id', 'client', 'client_key', 'code', 'outcome'].every(name => columns.includes(name)));
    const [old] = orders.config(1, OWNER).capChanges;
    assert.deepEqual([old.session, old.client, old.currentSession], [null, null, false]);
    // A challenge issued before outcomes were recorded is unknown, not "expired", even while recent.
    database.prepare(`INSERT INTO studio_t212_cap_changes (user_id, env, direction, method, status, created_at, new_max_order_value, new_daily_limit)
      VALUES (1, 'live', 'raise', 'passkey', 'issued', ?, 900, 2000)`).run(new Date().toISOString());
    assert.deepEqual(orders.config(1, OWNER).stepUpRequests.map(item => [item.outcome, item.session]), [['unknown', null]]);
  } finally { database.close(); }
});

test('the rolling daily cap counts placed, in-flight and unknown buys and holds against parallel confirmations', async () => {
  const f = fixture();
  try {
    // Daily £300: one £160 order fits, two do not.
    await update(f, STUDIO, live(200, 300));
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
    // While the first waits for the broker, its pending row counts.
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
    assert.deepEqual(f.orderStatuses(), ['placed', 'failed']);

    // A new preview over the remaining allowance is refused up front.
    await assert.rejects(f.orders.preview(1, STUDIO, order()), coded('T212_DAILY_CAP'));
    // A broker refusal frees its share; an unknown outcome counts.
    await update(f, STUDIO, live(200, 299));
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

test('an order in flight survives a restart: the allowance stays spent and the order becomes unknown', async () => {
  const f = fixture();
  try {
    await update(f, STUDIO, live(200, 300));
    const preview = await f.orders.preview(1, STUDIO, order());
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const restarted: { service?: ReturnType<Fixture['restart']> } = {};
    f.onOrder(async () => {
      // The broker has the POST; Studio restarts on the same database before the answer arrives.
      restarted.service = f.restart();
      await gate;
      return Response.json({ id: 11, status: 'NEW' });
    });
    const confirmation = f.orders.confirm(1, STUDIO, preview.id, { confirmed: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.brokerPosts.length, 1);
    const after = restarted.service;
    assert.ok(after);
    assert.equal(after.config(1).caps.envs.live.dailyUsed, 160);
    assert.equal(after.config(1).caps.envs.live.dailyRemaining, 140);
    assert.deepEqual(f.orderStatuses(), ['unknown']);
    // Like any unknown outcome, it holds back an identical order on the restarted service.
    await assert.rejects(after.preview(1, STUDIO, order()), coded('T212_ORDER_UNKNOWN_PENDING'));

    // Only in a test does the old process live on: its late answer still records the true outcome.
    release();
    await confirmation;
    assert.deepEqual(f.orderStatuses(), ['placed']);
    assert.equal(after.config(1).caps.envs.live.dailyUsed, 160);
  } finally { f.close(); }
});

test('if the outcome cannot be written, the order stays pending and keeps counting until a restart marks it unknown', async () => {
  const f = fixture();
  try {
    const preview = await f.orders.preview(1, STUDIO, order());
    f.onOrder(async () => {
      f.database.exec(`CREATE TRIGGER outcome_down BEFORE UPDATE ON studio_t212_orders BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
      return Response.json({ id: 12, status: 'NEW' });
    });
    const placed = await f.orders.confirm(1, STUDIO, preview.id, { confirmed: true });
    assert.equal(placed.order.id, '12', 'the user still learns that the broker accepted the order');
    assert.deepEqual(f.orderStatuses(), ['pending']);
    assert.equal(f.caps().dailyUsed, 160);
    f.database.exec('DROP TRIGGER outcome_down');
    const restarted = f.restart();
    assert.deepEqual(f.orderStatuses(), ['unknown']);
    assert.equal(restarted.config(1).caps.envs.live.dailyUsed, 160);
  } finally { f.close(); }
});

test('the daily cap applies to buys only: sells neither use it nor are blocked by it; the per-order cap covers both', async () => {
  const f = fixture();
  try {
    await update(f, STUDIO, live(200, 200));
    const buy = await f.orders.preview(1, STUDIO, order());
    await f.orders.confirm(1, STUDIO, buy.id, { confirmed: true });
    assert.equal(f.caps().dailyUsed, 160);

    // A £160 sell does not fit in the remaining £40, yet is allowed and uses none of it.
    const sell = await f.orders.preview(1, STUDIO, order({ side: 'sell' }));
    assert.equal(sell.dailyRemaining, 40);
    await f.orders.confirm(1, STUDIO, sell.id, { confirmed: true });
    assert.equal(f.brokerPosts.length, 2);
    assert.equal(f.caps().dailyUsed, 160);
    assert.equal(f.caps().dailyRemaining, 40);
    // A buy still is limited: 0.6 × $100 at £0.80 per dollar is £48, above the £40 left.
    await assert.rejects(f.orders.preview(1, STUDIO, order({ type: 'limit', quantity: 0.6, limitPrice: 100 })), coded('T212_DAILY_CAP'));

    // The per-order cap applies to sells as before, at preview and at confirmation.
    const pendingSell = await f.orders.preview(1, STUDIO, order({ side: 'sell', quantity: 1.2 }));
    await update(f, STUDIO, live(150, 200));
    await assert.rejects(f.orders.confirm(1, STUDIO, pendingSell.id, { confirmed: true }), coded('T212_ORDER_CAP'));
    await assert.rejects(f.orders.preview(1, STUDIO, order({ side: 'sell' })), coded('T212_ORDER_CAP'));
  } finally { f.close(); }
});

test('parallel Face ID confirmations reserve after their own verification and cannot exceed the daily cap', async () => {
  const f = fixture();
  try {
    await enablePasskey(f);
    await update(f, STUDIO, live(200, 400));
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
    await update(f, STUDIO, live(100, 1000));
    await assert.rejects(f.orders.confirm(1, STUDIO, preview.id, { confirmed: true }), coded('T212_ORDER_CAP', /单笔上限已改为 £100\.00/));
    const next = await f.orders.preview(1, STUDIO, order({ type: 'limit', quantity: 0.5, limitPrice: 200 }));
    await update(f, STUDIO, live(50, 60));
    await assert.rejects(f.orders.confirm(1, STUDIO, next.id, { confirmed: true }), coded('T212_ORDER_CAP'));
    assert.equal(f.brokerPosts.length, 0);
  } finally { f.close(); }
});

test('a lowering pressed while Face ID approves a raise wins: the raise is refused as stale', async () => {
  const f = fixture();
  try {
    await enablePasskey(f);
    const challenge = await f.orders.capsChallenge(1, STUDIO, live(800, 3000));
    // Hold the signature check, lower the caps meanwhile (the kill switch), then let the check pass.
    const verifyAuthentication = f.webauthn.verifyAuthenticationResponse;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.webauthn.verifyAuthenticationResponse = (async (options: any) => { await gate; return verifyAuthentication(options); }) as typeof verifyAuthentication;
    const raising = update(f, STUDIO, live(800, 3000), { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) });
    await new Promise(resolve => setTimeout(resolve, 10));
    await update(f, STUDIO, live(100, 200));
    release();
    await assert.rejects(raising, coded('T212_CAPS_STALE'));
    assert.deepEqual([f.caps().maxOrderValue, f.caps().dailyLimit], [100, 200]);
    assert.deepEqual(f.history().map(item => item.direction), ['lower']);
  } finally { f.close(); }
});

test('session-only lowerings by one session and client in a row share one audit row for ten minutes', async () => {
  const f = fixture();
  try {
    await f.orders.updateCaps(1, STUDIO, { input: live(400, 2000) }, OWNER);
    f.advance(60_000);
    await f.orders.updateCaps(1, STUDIO, { input: live(300, 1500) }, OWNER);
    f.advance(9 * 60_000);
    await f.orders.updateCaps(1, STUDIO, { input: live(200, 1500) }, OWNER);
    let changes = f.history();
    assert.equal(changes.length, 1);
    assert.deepEqual([changes[0].from, changes[0].to], [{ maxOrderValue: 500, dailyLimit: 2000 }, { maxOrderValue: 200, dailyLimit: 1500 }]);
    assert.equal(changes[0].createdAt, '2026-10-02T10:10:00.000Z');
    // Another account, another session or client, a gap of more than ten minutes: separate rows.
    await f.orders.updateCaps(1, STUDIO, { input: { env: 'demo', maxOrderValue: 400, dailyLimit: 2000 } }, OWNER);
    await f.orders.updateCaps(1, STUDIO, { input: live(190, 1500) }, THIEF);
    await f.orders.updateCaps(1, STUDIO, { input: live(180, 1500) }, { ...OWNER, clientKey: 'tailnet 100.64.7.7' });
    f.advance(11 * 60_000);
    await f.orders.updateCaps(1, STUDIO, { input: live(170, 1500) }, { ...OWNER, clientKey: 'tailnet 100.64.7.7' });
    changes = f.history();
    assert.deepEqual(changes.map(item => [item.env, item.to?.maxOrderValue]), [['live', 170], ['live', 180], ['live', 190], ['demo', 400], ['live', 200]]);
    assert.equal(f.caps().maxOrderValue, 170);
  } finally { f.close(); }
});
