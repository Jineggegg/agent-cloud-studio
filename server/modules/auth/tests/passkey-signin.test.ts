import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import type { StudioRequestClient } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createAccountLockout, createStepUpFailureCap } from '../account-lockout.service.js';
import { createAccountSecurityService } from '../account-security.service.js';
import { createAuthSecurityStore } from '../auth-security.store.js';
import { createAuthService } from '../auth.service.js';
import { createHandoffCodeStore } from '../handoff.service.js';
import { createPasskeyCeremonies } from '../passkey-signin.service.js';
import { createSecurityEventLog } from '../security-events.service.js';

type Ceremonies = Parameters<typeof createPasskeyCeremonies>[0];
type WebAuthnFakes = NonNullable<Ceremonies['webauthn']>;
type Started = { ceremonyId: string; options: { challenge: string; rpId?: string; userVerification?: string } };

const PUBLIC_ORIGIN = 'https://studio.ajarche.com';
const TAILNET_ORIGIN = 'https://laptop-acgghbuq.tail6e45f0.ts.net:8443';
const OWNER = { id: 1, username: 'andrew' };
const PASSWORD = 'correct horse battery staple';
const CLIENT: StudioRequestClient = { door: 'cloudflare', address: '198.51.100.7' };
const OWNER_DEVICE: StudioRequestClient = { door: 'tailnet', address: '100.101.102.103' };

// What the browser sends back from navigator.credentials.get: the challenge travels inside
// clientDataJSON, which is all the service reads before handing the rest to SimpleWebAuthn.
function assertion(credentialId: string, challenge: string, userHandle?: string) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: PUBLIC_ORIGIN })).toString('base64url');
  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    response: { clientDataJSON, authenticatorData: 'AA', signature: 'AA', ...(userHandle ? { userHandle } : {}) },
    clientExtensionResults: {},
  };
}

function registration(credentialId: string) {
  return { id: credentialId, rawId: credentialId, type: 'public-key', response: { clientDataJSON: 'AA', attestationObject: 'AA' }, clientExtensionResults: {} };
}

