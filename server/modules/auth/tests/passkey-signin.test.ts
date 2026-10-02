import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { AppError } from '@/shared/utils.js';

import { createAccountLockout } from '../account-lockout.service.js';
import { createAccountSecurityService } from '../account-security.service.js';
import { createAuthSecurityStore } from '../auth-security.store.js';
import { createAuthService } from '../auth.service.js';
import { createHandoffCodeStore } from '../handoff.service.js';
import { createPasskeyCeremonies } from '../passkey-signin.service.js';
import { createSecurityEventLog } from '../security-events.service.js';

type Ceremonies = Parameters<typeof createPasskeyCeremonies>[0];
type WebAuthnFakes = NonNullable<Ceremonies['webauthn']>;

const PUBLIC_ORIGIN = 'https://studio.ajarche.com';
const TAILNET_ORIGIN = 'https://laptop-acgghbuq.tail6e45f0.ts.net:8443';
const OWNER = { id: 1, username: 'andrew' };
const PASSWORD = 'correct horse battery staple';
const CLIENT = { door: 'cloudflare', address: '198.51.100.7' } as const;

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

function createHarness() {
  const clock = { now: 1_000_000 };
  const database = new Database(':memory:');
  const store = createAuthSecurityStore(database);
  let challengeCount = 0;
  const calls: { verifyAuthentication: Record<string, unknown>[]; signInOptions: Record<string, unknown>[] } = { verifyAuthentication: [], signInOptions: [] };
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
  });
  const lockout = createAccountLockout({ store: store.lockouts, isAccount: (key) => key === OWNER.username, now: () => clock.now });
  const events = createSecurityEventLog({ store: store.events, now: () => clock.now });
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
    logInfo: () => undefined,
    now: () => clock.now,
    accountLockout: lockout,
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
    sessionVersions: store.sessionVersions,
    onSessionsRevoked: (userId) => revoked.push(userId),
    logInfo: () => undefined,
  });
  // A sign-in passkey for the public door, as registration would have stored it.
  store.passkeys.insert({
    id: '00000000-0000-4000-8000-000000000001', user_id: OWNER.id, rp_id: 'studio.ajarche.com', credential_id: 'cred-public',
    public_key: Buffer.from([1]), counter: 3, transports: '["internal"]', label: 'iPad', created_at: new Date(clock.now).toISOString(), last_used_at: null,
  });
  return { service, security, passkeys, store, events, lockout, clock, calls, behaviour, issued, revoked };
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

test('sign-in options name no credential and require user verification on the door the page uses', async () => {
  const { service, calls } = createHarness();
  const options = await service.passkeySignInOptions(PUBLIC_ORIGIN) as { rpId: string; userVerification: string };
  assert.equal(options.rpId, 'studio.ajarche.com');
  assert.equal(options.userVerification, 'required');
  assert.equal(calls.signInOptions[0].allowCredentials, undefined);
  assert.equal(calls.signInOptions[0].timeout, 60_000);
  assert.equal(await codeOf(service.passkeySignInOptions('https://evil.example')), '403 AUTH_PASSKEY_ORIGIN');
  assert.equal(await codeOf(service.passkeySignInOptions(undefined)), '403 AUTH_PASSKEY_ORIGIN');
});

test('a verified assertion signs in, stores the new counter and is checked with user verification', async () => {
  const { service, store, calls, issued } = createHarness();
  const { challenge } = await service.passkeySignInOptions(PUBLIC_ORIGIN) as { challenge: string };
  const session = await service.signInWithPasskey({ origin: PUBLIC_ORIGIN, response: assertion('cred-public', challenge), client: CLIENT });
  assert.equal(session.token, 'passkey-token');
  assert.deepEqual(issued, [OWNER]);
  const verifyOptions = calls.verifyAuthentication[0] as { requireUserVerification: boolean; expectedOrigin: string; expectedRPID: string; credential: { counter: number } };
  assert.equal(verifyOptions.requireUserVerification, true);
  assert.equal(verifyOptions.expectedOrigin, PUBLIC_ORIGIN);
  assert.equal(verifyOptions.expectedRPID, 'studio.ajarche.com');
  assert.equal(verifyOptions.credential.counter, 3);
  const row = store.passkeys.findByCredentialId('cred-public');
  assert.equal(row?.counter, 7);
  assert.ok(row?.last_used_at);
});

test('a challenge is single-use', async () => {
  const { service } = createHarness();
  const { challenge } = await service.passkeySignInOptions(PUBLIC_ORIGIN) as { challenge: string };
  assert.equal(await codeOf(service.signInWithPasskey({ origin: PUBLIC_ORIGIN, response: assertion('cred-public', challenge) })), 'ok');
  assert.equal(await codeOf(service.signInWithPasskey({ origin: PUBLIC_ORIGIN, response: assertion('cred-public', challenge) })), '401 AUTH_PASSKEY_FAILED');
});

test('a challenge expires after 60 seconds', async () => {
  const { service, clock } = createHarness();
  const { challenge } = await service.passkeySignInOptions(PUBLIC_ORIGIN) as { challenge: string };
  clock.now += 60_001;
  assert.equal(await codeOf(service.signInWithPasskey({ origin: PUBLIC_ORIGIN, response: assertion('cred-public', challenge) })), '401 AUTH_PASSKEY_FAILED');
});

