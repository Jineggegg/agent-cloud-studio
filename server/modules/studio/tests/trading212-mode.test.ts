import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import type { StudioT212OrderInput, StudioT212TradingMode } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createTrading212Service } from '../trading212.service.js';
import { createTrading212OrdersService } from '../trading212-orders.service.js';

type WebAuthn = NonNullable<Parameters<typeof createTrading212OrdersService>[0]['webauthn']>;
type Origin = { origin: string; rpId: string };

const STUDIO = { origin: 'https://studio.ajarche.com', rpId: 'studio.ajarche.com' };
const TAILNET = { origin: 'https://desktop.tail1234.ts.net', rpId: 'desktop.tail1234.ts.net' };
// Two sessions of the same user: the owner's iPad and a stolen token used from elsewhere.
const OWNER = { sessionId: 'owner-session-1', client: 'Tailscale 100.64.*.*' };
const THIEF = { sessionId: 'thief-session-2', client: '公网 203.0.*.*' };
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
// asked to sign (as clientDataJSON does), and verification fails unless that equals the expected challenge, the
// origin and RP ID match and user verification is required.
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

function fixture(trading = 'both') {
  const directory = mkdtempSync(path.join(os.tmpdir(), 't212-mode-test-'));
  const envFile = path.join(directory, 'live.env');
  writeFileSync(envFile, 'TRADING212_API_KEY=fake-live-key\nTRADING212_API_SECRET=fake-live-secret\n');
  const database = new Database(':memory:');
  let clock = Date.parse('2026-10-02T10:00:00Z');
  const brokerPosts: string[] = [];
  const trading212 = createTrading212Service({
    database, envFiles: { live: envFile, demo: envFile }, now: () => clock,
    request: (async (url: string, init: RequestInit) => {
      if (init.method === 'POST') { brokerPosts.push(String(init.body)); return Response.json({ id: 1, status: 'NEW' }); }
      if (String(url).endsWith('/equity/account/summary')) return Response.json(SUMMARY);
      if (String(url).includes('/equity/positions')) return Response.json(POSITIONS);
      return Response.json({ items: [], nextPagePath: null });
    }) as unknown as typeof fetch,
  });
  const { webauthn, calls } = fakeWebAuthn();
  // A second call with another ceiling is what a restarted Studio with an edited .env does.
  const start = (ceiling = trading) => createTrading212OrdersService({
    database, trading212, webauthn, now: () => clock, trading: ceiling, origins: [STUDIO.origin, TAILNET.origin],
    // Stands in for the auth module's step-up, which owns every limit on passwords.
    async verifyStepUp(who, password) {
      if ((who.user as { id?: number }).id !== 1 || password !== PASSWORD) {
        throw new AppError('密码不正确', { code: 'AUTH_STEP_UP_FAILED', statusCode: 403 });
      }
    },
  });
  const orders = start();
  const count = (table: string, status: string) => (database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE status = ?`).get(status) as { count: number }).count;
  return {
    orders, database, webauthn, calls, brokerPosts, restart: start,
    advance: (ms: number) => { clock += ms; },
    config: (service = orders) => service.config(1),
    changes: () => orders.config(1).modeChanges,
    refusals: () => orders.config(1).modeRefusals,
    issued: () => count('studio_t212_mode_changes', 'issued'),
    orderStatuses: () => (database.prepare('SELECT status FROM studio_t212_orders ORDER BY row_id').all() as { status: string }[]).map(row => row.status),
    close: () => { database.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
type Fixture = ReturnType<typeof fixture>;

async function enablePasskey(f: Fixture, origin = STUDIO) {
  await f.orders.passkeyOptions(1, 'owner', origin, PASSWORD);
  return f.orders.registerPasskey(1, origin, { id: 'x', rawId: 'x', response: { attestationObject: 'x' } } as any);
}
// PUT /mode as the router hands it over: the mode, plus the challenge id and assertion for a widening.
function update(f: Fixture, origin: Origin | null, mode: StudioT212TradingMode, proof?: { challengeId: string; assertion: unknown }, userId = 1) {
  return f.orders.updateMode(userId, origin, proof ? { challengeId: proof.challengeId, mode, assertion: proof.assertion as any } : { mode });
}
async function widen(f: Fixture, mode: StudioT212TradingMode, origin = STUDIO) {
  const challenge = await f.orders.modeChallenge(1, origin, mode);
  const credential = origin === TAILNET ? 'cred-tailnet' : 'cred-studio';
  return update(f, origin, mode, { challengeId: challenge.challengeId, assertion: signed(challenge.authentication, origin, credential) });
}
const order = (input: Partial<StudioT212OrderInput> = {}): StudioT212OrderInput => ({
  env: 'live', ticker: 'AAPL_US_EQ', side: 'buy', type: 'market', quantity: 1, timeValidity: 'DAY', ...input,
});
const coded = (code: string, pattern?: RegExp) => (error: Error & { code?: string }) => error.code === code && (!pattern || pattern.test(error.message));

test('the trading mode starts at STUDIO_T212_TRADING, which is also its ceiling, and the first read pins it', () => {
  const both = fixture('both');
  const demo = fixture('demo');
  const off = fixture('off');
  try {
    const pinned = { custom: true, updatedAt: '2026-10-02T10:00:00.000Z' };
    assert.deepEqual(both.config().allowedEnvs, ['live', 'demo']);
    assert.deepEqual(both.config().tradingMode, { mode: 'both', ceiling: 'both', ...pinned });
    assert.deepEqual(demo.config().allowedEnvs, ['demo']);
    assert.deepEqual(demo.config().tradingMode, { mode: 'demo', ceiling: 'demo', ...pinned });
    assert.deepEqual(off.config().allowedEnvs, []);
    assert.equal(off.config().tradingMode.ceiling, 'off');
    // The pin is audited once, however often the settings are read.
    const [pin, ...rest] = both.changes();
    assert.deepEqual(rest, []);
    assert.deepEqual([pin.from, pin.to, pin.direction, pin.method, pin.status], [null, 'both', 'pin', 'session', 'applied']);
    assert.match(pin.reason ?? '', /首次读取时固定/);
    assert.deepEqual(both.refusals(), []);
  } finally { both.close(); demo.close(); off.close(); }
});

test('a user pinned on first read is never widened by a later, wider STUDIO_T212_TRADING without Face ID', async () => {
  const f = fixture('demo');
  try {
    await enablePasskey(f);
    // The first read under demo stores demo as the user's choice; another user never read anything yet.
    assert.deepEqual(f.config().allowedEnvs, ['demo']);
    const raised = f.restart('both');
    assert.deepEqual(raised.config(1).allowedEnvs, ['demo']);
    assert.deepEqual(raised.config(1).tradingMode, { mode: 'demo', ceiling: 'both', custom: true, updatedAt: '2026-10-02T10:00:00.000Z' });
    await assert.rejects(raised.preview(1, STUDIO, order()), coded('T212_TRADING_DISABLED', /实盘下单已在/));
    await assert.rejects(raised.updateMode(1, STUDIO, { mode: 'both' }), coded('T212_MODE_PASSKEY_REQUIRED'));
    // Only Face ID adds live.
    const challenge = await raised.modeChallenge(1, STUDIO, 'both');
    await raised.updateMode(1, STUDIO, { challengeId: challenge.challengeId, mode: 'both', assertion: signed(challenge.authentication) });
    assert.deepEqual(raised.config(1).allowedEnvs, ['live', 'demo']);
    // An order path pins too: user 2 never opened Settings, only previewed under demo.
    await f.restart('demo').preview(2, STUDIO, order({ env: 'demo' }));
    assert.deepEqual(f.restart('both').config(2).allowedEnvs, ['demo']);
  } finally { f.close(); }
});

test('a user without a stored choice can pin the mode in force with the session alone', async () => {
  const f = fixture('both');
  try {
    // Straight to PUT /mode, no settings read before it.
    const pinned = await update(f, null, 'both');
    assert.deepEqual([pinned.mode, pinned.direction, pinned.method], ['both', 'pin', 'session']);
    assert.equal(pinned.tradingMode.custom, true);
    const [entry] = f.changes();
    assert.deepEqual([entry.from, entry.to, entry.direction, entry.status], ['both', 'both', 'pin', 'applied']);
    // Once stored, the same mode again is no change.
    await assert.rejects(update(f, null, 'both'), coded('T212_MODE_UNCHANGED'));
    assert.deepEqual(f.restart('both').config(1).allowedEnvs, ['live', 'demo']);
  } finally { f.close(); }
});

test('narrowing needs only the session, also without any passkey or trusted page, and is audited', async () => {
  const f = fixture('both');
  try {
    const narrowed = await update(f, null, 'demo');
    assert.equal(narrowed.method, 'session');
    assert.equal(narrowed.direction, 'narrow');
    assert.deepEqual(narrowed.allowedEnvs, ['demo']);
    assert.equal(narrowed.tradingMode.mode, 'demo');
    assert.equal(narrowed.tradingMode.custom, true);
    assert.deepEqual(f.config().allowedEnvs, ['demo']);
    const [entry] = f.changes();
    assert.deepEqual([entry.from, entry.to, entry.direction, entry.method, entry.status, entry.origin], ['both', 'demo', 'narrow', 'session', 'applied', null]);

    // Live is now refused for this user, with a message that points at Settings rather than the server.
    await assert.rejects(f.orders.preview(1, STUDIO, order()), coded('T212_TRADING_DISABLED', /实盘下单已在「设置 → 交易安全」关闭/));
    // Off, from a trusted page this time.
    const off = await update(f, STUDIO, 'off');
    assert.equal(off.method, 'session');
    assert.deepEqual(off.allowedEnvs, []);
    await assert.rejects(f.orders.preview(1, STUDIO, order({ env: 'demo' })), coded('T212_TRADING_DISABLED', /模拟盘下单已在/));
    assert.equal(f.changes()[0].origin, STUDIO.origin);
    // The same mode again is no change, and nothing touched the authenticator.
    await assert.rejects(update(f, STUDIO, 'off'), coded('T212_MODE_UNCHANGED'));
    await assert.rejects(f.orders.modeChallenge(1, STUDIO, 'off'), coded('T212_MODE_UNCHANGED'));
    assert.equal(f.calls.authentication.length, 0);
    assert.equal(f.refusals().length, 0, 'narrowing and no-ops are not widening attempts');
    assert.equal(f.brokerPosts.length, 0);
    // Choices are per user.
    assert.deepEqual(f.orders.config(2).allowedEnvs, ['live', 'demo']);
  } finally { f.close(); }
});

test('a narrowing that drops one account while adding another is a widening', async () => {
  const f = fixture('both');
  try {
    await update(f, null, 'demo');
    await assert.rejects(update(f, STUDIO, 'live'), coded('T212_MODE_PASSKEY_REQUIRED'));
    await assert.rejects(f.orders.modeChallenge(1, STUDIO, 'demo'), coded('T212_MODE_UNCHANGED'));
    await assert.rejects(f.orders.modeChallenge(1, STUDIO, 'off'), coded('T212_MODE_NOT_WIDENING'));
    assert.deepEqual(f.config().allowedEnvs, ['demo']);
  } finally { f.close(); }
});

test('without a passkey on this domain nothing can be widened: 启用面容 ID 后才能开启', async () => {
  const f = fixture('both');
  try {
    await update(f, null, 'off');
    await assert.rejects(f.orders.modeChallenge(1, STUDIO, 'demo'), coded('T212_MODE_PASSKEY_REQUIRED', /启用面容 ID 后才能开启/));
    await assert.rejects(update(f, STUDIO, 'demo'), coded('T212_MODE_PASSKEY_REQUIRED', /启用面容 ID 后才能开启/));
    // From a page off the allowlist the refusal says so.
    await assert.rejects(update(f, null, 'demo'), coded('T212_MODE_PASSKEY_REQUIRED', /白名单/));
    // A passkey on another domain does not let this one widen.
    await enablePasskey(f, TAILNET);
    await assert.rejects(f.orders.modeChallenge(1, STUDIO, 'demo'), coded('T212_MODE_PASSKEY_REQUIRED', /desktop\.tail1234\.ts\.net/));
    assert.equal(f.calls.authentication.length, 0);
    assert.equal(f.issued(), 0);
    assert.deepEqual(f.config().allowedEnvs, []);
    const refusals = f.refusals();
    assert.equal(refusals.length, 2, 'refused widenings are audited; refused challenges are not');
    assert.deepEqual(refusals.map(item => [item.from, item.to, item.direction, item.method, item.status]), [
      ['off', 'demo', 'widen', 'session', 'refused'], ['off', 'demo', 'widen', 'session', 'refused'],
    ]);
  } finally { f.close(); }
});

test('widening is bound to user, exact mode and origin, and verified against the stored passkey with user verification', async () => {
  const f = fixture('both');
  try {
    const passkey = await enablePasskey(f);
    await update(f, STUDIO, 'off');
    const challenge = await f.orders.modeChallenge(1, STUDIO, 'live');
    const options = f.calls.authentication.at(-1);
    assert.equal(options.userVerification, 'required');
    assert.equal(options.rpID, STUDIO.rpId);
    assert.equal(options.timeout, 60_000);
    assert.deepEqual(options.allowCredentials.map((item: { id: string }) => item.id), ['cred-studio']);
    assert.equal(Date.parse(challenge.expiresAt) - Date.parse('2026-10-02T10:00:00Z'), 60_000);
    assert.equal(f.issued(), 1, 'issuing the challenge is audited');

    // Another user (whose live account is off too) can neither redeem this challenge nor burn it.
    await f.orders.updateMode(2, STUDIO, { mode: 'off' });
    await assert.rejects(update(f, STUDIO, 'live', { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) }, 2), coded('T212_MODE_CHALLENGE_GONE'));
    assert.deepEqual(f.orders.config(2).allowedEnvs, []);

    const saved = await update(f, STUDIO, 'live', { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) });
    assert.deepEqual([saved.mode, saved.direction, saved.method], ['live', 'widen', 'passkey']);
    assert.deepEqual(saved.allowedEnvs, ['live']);
    const verify = f.calls.verifyAuthentication.at(-1);
    assert.equal(verify.requireUserVerification, true);
    assert.equal(verify.expectedOrigin, STUDIO.origin);
    assert.equal(verify.expectedRPID, STUDIO.rpId);
    const stored = f.database.prepare('SELECT counter, last_used_at FROM studio_t212_passkeys WHERE id = ?').get(passkey.id) as { counter: number; last_used_at: string };
    assert.equal(stored.counter, 1, 'the signature counter advanced');
    assert.ok(stored.last_used_at);
    const [entry] = f.changes();
    assert.deepEqual([entry.from, entry.to, entry.direction, entry.method, entry.origin], ['off', 'live', 'widen', 'passkey', STUDIO.origin]);

    // Live trades again; demo stays off.
    const preview = await f.orders.preview(1, STUDIO, order());
    assert.equal(preview.requires, 'passkey');
    await assert.rejects(f.orders.preview(1, STUDIO, order({ env: 'demo' })), coded('T212_TRADING_DISABLED'));
  } finally { f.close(); }
});

test('a tampered mode is refused and audited, and the challenge is spent before anything else is checked', async () => {
  const f = fixture('both');
  try {
    await enablePasskey(f);
    await update(f, STUDIO, 'off');
    // Face ID approved demo; the request asks for both.
    const challenge = await f.orders.modeChallenge(1, STUDIO, 'demo');
    const assertion = signed(challenge.authentication);
    await assert.rejects(update(f, STUDIO, 'both', { challengeId: challenge.challengeId, assertion }), coded('T212_MODE_TAMPERED'));
    // Spent by the refused attempt: the approved mode cannot follow with it.
    await assert.rejects(update(f, STUDIO, 'demo', { challengeId: challenge.challengeId, assertion }), coded('T212_MODE_CHALLENGE_GONE'));
    assert.equal(f.calls.verifyAuthentication.length, 0, 'tampered requests never reach signature verification');

    // A malformed body naming a challenge burns it too, and is audited with the mode it was issued for.
    const next = await f.orders.modeChallenge(1, STUDIO, 'demo');
    await assert.rejects(f.orders.updateMode(1, STUDIO, { challengeId: next.challengeId, invalid: '交易模式必须为 off、demo、live 或 both' }), coded('T212_MODE_INVALID'));
    await assert.rejects(update(f, STUDIO, 'demo', { challengeId: next.challengeId, assertion: signed(next.authentication) }), coded('T212_MODE_CHALLENGE_GONE'));

    assert.deepEqual(f.config().allowedEnvs, []);
    const refusals = f.refusals();
    assert.equal(refusals.length, 4);
    const tampered = refusals.find(item => item.reason?.includes('不一致'));
    assert.deepEqual([tampered?.from, tampered?.to, tampered?.method], ['off', 'both', 'passkey']);
    const malformed = refusals.find(item => item.reason?.includes('交易模式必须为'));
    assert.equal(malformed?.to, 'demo', 'a malformed attempt is recorded with the mode its challenge was issued for');
    assert.equal(malformed?.method, 'passkey');
    assert.equal(refusals.filter(item => item.reason?.includes('已经用过')).length, 2);
  } finally { f.close(); }
});

test('a widening cannot be replayed, expires after 60 seconds and needs a valid signature over its own challenge', async () => {
  const f = fixture('both');
  try {
    await enablePasskey(f);
    await update(f, STUDIO, 'off');
    const challenge = await f.orders.modeChallenge(1, STUDIO, 'demo');
    const proof = { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) };
    await update(f, STUDIO, 'demo', proof);
    // Replaying the same proof, even after narrowing again, is refused.
    await update(f, STUDIO, 'off');
    await assert.rejects(update(f, STUDIO, 'demo', proof), coded('T212_MODE_CHALLENGE_GONE'));
    assert.deepEqual(f.config().allowedEnvs, []);

    const late = await f.orders.modeChallenge(1, STUDIO, 'demo');
    f.advance(60_001);
    await assert.rejects(update(f, STUDIO, 'demo', { challengeId: late.challengeId, assertion: signed(late.authentication) }), coded('T212_MODE_CHALLENGE_EXPIRED'));

    const forged = await f.orders.modeChallenge(1, STUDIO, 'demo');
    await assert.rejects(update(f, STUDIO, 'demo', { challengeId: forged.challengeId, assertion: signed(forged.authentication, STUDIO, 'cred-studio', 'forged') }), coded('T212_MODE_PASSKEY_FAILED'));
    // An assertion over another challenge (a cap raise for the same user) does not fit this one.
    const caps = await f.orders.capsChallenge(1, STUDIO, { env: 'live', maxOrderValue: 600, dailyLimit: 2000 });
    const other = await f.orders.modeChallenge(1, STUDIO, 'demo');
    await assert.rejects(update(f, STUDIO, 'demo', { challengeId: other.challengeId, assertion: signed(caps.authentication) }), coded('T212_MODE_PASSKEY_FAILED'));
    // A cap raise's challenge id is unknown to the trading mode.
    await assert.rejects(update(f, STUDIO, 'demo', { challengeId: caps.challengeId, assertion: signed(caps.authentication) }), coded('T212_MODE_CHALLENGE_GONE'));
    assert.deepEqual(f.config().allowedEnvs, []);
    assert.equal(f.config().caps.envs.live.maxOrderValue, 500);
    assert.deepEqual(f.changes().map(item => item.direction), ['narrow', 'widen', 'narrow']);
  } finally { f.close(); }
});

test('a widening must be finished on the trusted origin and RP ID it was issued to', async () => {
  const f = fixture('both');
  try {
    await enablePasskey(f, STUDIO);
    await update(f, STUDIO, 'off');
    const challenge = await f.orders.modeChallenge(1, STUDIO, 'demo');
    await assert.rejects(update(f, null, 'demo', { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) }), coded('T212_UNTRUSTED_ORIGIN'));
    const again = await f.orders.modeChallenge(1, STUDIO, 'demo');
    await assert.rejects(update(f, TAILNET, 'demo', { challengeId: again.challengeId, assertion: signed(again.authentication, TAILNET) }), coded('T212_MODE_WRONG_ORIGIN'));

    // With passkeys on both domains, the studio credential still cannot approve a widening on the Tailscale domain.
    await enablePasskey(f, TAILNET);
    const tailnet = await f.orders.modeChallenge(1, TAILNET, 'demo');
    assert.deepEqual(f.calls.authentication.at(-1).allowCredentials.map((item: { id: string }) => item.id), ['cred-tailnet']);
    await assert.rejects(update(f, TAILNET, 'demo', { challengeId: tailnet.challengeId, assertion: signed(tailnet.authentication, STUDIO, 'cred-studio') }), coded('T212_MODE_PASSKEY_FAILED'));
    assert.deepEqual(f.config().allowedEnvs, []);
    const saved = await widen(f, 'demo', TAILNET);
    assert.equal(saved.method, 'passkey');
    assert.equal(f.changes()[0].origin, TAILNET.origin);
  } finally { f.close(); }
});

test('the env ceiling is enforced server-side, even with Face ID and for choices saved under a wider ceiling', async () => {
  const f = fixture('demo');
  try {
    await enablePasskey(f);
    // Live is outside STUDIO_T212_TRADING=demo: refused before any challenge, and as an update it is an audited widening.
    await assert.rejects(f.orders.modeChallenge(1, STUDIO, 'live'), coded('T212_MODE_CEILING', /服务器未开启实盘下单/));
    await assert.rejects(f.orders.modeChallenge(1, STUDIO, 'both'), coded('T212_MODE_CEILING', /服务器未开启实盘下单/));
    await assert.rejects(update(f, STUDIO, 'both'), coded('T212_MODE_CEILING'));
    await assert.rejects(f.orders.modeChallenge(1, STUDIO, 'demo'), coded('T212_MODE_UNCHANGED'), 'demo is already in force');
    // A challenge for demo cannot be stretched to both.
    await update(f, STUDIO, 'off');
    const demo = await f.orders.modeChallenge(1, STUDIO, 'demo');
    await assert.rejects(update(f, STUDIO, 'both', { challengeId: demo.challengeId, assertion: signed(demo.authentication) }), coded('T212_MODE_CEILING'));
    assert.deepEqual(f.config().allowedEnvs, []);
    assert.equal(f.refusals().length, 2);
    await assert.rejects(f.orders.preview(1, STUDIO, order()), coded('T212_TRADING_DISABLED', /STUDIO_T212_TRADING=live/));
  } finally { f.close(); }

  // A choice of both saved while the server allowed both; the server is restarted with demo only.
  const g = fixture('both');
  try {
    await enablePasskey(g);
    await update(g, STUDIO, 'live');
    await widen(g, 'both');
    assert.deepEqual(g.config().allowedEnvs, ['live', 'demo']);
    const restarted = g.restart('demo');
    assert.deepEqual(restarted.config(1).allowedEnvs, ['demo']);
    assert.deepEqual(restarted.config(1).tradingMode, { mode: 'demo', ceiling: 'demo', custom: true, updatedAt: '2026-10-02T10:00:00.000Z' });
    await assert.rejects(restarted.preview(1, STUDIO, order()), coded('T212_TRADING_DISABLED', /STUDIO_T212_TRADING/));
    await restarted.preview(1, STUDIO, order({ env: 'demo' }));
    // With trading off on the server, every choice but off is outside the ceiling.
    const off = g.restart('off');
    assert.deepEqual(off.config(1).allowedEnvs, []);
    await assert.rejects(off.updateMode(1, STUDIO, { mode: 'demo' }), coded('T212_MODE_CEILING', /服务器未开启模拟盘下单/));
    // A narrowed choice is not widened again by a wider ceiling: it stays the user's choice.
    const narrowed = g.restart('both');
    await narrowed.updateMode(1, STUDIO, { mode: 'demo' });
    assert.deepEqual(g.restart('both').config(1).allowedEnvs, ['demo']);
  } finally { g.close(); }
});

test('an unreadable saved choice fails closed', () => {
  const f = fixture('both');
  try {
    f.database.exec("INSERT INTO studio_t212_trading_modes VALUES (1, 'everything', '2026-10-01T00:00:00Z')");
    assert.deepEqual(f.config().allowedEnvs, []);
    assert.equal(f.config().tradingMode.mode, 'off');
  } finally { f.close(); }
});

test('an order previewed for an account that was just taken out is refused at confirmation', async () => {
  const f = fixture('both');
  try {
    // Double confirmation (no passkey yet).
    const preview = await f.orders.preview(1, STUDIO, order());
    await update(f, null, 'demo');
    await assert.rejects(f.orders.confirm(1, STUDIO, preview.id, { confirmed: true }), coded('T212_TRADING_DISABLED', /订单没有提交/));
    assert.equal(f.brokerPosts.length, 0);
    assert.deepEqual(f.orderStatuses(), ['failed']);
    // Off stops demo too.
    const demo = await f.orders.preview(1, STUDIO, order({ env: 'demo' }));
    await update(f, null, 'off');
    await assert.rejects(f.orders.confirm(1, STUDIO, demo.id, { confirmed: true }), coded('T212_TRADING_DISABLED'));
    assert.equal(f.brokerPosts.length, 0);
  } finally { f.close(); }
});

test('a narrowing that lands while Face ID is being verified still stops the order', async () => {
  const f = fixture('both');
  try {
    await enablePasskey(f);
    const preview = await f.orders.preview(1, STUDIO, order());
    assert.equal(preview.requires, 'passkey');
    // Hold the signature check, narrow meanwhile, then let it pass.
    const verifyAuthentication = f.webauthn.verifyAuthenticationResponse;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.webauthn.verifyAuthenticationResponse = (async (options: any) => { await gate; return verifyAuthentication(options); }) as typeof verifyAuthentication;
    const confirmation = f.orders.confirm(1, STUDIO, preview.id, { assertion: signed(preview.authentication!) });
    await new Promise(resolve => setTimeout(resolve, 10));
    await update(f, STUDIO, 'demo');
    release();
    await assert.rejects(confirmation, coded('T212_TRADING_DISABLED', /实盘下单已在/));
    assert.equal(f.brokerPosts.length, 0);
    assert.deepEqual(f.orderStatuses(), ['failed']);
  } finally { f.close(); }
});

test('two parallel submissions of one widening save at most once', async () => {
  const f = fixture('both');
  try {
    await enablePasskey(f);
    await update(f, STUDIO, 'off');
    const challenge = await f.orders.modeChallenge(1, STUDIO, 'both');
    const proof = { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) };
    const outcomes = await Promise.allSettled([update(f, STUDIO, 'both', proof), update(f, STUDIO, 'both', proof)]);
    assert.deepEqual(outcomes.map(item => item.status).sort(), ['fulfilled', 'rejected']);
    assert.equal((outcomes.find((item): item is PromiseRejectedResult => item.status === 'rejected'))?.reason.code, 'T212_MODE_CHALLENGE_GONE');
    assert.equal(f.calls.verifyAuthentication.length, 1, 'only one attempt reached signature verification');
    assert.deepEqual(f.changes().map(item => item.direction), ['widen', 'narrow']);
  } finally { f.close(); }
});

test('the mode and its audit row are saved together or not at all', async () => {
  const f = fixture('both');
  try {
    f.database.exec(`CREATE TRIGGER mode_audit_down BEFORE INSERT ON studio_t212_mode_changes WHEN NEW.status = 'applied'
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    await assert.rejects(update(f, STUDIO, 'off'), /audit unavailable/);
    // Reads still answer (with the ceiling) when the first-read pin cannot be written either.
    assert.deepEqual(f.config().allowedEnvs, ['live', 'demo']);
    assert.equal(f.config().tradingMode.custom, false);
    f.database.exec('DROP TRIGGER mode_audit_down');
    await update(f, STUDIO, 'off');
    assert.deepEqual(f.config().allowedEnvs, []);
    assert.equal(f.changes().length, 1);
  } finally { f.close(); }
});