function createHarness(limits: { maxUsedChallenges?: number } = {}) {
  const clock = { now: 1_000_000 };
  const database = new Database(':memory:');
  const store = createAuthSecurityStore(database);
  let challengeCount = 0;
  const calls: { verifyAuthentication: Record<string, unknown>[]; signInOptions: Record<string, unknown>[] } = { verifyAuthentication: [], signInOptions: [] };
  const logs: string[] = [];
  // Fakes standing in for SimpleWebAuthn: no real authenticator, no cryptography.
  const behaviour = { verified: true, userVerified: true, newCounter: 7, throws: false };
  const webauthn = {
    generateAuthenticationOptions: async (options: Record<string, unknown>) => {
      calls.signInOptions.push(options);
      challengeCount += 1;
      return { challenge: `challenge-${challengeCount}`, rpId: options.rpID, userVerification: options.userVerification, timeout: options.timeout };
    },
    verifyAuthenticationResponse: async (options: Record<string, unknown>) => {
      calls.verifyAuthentication.push(options);
      if (behaviour.throws) throw new Error('Response counter value was lower than expected');
      return { verified: behaviour.verified, authenticationInfo: { newCounter: behaviour.newCounter, userVerified: behaviour.userVerified } };
    },
    generateRegistrationOptions: async (options: Record<string, unknown>) => {
      challengeCount += 1;
      return { challenge: `registration-${challengeCount}`, rp: { id: options.rpID }, authenticatorSelection: options.authenticatorSelection };
    },
    verifyRegistrationResponse: async (options: { response: { id: string } }) => ({
      verified: true,
      registrationInfo: { credential: { id: options.response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] } },
    }),
  } as unknown as WebAuthnFakes;
  const passkeys = createPasskeyCeremonies({
    store: store.passkeys,
    origins: () => ({ public: PUBLIC_ORIGIN, tailnet: TAILNET_ORIGIN, invalid: [] }),
    webauthn,
    now: () => clock.now,
    ...limits,
  });
  const lockout = createAccountLockout({ store: store.lockouts, isAccount: (username) => username === OWNER.username, now: () => clock.now });
  const events = createSecurityEventLog({ store: store.events, now: () => clock.now });
  const stepUpCap = createStepUpFailureCap({ store: store.stepUpFailures, now: () => clock.now });
  const issued: unknown[] = [];
  const service = createAuthService({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: (username) => (username === OWNER.username ? { ...OWNER, password_hash: 'owner-hash' } : undefined),
      updateLastLogin: () => undefined,
      countActiveUsers: () => 1,
      getFirstUser: () => OWNER,
    },
    transaction: { begin: () => undefined, commit: () => undefined, rollback: () => undefined },
    hashPassword: async () => 'hash',
    comparePassword: async (password, hash) => hash === 'owner-hash' && password === PASSWORD,
    generateToken: (user) => {
      issued.push(user);
      return 'passkey-token';
    },
    tailscaleSignIn: () => ({ allowedLogins: [], allowedNodes: [], mappedUsername: null, pinnedOrigin: null }),
    handoffCodes: createHandoffCodeStore(),
    ingressOrigins: () => ({ public: PUBLIC_ORIGIN, tailnet: TAILNET_ORIGIN, invalid: [] }),
    logInfo: (message) => logs.push(message),
    now: () => clock.now,
    accountLockout: lockout,
    stepUpFailureCap: stepUpCap,
    securityEvents: events,
    passkeys,
    findUserById: (userId) => (userId === OWNER.id ? OWNER : undefined),
  });
  const revoked: number[] = [];
  const security = createAccountSecurityService({
    verifyStepUpPassword: service.verifyStepUpPassword,
    passkeys,
    events,
    lockout,
    stepUpCap,
    sessionVersions: store.sessionVersions,
    onSessionsRevoked: (userId) => {
      revoked.push(userId);
      return { webSockets: 2, apiKeys: 1, snrAccess: 0, handoffCodes: 0 };
    },
    logInfo: () => undefined,
  });
  // Sign-in passkeys for both doors, as registration would have stored them.
  for (const [id, rpId, credentialId] of [
    ['00000000-0000-4000-8000-000000000001', 'studio.ajarche.com', 'cred-public'],
    ['00000000-0000-4000-8000-000000000002', 'laptop-acgghbuq.tail6e45f0.ts.net', 'cred-tailnet'],
  ]) {
    store.passkeys.insert({
      id, user_id: OWNER.id, rp_id: rpId, credential_id: credentialId,
      public_key: Buffer.from([1]), counter: 3, transports: '["internal"]', label: 'iPad', created_at: new Date(clock.now).toISOString(), last_used_at: null,
    });
  }
  const start = async (origin: string, client: StudioRequestClient = CLIENT) => await service.passkeySignInOptions(origin, client) as Started;
  const finish = (origin: string, started: Started, credentialId: string, client: StudioRequestClient = CLIENT, userHandle?: string) =>
    service.signInWithPasskey({ origin, ceremonyId: started.ceremonyId, response: assertion(credentialId, started.options.challenge, userHandle), client });
  return { service, security, passkeys, store, events, lockout, clock, calls, behaviour, issued, revoked, logs, start, finish };
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError);
    return `${error.statusCode} ${error.code}`;
  }
  return 'ok';
}

