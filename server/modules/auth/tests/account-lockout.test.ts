import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import type { StudioRequestClient } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createAccountLockout, lockDurationMs } from '../account-lockout.service.js';
import { createAuthSecurityStore } from '../auth-security.store.js';
import { createAuthService } from '../auth.service.js';
import { createHandoffCodeStore } from '../handoff.service.js';
import { createSecurityEventLog } from '../security-events.service.js';
import { parseTailscaleSignInConfig } from '../tailscale-session.service.js';

const MINUTE = 60_000;
const OWNER = { id: 1, username: 'andrew' };
const PASSWORD = 'correct horse battery staple';
const TIMING_HASH = 'timing-hash';
// Each guess from its own address, so the per-client throttle (5 per address) never answers
// first: this is the distributed guesser the account lockout exists for.
const publicClient = (index: number): StudioRequestClient => ({ door: 'cloudflare', address: `203.0.113.${index}` });

function createLockout(database = new Database(':memory:'), clock = { now: 1_000_000 }, accounts = [OWNER.username]) {
  const store = createAuthSecurityStore(database);
  const lockout = createAccountLockout({
    store: store.lockouts,
    isAccount: (key) => accounts.includes(key),
    now: () => clock.now,
    maxTrackedKeys: 8,
  });
  return { store, lockout, clock };
}

// The real lockout and event log on an in-memory database behind the real auth service; only
// bcrypt, users and tokens are faked.
function createHarness(database = new Database(':memory:'), clock = { now: 1_000_000 }) {
  const { store, lockout } = createLockout(database, clock);
  const events = createSecurityEventLog({ store: store.events, now: () => clock.now });
  const compared: string[] = [];
  const env = {
    STUDIO_TAILSCALE_LOGINS: 'owner@example.com',
    STUDIO_TAILNET_ORIGIN: 'https://laptop-acgghbuq.tail6e45f0.ts.net:8443',
  };
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
    comparePassword: async (password, hash) => {
      compared.push(hash);
      return hash === 'owner-hash' && password === PASSWORD;
    },
    generateToken: () => 'token',
    tailscaleSignIn: () => parseTailscaleSignInConfig(env),
    handoffCodes: createHandoffCodeStore({ now: () => clock.now }),
    ingressOrigins: () => ({ public: null, tailnet: env.STUDIO_TAILNET_ORIGIN, invalid: [] }),
    logInfo: () => undefined,
    now: () => clock.now,
    accountLockout: lockout,
    securityEvents: events,
    timingHash: TIMING_HASH,
  });
  return { service, lockout, events, store, clock, compared };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError);
    return { code: error.code, statusCode: error.statusCode, message: error.message };
  }
  assert.fail('expected a refusal');
}

test('locks double from 15 minutes and stop at 24 hours', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((level) => lockDurationMs(level) / MINUTE),
    [15, 30, 60, 120, 240, 480, 960, 1440, 1440]);
});

test('five wrong passwords in a row lock the account for every source, even with the right password', async () => {
  const { service, clock } = createHarness();
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.equal((await refusal(service.login(OWNER.username, 'wrong', publicClient(attempt)))).code, 'AUTH_INVALID_CREDENTIALS');
  }

  const locked = await refusal(service.login(OWNER.username, PASSWORD, publicClient(6)));
  assert.equal(locked.code, 'AUTH_ACCOUNT_LOCKED');
  assert.equal(locked.statusCode, 429);
  // The tailnet door is locked out of password sign-in too: the lock belongs to the account.
  assert.equal((await refusal(service.login(OWNER.username, PASSWORD, { door: 'tailnet', address: '100.101.102.103' }))).code, 'AUTH_ACCOUNT_LOCKED');

  clock.now += 15 * MINUTE + 1;
  const signedIn = await service.login(OWNER.username, PASSWORD, publicClient(7));
  assert.equal(signedIn.token, 'token');
});

test('the backoff doubles with each lock in a row and a successful sign-in resets it', async () => {
  const { service, lockout, clock } = createHarness();
  const lockOnce = async (offset: number) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await refusal(service.login(OWNER.username, 'wrong', publicClient(offset + attempt)));
    }
    return lockout.status(OWNER.username);
  };

  let status = await lockOnce(10);
  assert.equal(status.lockedUntil, clock.now + 15 * MINUTE);
  clock.now += 15 * MINUTE + 1;
  status = await lockOnce(20);
  assert.equal(status.lockedUntil, clock.now + 30 * MINUTE);
  clock.now += 30 * MINUTE + 1;
  status = await lockOnce(30);
  assert.equal(status.lockedUntil, clock.now + 60 * MINUTE);
  clock.now += 60 * MINUTE + 1;

  await service.login(OWNER.username, PASSWORD, publicClient(40));
  assert.deepEqual(lockout.status(OWNER.username), { locked: false, lockedUntil: null, failures: 0, level: 0 });
  status = await lockOnce(50);
  assert.equal(status.lockedUntil, clock.now + 15 * MINUTE);
});