test('widening challenges and refusals are limited per session and hour with a Retry-After; refusals never block Face ID', async () => {
  const f = fixture('both');
  const limited = (seconds: number, pattern?: RegExp) => (error: Error & { code?: string; statusCode?: number; details?: { retryAfterSeconds?: number } }) =>
    error.code === 'T212_MODE_RATE_LIMITED' && error.statusCode === 429 && error.details?.retryAfterSeconds === seconds && (!pattern || pattern.test(error.message));
  try {
    await enablePasskey(f);
    await update(f, STUDIO, 'live');
    for (let index = 0; index < 10; index += 1) await f.orders.modeChallenge(1, STUDIO, 'both');
    await assert.rejects(f.orders.modeChallenge(1, STUDIO, 'both'), limited(3600, /发起开启下单的次数过多/));
    assert.equal(f.issued(), 10, 'refused issuance adds no row');
    // Reviews left to time out stop counting: the five still open expire, the five replaced ones remain.
    f.advance(61_000);
    for (let index = 0; index < 5; index += 1) await f.orders.modeChallenge(1, STUDIO, 'both');
    await assert.rejects(f.orders.modeChallenge(1, STUDIO, 'both'), coded('T212_MODE_RATE_LIMITED'));
    f.advance(60 * 60_000);

    // Refused widenings: ten are audited and the next gets a 429 and no row, but Face ID can still be asked for.
    for (let index = 0; index < 10; index += 1) await assert.rejects(update(f, STUDIO, 'both'), coded('T212_MODE_PASSKEY_REQUIRED', /需要面容 ID/));
    await assert.rejects(update(f, STUDIO, 'both'), limited(3600, /关闭或减少账户不受影响/));
    assert.equal(f.refusals().length, 10);
    const saved = await widen(f, 'both');
    assert.equal(saved.method, 'passkey');
    // The caps budget is separate, and narrowing is never limited.
    await f.orders.capsChallenge(1, STUDIO, { env: 'live', maxOrderValue: 600, dailyLimit: 2000 });
    const narrowed = await update(f, null, 'off');
    assert.equal(narrowed.method, 'session');
    assert.deepEqual(f.changes().map(item => [item.from, item.to]), [['both', 'off'], ['live', 'both'], ['both', 'live']]);
  } finally { f.close(); }
});