test('sign-in options name no credential, require user verification and come with an opaque ceremony id', async () => {
  const { start, service, calls } = createHarness();
  const started = await start(PUBLIC_ORIGIN);
  assert.match(started.ceremonyId, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(started.options.rpId, 'studio.ajarche.com');
  assert.equal(started.options.userVerification, 'required');
  assert.equal(calls.signInOptions[0].allowCredentials, undefined);
  assert.equal(calls.signInOptions[0].timeout, 60_000);
  assert.equal(await codeOf(service.passkeySignInOptions('https://evil.example', CLIENT)), '403 AUTH_PASSKEY_ORIGIN');
  assert.equal(await codeOf(service.passkeySignInOptions(undefined, CLIENT)), '403 AUTH_PASSKEY_ORIGIN');
});

test('a verified assertion signs in, stores the new counter and is checked with user verification', async () => {
  const { start, finish, store, calls, issued } = createHarness();
  const session = await finish(PUBLIC_ORIGIN, await start(PUBLIC_ORIGIN), 'cred-public');
  assert.equal(session.token, 'passkey-token');
  assert.deepEqual((issued as { id: number; username: string; sessionId?: string }[]).map(({ id, username }) => ({ id, username })), [OWNER]);
  // A new sign-in starts a new session.
  assert.ok((issued[0] as { sessionId?: string }).sessionId);
  const verifyOptions = calls.verifyAuthentication[0] as { requireUserVerification: boolean; expectedOrigin: string; expectedRPID: string; credential: { counter: number } };
  assert.equal(verifyOptions.requireUserVerification, true);
  assert.equal(verifyOptions.expectedOrigin, PUBLIC_ORIGIN);
  assert.equal(verifyOptions.expectedRPID, 'studio.ajarche.com');
  assert.equal(verifyOptions.credential.counter, 3);
  const row = store.passkeys.findByCredentialId('cred-public');
  assert.equal(row?.counter, 7);
  assert.ok(row?.last_used_at);
});

test('a ceremony is single-use, expires after 60 s, and needs its own id and challenge', async () => {
  const { start, finish, service, clock } = createHarness();
  const started = await start(PUBLIC_ORIGIN);
  assert.equal(await codeOf(finish(PUBLIC_ORIGIN, started, 'cred-public')), 'ok');
  assert.equal(await codeOf(finish(PUBLIC_ORIGIN, started, 'cred-public')), '401 AUTH_PASSKEY_FAILED');

  const late = await start(PUBLIC_ORIGIN);
  clock.now += 60_001;
  assert.equal(await codeOf(finish(PUBLIC_ORIGIN, late, 'cred-public')), '401 AUTH_PASSKEY_FAILED');

  // Another ceremony's challenge under this id, or no id at all, is refused.
  const first = await start(PUBLIC_ORIGIN);
  const second = await start(PUBLIC_ORIGIN);
  assert.equal(await codeOf(finish(PUBLIC_ORIGIN, { ...first, options: second.options }, 'cred-public')), '401 AUTH_PASSKEY_FAILED');
  assert.equal(await codeOf(service.signInWithPasskey({ origin: PUBLIC_ORIGIN, ceremonyId: undefined, response: assertion('cred-public', second.options.challenge), client: CLIENT })), '401 AUTH_PASSKEY_FAILED');
});

test('reproduction: no flood of options requests can evict, fill up or block anybody\'s sign-in', async () => {
  const { start, finish } = createHarness();
  const ownerTailnet = await start(TAILNET_ORIGIN, OWNER_DEVICE);
  const ownerPublic = await start(PUBLIC_ORIGIN, { door: 'cloudflare', address: '203.0.113.200' });
  // 2000 options requests from 500 public /64s: nothing is stored, so nothing is refused or lost.
  for (let index = 0; index < 2000; index += 1) {
    assert.equal(await codeOf(start(PUBLIC_ORIGIN, { door: 'cloudflare', address: `2001:db8:${index % 500}:1::/64` })), 'ok');
  }
  assert.equal(await codeOf(finish(TAILNET_ORIGIN, ownerTailnet, 'cred-tailnet', OWNER_DEVICE)), 'ok');
  assert.equal(await codeOf(finish(PUBLIC_ORIGIN, ownerPublic, 'cred-public', { door: 'cloudflare', address: '198.51.100.99' })), 'ok');
});

test('a ceremony token cannot be forged, altered or replayed', async () => {
  const { start, finish, service } = createHarness();
  const started = await start(PUBLIC_ORIGIN);
  const [payload, signature] = started.ceremonyId.split('.');
  // Moving the ceremony to another door means changing the signed payload.
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown[];
  const forgedPayload = Buffer.from(JSON.stringify([decoded[0], 'tailnet', decoded[2], decoded[3]])).toString('base64url');
  assert.equal(await codeOf(finish(PUBLIC_ORIGIN, { ...started, ceremonyId: `${forgedPayload}.${signature}` }, 'cred-public', OWNER_DEVICE)), '401 AUTH_PASSKEY_FAILED');
  assert.equal(await codeOf(finish(PUBLIC_ORIGIN, { ...started, ceremonyId: `${payload}.${'A'.repeat(43)}` }, 'cred-public')), '401 AUTH_PASSKEY_FAILED');
  // Another process's key signs differently (a restart forgets pending sign-ins, nothing more).
  const other = createHarness();
  assert.equal(await codeOf(other.finish(PUBLIC_ORIGIN, started, 'cred-public')), '401 AUTH_PASSKEY_FAILED');
  // The genuine token works once; the same challenge cannot come back.
  assert.equal(await codeOf(finish(PUBLIC_ORIGIN, started, 'cred-public')), 'ok');
  assert.equal(await codeOf(service.signInWithPasskey({ origin: PUBLIC_ORIGIN, ceremonyId: started.ceremonyId, response: assertion('cred-public', started.options.challenge), client: CLIENT })), '401 AUTH_PASSKEY_FAILED');
});

test('a passkey only works for its own RP ID, and a ceremony only on the door and origin that started it', async () => {
  const { start, finish, calls } = createHarness();
  // Tailnet ceremony, but the public domain's passkey.
  assert.equal(await codeOf(finish(TAILNET_ORIGIN, await start(TAILNET_ORIGIN, OWNER_DEVICE), 'cred-public', OWNER_DEVICE)), '401 AUTH_PASSKEY_FAILED');
  // A public ceremony replayed on the tailnet origin, or from the tailnet door.
  const fromPublic = await start(PUBLIC_ORIGIN);
  assert.equal(await codeOf(finish(TAILNET_ORIGIN, fromPublic, 'cred-tailnet', CLIENT)), '401 AUTH_PASSKEY_FAILED');
  const again = await start(PUBLIC_ORIGIN);
  assert.equal(await codeOf(finish(PUBLIC_ORIGIN, again, 'cred-public', OWNER_DEVICE)), '401 AUTH_PASSKEY_FAILED');
  // None reached signature verification.
  assert.equal(calls.verifyAuthentication.length, 0);
});

test('unknown credentials, a foreign user handle, a counter that went backwards and missing user verification are all refused alike', async () => {
  const { start, finish, service, behaviour, events } = createHarness();
  let attempts = 0;
  // A different client each time: refusals are logged once per client per minute.
  const attempt = async (credentialId: string, userHandle?: string) => {
    attempts += 1;
    const client = { door: 'cloudflare', address: `203.0.113.${attempts}` } as const;
    return codeOf(finish(PUBLIC_ORIGIN, await start(PUBLIC_ORIGIN, client), credentialId, client, userHandle));
  };
  assert.equal(await attempt('cred-unknown'), '401 AUTH_PASSKEY_FAILED');
  assert.equal(await attempt('cred-public', Buffer.from('studio-signin-99').toString('base64url')), '401 AUTH_PASSKEY_FAILED');
  behaviour.throws = true;
  assert.equal(await attempt('cred-public'), '401 AUTH_PASSKEY_FAILED');
  behaviour.throws = false;
  behaviour.userVerified = false;
  assert.equal(await attempt('cred-public'), '401 AUTH_PASSKEY_FAILED');
  assert.equal(await codeOf(service.signInWithPasskey({ origin: PUBLIC_ORIGIN, ceremonyId: 'x', response: { nonsense: true }, client: CLIENT })), '401 AUTH_PASSKEY_FAILED');
  assert.deepEqual(events.recent(10).map((event) => event.detail).reverse(),
    ['credential-unknown', 'user-mismatch', 'verification-failed', 'verification-failed', 'malformed']);
});

test('every anonymous refusal is logged once per client per minute, not once each', async () => {
  const { service, events, logs, clock, start, finish } = createHarness();
  // Unknown credentials with genuine ceremonies count against the same gate.
  for (let index = 0; index < 5; index += 1) await codeOf(finish(PUBLIC_ORIGIN, await start(PUBLIC_ORIGIN), 'cred-unknown'));
  const junk = (client: StudioRequestClient) => codeOf(service.signInWithPasskey({ origin: PUBLIC_ORIGIN, ceremonyId: 'nope', response: {}, client }));
  for (let index = 0; index < 50; index += 1) await junk(CLIENT);
  await junk({ door: 'cloudflare', address: '203.0.113.77' });
  assert.equal(events.recent(100).filter((event) => event.type === 'passkey-signin-failed').length, 2);
  assert.equal(logs.filter((line) => line.includes('Passkey sign-in refused')).length, 2);
  clock.now += 60_000;
  await junk(CLIENT);
  assert.equal(events.recent(100).filter((event) => event.type === 'passkey-signin-failed').length, 3);
});

test('passkey sign-in works while password sign-in is locked, and lifts that door\'s lock', async () => {
  const { start, finish, service, lockout } = createHarness();
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await codeOf(service.login(OWNER.username, 'wrong', { door: 'cloudflare', address: `203.0.113.${attempt}` }));
  }
  assert.equal(lockout.status(OWNER.username, 'public').locked, true);
  assert.equal(await codeOf(finish(PUBLIC_ORIGIN, await start(PUBLIC_ORIGIN), 'cred-public')), 'ok');
  assert.equal(lockout.status(OWNER.username, 'public').locked, false);
});