test('the lock survives a restart: a new process reads it back from SQLite', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'account-lockout-'));
  try {
    const file = path.join(directory, 'auth.db');
    const clock = { now: 5_000_000 };
    const first = new Database(file);
    const before = createHarness(first, clock);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await refusal(before.service.login(OWNER.username, 'wrong', publicClient(attempt)));
    }
    first.close();

    const second = new Database(file);
    const after = createHarness(second, clock);
    assert.equal((await refusal(after.service.login(OWNER.username, PASSWORD, publicClient(9)))).code, 'AUTH_ACCOUNT_LOCKED');
    assert.equal(after.lockout.status(OWNER.username).locked, true);
    second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an unknown username costs a bcrypt comparison, locks the same way and is refused in the same words', async () => {
  const { service, compared } = createHarness();
  const wrongPassword = await refusal(service.login(OWNER.username, 'wrong', publicClient(1)));
  const unknownUser = await refusal(service.login('mallory', 'wrong', publicClient(2)));
  assert.deepEqual(unknownUser, wrongPassword);
  // One comparison each: the account's hash, then the timing hash in place of a missing account.
  assert.deepEqual(compared, ['owner-hash', TIMING_HASH]);

  for (let attempt = 3; attempt <= 6; attempt += 1) {
    await refusal(service.login('mallory', 'wrong', publicClient(attempt)));
  }
  const lockedUnknown = await refusal(service.login('mallory', 'wrong', publicClient(7)));
  for (let attempt = 8; attempt <= 11; attempt += 1) {
    await refusal(service.login(OWNER.username, 'wrong', publicClient(attempt)));
  }
  const lockedOwner = await refusal(service.login(OWNER.username, 'wrong', publicClient(12)));
  assert.deepEqual(lockedUnknown, lockedOwner);
  assert.equal(lockedOwner.code, 'AUTH_ACCOUNT_LOCKED');
});

test('Tailscale sign-in on an owner device lifts the lock and logs it', async () => {
  const { service, lockout, events } = createHarness();
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await refusal(service.login(OWNER.username, 'wrong', publicClient(attempt)));
  }
  assert.equal(lockout.status(OWNER.username).locked, true);

  const session = service.signInWithTailscale({
    remoteAddress: '127.0.0.1',
    host: 'laptop-acgghbuq.tail6e45f0.ts.net:8443',
    origin: 'https://laptop-acgghbuq.tail6e45f0.ts.net:8443',
    fetchSite: 'same-origin',
    forwardedFor: '100.101.102.103',
    userLogin: 'owner@example.com',
    funnelRequest: undefined,
  });
  assert.equal(session.token, 'token');
  assert.equal(lockout.status(OWNER.username).locked, false);
  const types = events.recent(20).map((event) => event.type);
  assert.ok(types.includes('lockout-cleared'));
  assert.ok(types.includes('account-locked'));
  assert.equal(types.filter((type) => type === 'login-failed').length, 5);
  // Event clients are masked: never a full address.
  assert.ok(events.recent(20).every((event) => event.client === 'unknown' || event.client.endsWith('*')));
});

test('attempts still in flight count: a sixth parallel guess is refused before bcrypt runs', () => {
  const { lockout, clock } = createLockout();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(lockout.begin(OWNER.username), { allowed: true });
  }
  assert.equal(lockout.begin(OWNER.username).allowed, false);
  // Attempts that never reported back (the process stopped) settle as a lock instead of hanging.
  clock.now += 2 * MINUTE;
  const status = lockout.status(OWNER.username);
  assert.equal(status.level, 1);
  clock.now += 15 * MINUTE;
  assert.deepEqual(lockout.begin(OWNER.username), { allowed: true });
});

test('made-up usernames are evicted to stay bounded, the real account never is', () => {
  const { lockout, store, clock } = createLockout();
  for (let attempt = 0; attempt < 5; attempt += 1) lockout.begin(OWNER.username);
  lockout.fail(OWNER.username);
  for (let index = 0; index < 40; index += 1) {
    clock.now += 1;
    lockout.begin(`guess-${index}`);
  }
  assert.ok(store.lockouts.count() <= 8);
  assert.equal(lockout.status(OWNER.username).locked, true);
});

test('a quiet day after the last lock ended starts the schedule again at 15 minutes', () => {
  const { lockout, clock } = createLockout();
  const lock = () => {
    for (let attempt = 0; attempt < 5; attempt += 1) lockout.begin(OWNER.username);
    return lockout.fail(OWNER.username);
  };
  assert.equal((lock() as { durationMs: number }).durationMs, 15 * MINUTE);
  clock.now += 16 * MINUTE;
  assert.equal((lock() as { durationMs: number }).durationMs, 30 * MINUTE);
  clock.now += 30 * MINUTE + 25 * 60 * MINUTE;
  assert.equal((lock() as { durationMs: number }).durationMs, 15 * MINUTE);
});