test('only real Face ID failures gate new widening challenges; expired and stale reviews never count', async () => {
  const f = fixture('both');
  try {
    await enablePasskey(f);
    await update(f, STUDIO, 'off');
    // Expired reviews: the session's own timing, never counted against it.
    for (let index = 0; index < 12; index += 1) {
      const late = await f.orders.modeChallenge(1, STUDIO, 'demo');
      f.advance(61_000);
      await assert.rejects(update(f, STUDIO, 'demo', { challengeId: late.challengeId, assertion: signed(late.authentication) }), coded('T212_MODE_CHALLENGE_EXPIRED'));
    }
    // Real failures: forged signatures and tampered modes, each over a fresh challenge.
    for (let index = 0; index < 5; index += 1) {
      const forged = await f.orders.modeChallenge(1, STUDIO, 'demo');
      await assert.rejects(update(f, STUDIO, 'demo', { challengeId: forged.challengeId, assertion: signed(forged.authentication, STUDIO, 'cred-studio', 'forged') }), coded('T212_MODE_PASSKEY_FAILED'));
      const tampered = await f.orders.modeChallenge(1, STUDIO, 'demo');
      await assert.rejects(update(f, STUDIO, 'both', { challengeId: tampered.challengeId, assertion: signed(tampered.authentication) }), coded('T212_MODE_TAMPERED'));
      f.advance(61_000);
    }
    await assert.rejects(f.orders.modeChallenge(1, STUDIO, 'demo'), coded('T212_MODE_RATE_LIMITED', /验证失败的次数过多/));
    assert.deepEqual(f.config().allowedEnvs, []);
  } finally { f.close(); }
});