test('registering a sign-in passkey needs the current password before any challenge is issued', async () => {
  const { security, passkeys, events } = createHarness();
  // No challenge without the step-up, so the registration itself cannot be completed.
  assert.equal(await codeOf(security.registerPasskey(OWNER, { response: registration('cred-new'), origin: TAILNET_ORIGIN, userAgent: 'iPhone', client: CLIENT })), '400 AUTH_PASSKEY_EXPIRED');
  assert.equal(await codeOf(security.passkeyRegistrationOptions(OWNER, { password: 'wrong', origin: TAILNET_ORIGIN, client: CLIENT })), '403 AUTH_STEP_UP_FAILED');
  assert.equal(await codeOf(security.passkeyRegistrationOptions(OWNER, { password: '', origin: TAILNET_ORIGIN, client: CLIENT })), '400 AUTH_STEP_UP_REQUIRED');
  assert.equal(await codeOf(security.registerPasskey(OWNER, { response: registration('cred-new'), origin: TAILNET_ORIGIN, userAgent: 'iPhone', client: CLIENT })), '400 AUTH_PASSKEY_EXPIRED');

  const options = await security.passkeyRegistrationOptions(OWNER, { password: PASSWORD, origin: TAILNET_ORIGIN, client: CLIENT }) as {
    rp: { id: string }; authenticatorSelection: { residentKey: string; userVerification: string };
  };
  assert.equal(options.rp.id, 'laptop-acgghbuq.tail6e45f0.ts.net');
  assert.deepEqual(options.authenticatorSelection, { residentKey: 'required', userVerification: 'required' });
  const added = await security.registerPasskey(OWNER, { response: registration('cred-new'), origin: TAILNET_ORIGIN, userAgent: 'Mozilla/5.0 (iPhone)', client: CLIENT });
  assert.equal(added.rpId, 'laptop-acgghbuq.tail6e45f0.ts.net');
  assert.equal(added.label, 'iPhone');
  assert.equal(passkeys.list(OWNER.id).length, 3);
  // The registration challenge was single-use too.
  assert.equal(await codeOf(security.registerPasskey(OWNER, { response: registration('cred-other'), origin: TAILNET_ORIGIN, userAgent: undefined, client: CLIENT })), '400 AUTH_PASSKEY_EXPIRED');
  assert.ok(events.recent(10).some((event) => event.type === 'step-up-failed'));
  assert.ok(events.recentImportant(10).some((event) => event.type === 'passkey-added'));
});