test('a passkey only works for its own RP ID, and a challenge only on the door that issued it', async () => {
  const { service, calls } = createHarness();
  // Challenge from the tailnet door, used on the tailnet door, but the passkey belongs to the public domain.
  const tailnet = await service.passkeySignInOptions(TAILNET_ORIGIN) as { challenge: string };
  assert.equal(await codeOf(service.signInWithPasskey({ origin: TAILNET_ORIGIN, response: assertion('cred-public', tailnet.challenge) })), '401 AUTH_PASSKEY_FAILED');
  // Challenge from the public door replayed on the tailnet door.
  const fromPublic = await service.passkeySignInOptions(PUBLIC_ORIGIN) as { challenge: string };
  assert.equal(await codeOf(service.signInWithPasskey({ origin: TAILNET_ORIGIN, response: assertion('cred-public', fromPublic.challenge) })), '401 AUTH_PASSKEY_FAILED');
  // Neither reached signature verification.
  assert.equal(calls.verifyAuthentication.length, 0);
});

test('unknown credentials, a foreign user handle, a counter that went backwards and missing user verification are all refused alike', async () => {
  const { service, behaviour, events } = createHarness();
  const attempt = async (credentialId: string, userHandle?: string) => {
    const { challenge } = await service.passkeySignInOptions(PUBLIC_ORIGIN) as { challenge: string };
    return codeOf(service.signInWithPasskey({ origin: PUBLIC_ORIGIN, response: assertion(credentialId, challenge, userHandle), client: CLIENT }));
  };
  assert.equal(await attempt('cred-unknown'), '401 AUTH_PASSKEY_FAILED');
  assert.equal(await attempt('cred-public', Buffer.from('studio-signin-99').toString('base64url')), '401 AUTH_PASSKEY_FAILED');
  behaviour.throws = true;
  assert.equal(await attempt('cred-public'), '401 AUTH_PASSKEY_FAILED');
  behaviour.throws = false;
  behaviour.userVerified = false;
  assert.equal(await attempt('cred-public'), '401 AUTH_PASSKEY_FAILED');
  assert.equal(await codeOf(service.signInWithPasskey({ origin: PUBLIC_ORIGIN, response: { nonsense: true } })), '401 AUTH_PASSKEY_FAILED');
  assert.deepEqual(events.recent(10).map((event) => event.detail).reverse(),
    ['credential-unknown', 'user-mismatch', 'verification-failed', 'verification-failed', 'malformed']);
});

test('passkey sign-in works while password sign-in is locked, and lifts the lock', async () => {
  const { service, lockout } = createHarness();
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await codeOf(service.login(OWNER.username, 'wrong', { door: 'cloudflare', address: `203.0.113.${attempt}` }));
  }
  assert.equal(lockout.status(OWNER.username).locked, true);
  const { challenge } = await service.passkeySignInOptions(PUBLIC_ORIGIN) as { challenge: string };
  assert.equal(await codeOf(service.signInWithPasskey({ origin: PUBLIC_ORIGIN, response: assertion('cred-public', challenge) })), 'ok');
  assert.equal(lockout.status(OWNER.username).locked, false);
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
  assert.deepEqual(passkeys.list(OWNER.id).map((item) => item.rpId).sort(), ['laptop-acgghbuq.tail6e45f0.ts.net', 'studio.ajarche.com']);
  // The registration challenge was single-use too.
  assert.equal(await codeOf(security.registerPasskey(OWNER, { response: registration('cred-other'), origin: TAILNET_ORIGIN, userAgent: undefined, client: CLIENT })), '400 AUTH_PASSKEY_EXPIRED');
  assert.ok(events.recent(10).some((event) => event.type === 'step-up-failed'));
  assert.ok(events.recent(10).some((event) => event.type === 'passkey-added'));
});

test('removing a sign-in passkey needs the password; the overview lists passkeys, events and doors', async () => {
  const { security } = createHarness();
  const id = '00000000-0000-4000-8000-000000000001';
  assert.equal(await codeOf(security.removePasskey(OWNER, { id, password: 'wrong', client: CLIENT })), '403 AUTH_STEP_UP_FAILED');
  assert.equal(security.overview(OWNER).passkeys.length, 1);
  assert.equal(await codeOf(security.removePasskey(OWNER, { id: '../etc', password: PASSWORD, client: CLIENT })), '404 AUTH_PASSKEY_NOT_FOUND');
  assert.equal(await codeOf(security.removePasskey(OWNER, { id, password: PASSWORD, client: CLIENT })), 'ok');
  const overview = security.overview(OWNER);
  assert.deepEqual(overview.passkeys, []);
  assert.deepEqual(overview.passkeyOrigins, [PUBLIC_ORIGIN, TAILNET_ORIGIN]);
  assert.deepEqual(overview.passwordLock, { locked: false, lockedUntil: null });
  assert.deepEqual(overview.events.map((event) => event.type).slice(0, 2), ['passkey-removed', 'step-up-failed']);
});

test('sign out everywhere bumps the token version and tells the listeners', () => {
  const { security, store, revoked, events } = createHarness();
  assert.equal(store.sessionVersions.current(OWNER.id), 0);
  security.revokeAllSessions(OWNER, CLIENT);
  security.revokeAllSessions(OWNER, CLIENT);
  assert.equal(store.sessionVersions.current(OWNER.id), 2);
  assert.deepEqual(revoked, [OWNER.id, OWNER.id]);
  assert.equal(events.recent(1)[0].type, 'sessions-revoked');
  assert.equal(events.recent(1)[0].client, '198.51.*.*');
});

test('the event log stays bounded', () => {
  const database = new Database(':memory:');
  const store = createAuthSecurityStore(database);
  const events = createSecurityEventLog({ store: store.events });
  for (let index = 0; index < 520; index += 1) events.record({ type: 'login-failed', detail: `attempt ${index}\u0000` });
  const count = (database.prepare('SELECT COUNT(*) AS count FROM auth_security_events').get() as { count: number }).count;
  assert.equal(count, 500);
  assert.equal(events.recent(1)[0].detail, 'attempt 519?');
  assert.equal(events.recent(1000).length, 100);
});