test('a stolen session cannot lock the owner out of re-enabling trading, evict or burn the owner’s challenge', async () => {
  const f = fixture('both');
  try {
    await enablePasskey(f);
    // The thief turns trading off, then burns every budget its session has.
    await f.orders.updateMode(1, STUDIO, { mode: 'off' }, THIEF);
    const owner = await f.orders.modeChallenge(1, STUDIO, 'both', OWNER);
    for (let index = 0; index < 10; index += 1) await assert.rejects(f.orders.updateMode(1, STUDIO, { mode: 'live' }, THIEF), coded('T212_MODE_PASSKEY_REQUIRED'));
    await assert.rejects(f.orders.updateMode(1, STUDIO, { mode: 'live' }, THIEF), coded('T212_MODE_RATE_LIMITED'));
    for (let index = 0; index < 10; index += 1) await f.orders.modeChallenge(1, STUDIO, 'live', THIEF);
    await assert.rejects(f.orders.modeChallenge(1, STUDIO, 'live', THIEF), coded('T212_MODE_RATE_LIMITED'));
    // Another session's challenge id is neither redeemed nor spent, even with a 'valid' assertion (here from a fresh
    // client of the thief's session, whose budget is not used up yet).
    await assert.rejects(f.orders.updateMode(1, STUDIO, { challengeId: owner.challengeId, mode: 'both', assertion: signed(owner.authentication) }, { ...THIEF, client: 'Tailscale 100.64.*.*' }),
      coded('T212_MODE_CHALLENGE_GONE'));
    assert.equal(f.calls.verifyAuthentication.length, 0);

    // The owner's challenge survived the thief's ten, and the owner re-enables trading with Face ID.
    const saved = await f.orders.updateMode(1, STUDIO, { challengeId: owner.challengeId, mode: 'both', assertion: signed(owner.authentication) }, OWNER);
    assert.deepEqual([saved.mode, saved.method], ['both', 'passkey']);
    await f.orders.updateMode(1, STUDIO, { mode: 'off' }, OWNER);
    await f.orders.modeChallenge(1, STUDIO, 'demo', OWNER);

    // Settings shows the owner who asked: every thief row carries its session and masked client.
    const config = f.orders.config(1, OWNER);
    const thief = config.modeRefusals.filter(item => item.client === THIEF.client);
    assert.equal(thief.length, 10);
    assert.ok(thief.every(item => item.session === 'thief-se' && !item.currentSession));
    const [narrowedByOwner, widenedByOwner, offByThief] = config.modeChanges;
    assert.deepEqual([narrowedByOwner.currentSession, widenedByOwner.currentSession, offByThief.currentSession], [true, true, false]);
    assert.equal(offByThief.client, THIEF.client);
    const requests = config.stepUpRequests;
    assert.deepEqual(requests.filter(item => item.currentSession).map(item => [item.kind, item.outcome]), [['mode', 'pending'], ['mode', 'used']]);
    assert.ok(requests.filter(item => !item.currentSession).every(item => item.session === 'thief-se' && item.client === THIEF.client));
  } finally { f.close(); }
});