test('removing a sign-in passkey needs the password; the overview lists passkeys, events, locks and doors', async () => {
  const { security } = createHarness();
  const id = '00000000-0000-4000-8000-000000000001';
  assert.equal(await codeOf(security.removePasskey(OWNER, { id, password: 'wrong', client: CLIENT })), '403 AUTH_STEP_UP_FAILED');
  assert.equal(security.overview(OWNER).passkeys.length, 2);
  assert.equal(await codeOf(security.removePasskey(OWNER, { id: '../etc', password: PASSWORD, client: CLIENT })), '404 AUTH_PASSKEY_NOT_FOUND');
  assert.equal(await codeOf(security.removePasskey(OWNER, { id, password: PASSWORD, client: CLIENT })), 'ok');
  const overview = security.overview(OWNER);
  assert.deepEqual(overview.passkeys.map((passkey) => passkey.rpId), ['laptop-acgghbuq.tail6e45f0.ts.net']);
  assert.deepEqual(overview.passkeyOrigins, [PUBLIC_ORIGIN, TAILNET_ORIGIN]);
  assert.deepEqual(overview.passwordLocks.public, { locked: false, lockedUntil: null });
  assert.deepEqual(overview.events.map((event) => event.type).slice(0, 2), ['passkey-removed', 'step-up-failed']);
  assert.deepEqual(overview.importantEvents.map((event) => event.type), ['passkey-removed']);
});

test('sign out everywhere bumps the token version, tells the listeners and says what it revoked', () => {
  const { security, store, revoked, events } = createHarness();
  assert.equal(store.sessionVersions.current(OWNER.id), 0);
  const result = security.revokeAllSessions(OWNER, CLIENT);
  security.revokeAllSessions(OWNER, CLIENT);
  assert.equal(store.sessionVersions.current(OWNER.id), 2);
  assert.deepEqual(revoked, [OWNER.id, OWNER.id]);
  assert.deepEqual(result.revoked, { sessions: true, webSockets: 2, apiKeys: 1, snrAccess: 0, pushSubscriptions: 0, handoffCodes: 0 });
  const important = events.recentImportant(4);
  assert.deepEqual(important.map((event) => event.type), ['api-keys-revoked', 'sessions-revoked', 'api-keys-revoked', 'sessions-revoked']);
  assert.equal(important[1].detail, '所有会话 · 连接 2 · API 密钥 1');
  assert.equal(important[1].client, '198.51.*.*');
});

test('the event log keeps important events apart from a flood of noise', () => {
  const database = new Database(':memory:');
  const store = createAuthSecurityStore(database);
  const events = createSecurityEventLog({ store: store.events });
  events.record({ type: 'passkey-added', detail: 'studio.ajarche.com' });
  for (let index = 0; index < 1200; index += 1) events.record({ type: 'login-failed', detail: `attempt ${index}\u0000` });
  const count = (database.prepare('SELECT COUNT(*) AS count FROM auth_security_events').get() as { count: number }).count;
  assert.equal(count, 501);
  assert.equal(events.recent(1)[0].detail, 'attempt 1199?');
  assert.equal(events.recent(1000).length, 100);
  assert.deepEqual(events.recentImportant(5).map((event) => event.detail), ['studio.ajarche.com']);
});

test('sign out everywhere also forgets every session\'s step-up lock and the daily count', async () => {
  const { service, security, lockout, store } = createHarness();
  const stolen = Object.defineProperty({ ...OWNER }, 'sessionId', { value: 'stolen-session' });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(await codeOf(service.verifyStepUpPassword(stolen, 'guess', CLIENT)), '403 AUTH_STEP_UP_FAILED');
  }
  assert.equal(lockout.status(OWNER.username, 'session', 'stolen-session').locked, true);
  assert.equal(store.stepUpFailures.countSince(OWNER.username, 0).count, 5);
  security.revokeAllSessions(OWNER, CLIENT);
  assert.equal(lockout.status(OWNER.username, 'session', 'stolen-session').locked, false);
  // The per-user daily count is reset only here (and by the local script).
  assert.equal(store.stepUpFailures.countSince(OWNER.username, 0).count, 0);
});