test('the challenge reply carries the server state, and a widening whose mode changed after the review is stale', async () => {
  const f = fixture('both');
  try {
    await enablePasskey(f);
    await update(f, STUDIO, 'demo');
    const challenge = await f.orders.modeChallenge(1, STUDIO, 'both');
    assert.deepEqual([challenge.from, challenge.to, challenge.adds, challenge.ceiling], ['demo', 'both', ['live'], 'both']);
    // Another tab turns trading off before Face ID completes: the reviewed "demo → both" no longer describes it.
    await update(f, STUDIO, 'off');
    await assert.rejects(update(f, STUDIO, 'both', { challengeId: challenge.challengeId, assertion: signed(challenge.authentication) }), coded('T212_MODE_STALE'));
    assert.deepEqual(f.config().allowedEnvs, []);
    assert.equal(f.calls.verifyAuthentication.length, 0);
    const [stale] = f.refusals();
    assert.deepEqual([stale.from, stale.to], ['off', 'both']);
    // A fresh review from the new state goes through.
    const fresh = await f.orders.modeChallenge(1, STUDIO, 'both');
    assert.deepEqual([fresh.from, fresh.adds], ['off', ['live', 'demo']]);
    await update(f, STUDIO, 'both', { challengeId: fresh.challengeId, assertion: signed(fresh.authentication) });
    assert.deepEqual(f.config().allowedEnvs, ['live', 'demo']);
  } finally { f.close(); }
});
