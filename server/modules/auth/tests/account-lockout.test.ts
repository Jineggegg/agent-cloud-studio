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
const TAILNET_ORIGIN = 'https://laptop-acgghbuq.tail6e45f0.ts.net:8443';
const PUBLIC_ORIGIN = 'https://studio.ajarche.com';
// Each guess from its own address, so the per-client throttle (5 per address) never answers
// first: this is the distributed guesser the account lockout exists for.
const publicClient = (index: number): StudioRequestClient => ({ door: 'cloudflare', address: `203.0.113.${index}` });
const OWNER_DEVICE: StudioRequestClient = { door: 'tailnet', address: '100.101.102.103' };

function createLockout(database = new Database(':memory:'), clock = { now: 1_000_000 }, accounts = [OWNER.username]) {
  const store = createAuthSecurityStore(database);
  const lockout = createAccountLockout({
    store: store.lockouts,
    isAccount: (username) => accounts.includes(username),
    now: () => clock.now,
    maxTrackedUnknown: 8,
  });
  return { store, lockout, clock };
}

// The real lockout and event log on an in-memory database behind the real auth service; only
// bcrypt, users and tokens are faked.
function createHarness(database = new Database(':memory:'), clock = { now: 1_000_000 }) {
  const { store, lockout } = createLockout(database, clock);
  const events = createSecurityEventLog({ store: store.events, now: () => clock.now });
  const compared: string[] = [];
  const env = { STUDIO_TAILSCALE_LOGINS: 'owner@example.com', STUDIO_TAILNET_ORIGIN: TAILNET_ORIGIN, STUDIO_PUBLIC_ORIGIN: PUBLIC_ORIGIN };
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
    ingressOrigins: () => ({ public: PUBLIC_ORIGIN, tailnet: TAILNET_ORIGIN, invalid: [] }),
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

async function lockPublicDoor(service: ReturnType<typeof createHarness>['service'], offset = 0, username = OWNER.username) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.equal((await refusal(service.login(username, 'wrong', publicClient(offset + attempt)))).code, 'AUTH_INVALID_CREDENTIALS');
  }
}

test('locks double from 15 minutes and stop at 24 hours', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((level) => lockDurationMs(level) / MINUTE),
    [15, 30, 60, 120, 240, 480, 960, 1440, 1440]);
});

test('five wrong passwords on the public door lock it for every public client, even with the right password', async () => {
  const { service, clock } = createHarness();
  await lockPublicDoor(service);
  const locked = await refusal(service.login(OWNER.username, PASSWORD, publicClient(6)));
  assert.equal(locked.code, 'AUTH_ACCOUNT_LOCKED');
  assert.equal(locked.statusCode, 429);
  // Anything not proven to be Tailscale counts as the public door.
  assert.equal((await refusal(service.login(OWNER.username, PASSWORD, { door: 'direct', address: '127.0.0.1' }))).code, 'AUTH_ACCOUNT_LOCKED');

  clock.now += 15 * MINUTE + 1;
  assert.equal((await service.login(OWNER.username, PASSWORD, publicClient(7))).token, 'token');
});

test('while the public password door is locked the owner can still sign in on the tailnet door, hand off and step up', async () => {
  const { service, lockout } = createHarness();
  await lockPublicDoor(service);

  // Password sign-in through Tailscale Serve has its own lock.
  assert.equal((await service.login(OWNER.username, PASSWORD, OWNER_DEVICE)).token, 'token');
  // A Tailscale session moves to the public door with the password: the session's own budget.
  const handoff = await service.issueHandoff(OWNER, { login: 'owner@example.com', node: '100.101.102.103' }, {
    target: 'public', password: PASSWORD, client: OWNER_DEVICE,
  });
  assert.equal(handoff.target, 'public');
  // On the public door, the signed-in session can step up (to enrol a public-door passkey).
  await service.verifyStepUpPassword(OWNER, PASSWORD, publicClient(40));
  // The internet guesser still finds the public password door locked.
  assert.equal((await refusal(service.login(OWNER.username, PASSWORD, publicClient(41)))).code, 'AUTH_ACCOUNT_LOCKED');
  assert.equal(lockout.status(OWNER.username, 'public').locked, true);
});

test('wrong step-up and handoff passwords have their own per-user budget and lock', async () => {
  const { service, events, clock } = createHarness();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await refusal(service.verifyStepUpPassword(OWNER, 'wrong', publicClient(attempt)))).code, 'AUTH_STEP_UP_FAILED');
  }
  const throttled = await refusal(service.verifyStepUpPassword(OWNER, PASSWORD, publicClient(9)));
  assert.equal(throttled.statusCode, 429);
  const handoff = await refusal(service.issueHandoff(OWNER, { login: 'owner@example.com', node: '100.101.102.103' }, {
    target: 'public', password: PASSWORD, client: OWNER_DEVICE,
  }));
  assert.equal(handoff.code, 'AUTH_HANDOFF_RATE_LIMITED');
  // Sign-in is not affected by the session budget.
  assert.equal((await service.login(OWNER.username, PASSWORD, publicClient(10))).token, 'token');
  assert.ok(events.recent(20).some((event) => event.type === 'account-locked' && event.detail?.startsWith('已登录会话')));

  clock.now += 15 * MINUTE + 1;
  await service.verifyStepUpPassword(OWNER, PASSWORD, publicClient(11));
});

test('the backoff doubles with each lock in a row and a successful sign-in resets it', async () => {
  const { service, lockout, clock } = createHarness();
  const lockOnce = async (offset: number) => {
    await lockPublicDoor(service, offset);
    return lockout.status(OWNER.username, 'public');
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
  assert.deepEqual(lockout.status(OWNER.username, 'public'), { locked: false, lockedUntil: null, failures: 0, level: 0 });
  status = await lockOnce(50);
  assert.equal(status.lockedUntil, clock.now + 15 * MINUTE);
});

test('the lock survives a restart: a new process reads it back from SQLite', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'account-lockout-'));
  try {
    const file = path.join(directory, 'auth.db');
    const clock = { now: 5_000_000 };
    const first = new Database(file);
    await lockPublicDoor(createHarness(first, clock).service);
    first.close();

    const second = new Database(file);
    const after = createHarness(second, clock);
    assert.equal((await refusal(after.service.login(OWNER.username, PASSWORD, publicClient(9)))).code, 'AUTH_ACCOUNT_LOCKED');
    assert.equal(after.lockout.status(OWNER.username, 'public').locked, true);
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

test('a flood of made-up names cannot evict a locked name, real or not, so locks look the same', () => {
  const { lockout, store, clock } = createLockout();
  const lock = (username: string) => {
    for (let attempt = 0; attempt < 5; attempt += 1) lockout.begin(username, 'public');
    return lockout.fail(username, 'public');
  };
  lock(OWNER.username);
  lock('mallory');
  for (let index = 0; index < 40; index += 1) {
    clock.now += 1;
    lockout.begin(`guess-${index}`, 'public');
  }
  // Only made-up names count against the cap, and eviction goes by age (a lock keeps a row young).
  assert.ok(store.lockouts.countUnknown() <= 8);
  const owner = lockout.status(OWNER.username, 'public');
  const mallory = lockout.status('mallory', 'public');
  assert.deepEqual({ ...mallory }, { ...owner });
  assert.equal(owner.locked, true);
});

test('Tailscale sign-in on an owner device lifts the tailnet lock only, and logs it', async () => {
  const { service, lockout, events } = createHarness();
  await lockPublicDoor(service);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await refusal(service.login(OWNER.username, 'wrong', { door: 'tailnet', address: `100.101.102.${attempt}` }));
  }
  assert.equal(lockout.status(OWNER.username, 'tailnet').locked, true);

  const session = service.signInWithTailscale({
    remoteAddress: '127.0.0.1',
    host: 'laptop-acgghbuq.tail6e45f0.ts.net:8443',
    origin: TAILNET_ORIGIN,
    fetchSite: 'same-origin',
    forwardedFor: '100.101.102.103',
    userLogin: 'owner@example.com',
    funnelRequest: undefined,
  });
  assert.equal(session.token, 'token');
  assert.equal(lockout.status(OWNER.username, 'tailnet').locked, false);
  // Tailscale sign-in runs on every app start; it must not keep reopening the public door.
  assert.equal(lockout.status(OWNER.username, 'public').locked, true);
  const types = events.recent(30).map((event) => event.type);
  assert.ok(types.includes('lockout-cleared'));
  assert.equal(events.recentImportant(10).filter((event) => event.type === 'account-locked').length, 2);
  // Event clients are masked: never a full address.
  assert.ok(events.recent(30).every((event) => event.client === 'unknown' || event.client.endsWith('*')));
});

test('attempts still in flight count: a sixth parallel guess is refused before bcrypt runs', () => {
  const { lockout, clock } = createLockout();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(lockout.begin(OWNER.username, 'public'), { allowed: true });
  }
  assert.equal(lockout.begin(OWNER.username, 'public').allowed, false);
  // Attempts that never reported back (the process stopped) settle as a lock instead of hanging.
  clock.now += 2 * MINUTE;
  assert.equal(lockout.status(OWNER.username, 'public').level, 1);
  clock.now += 15 * MINUTE;
  assert.deepEqual(lockout.begin(OWNER.username, 'public'), { allowed: true });
});

test('a quiet day after the last lock ended starts the schedule again at 15 minutes', () => {
  const { lockout, clock } = createLockout();
  const lock = () => {
    for (let attempt = 0; attempt < 5; attempt += 1) lockout.begin(OWNER.username, 'public');
    return lockout.fail(OWNER.username, 'public');
  };
  assert.equal((lock() as { durationMs: number }).durationMs, 15 * MINUTE);
  clock.now += 16 * MINUTE;
  assert.equal((lock() as { durationMs: number }).durationMs, 30 * MINUTE);
  clock.now += 30 * MINUTE + 25 * 60 * MINUTE;
  assert.equal((lock() as { durationMs: number }).durationMs, 15 * MINUTE);
});

test('a database created by the first security build opens: columns are added and old locks become public locks', () => {
  const database = new Database(':memory:');
  // The schema of commits 3cc167c..55d01c4: no is_account / important, unscoped lock rows.
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL);
    INSERT INTO users (id, username) VALUES (1, 'andrew');
    CREATE TABLE auth_login_lockouts (
      account_key TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_auth_login_lockouts_updated ON auth_login_lockouts(updated_at);
    CREATE TABLE auth_security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL, door TEXT NOT NULL,
      client TEXT NOT NULL, detail TEXT
    );
    INSERT INTO auth_security_events (at, type, door, client, detail) VALUES ('2026-10-01T00:00:00Z', 'account-locked', 'cloudflare', '198.51.*.*', 'old');
  `);
  const insert = database.prepare('INSERT INTO auth_login_lockouts VALUES (?, ?, ?, ?, ?)');
  insert.run('andrew', 0, 2, 1_000_000 + 30 * MINUTE, 1_000_000);
  insert.run('mallory', 3, 0, 0, 1_000_000);
  // A name that already has a scoped row keeps the scoped one.
  insert.run('public:eve', 1, 0, 0, 1_000_000);
  insert.run('eve', 4, 0, 0, 1_000_000);

  const { lockout, store } = createLockout(database);
  assert.deepEqual(lockout.status('andrew', 'public'), { locked: true, lockedUntil: 1_000_000 + 30 * MINUTE, failures: 0, level: 2 });
  assert.equal(lockout.status('mallory', 'public').failures, 3);
  assert.equal(lockout.status('eve', 'public').failures, 1);
  assert.equal(store.lockouts.get('public:andrew')?.is_account, 1);
  assert.equal(store.lockouts.get('public:mallory')?.is_account, 0);
  assert.equal(store.lockouts.countUnknown(), 2);
  const keys = (database.prepare('SELECT account_key FROM auth_login_lockouts ORDER BY account_key').all() as { account_key: string }[]).map((row) => row.account_key);
  assert.deepEqual(keys, ['public:andrew', 'public:eve', 'public:mallory']);
  // Events: the old row counts as an ordinary event, and new ones are recorded with classes.
  const events = createSecurityEventLog({ store: store.events });
  events.record({ type: 'passkey-added', detail: 'new' });
  assert.deepEqual(events.recentImportant(5).map((event) => event.detail), ['new']);
  assert.equal(events.recent(5).length, 2);
  // Opening it again changes nothing.
  createLockout(database);
  assert.equal(store.lockouts.countUnknown(), 2);
});

test('a stolen token can only lock its own step-ups; a sign-in or revoke-all forgets those locks', async () => {
  const { service, lockout } = createHarness();
  const stolen = Object.defineProperty({ ...OWNER }, 'sessionId', { value: 'stolen-session' });
  const owners = Object.defineProperty({ ...OWNER }, 'sessionId', { value: 'owner-session' });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await refusal(service.verifyStepUpPassword(stolen, 'guess', publicClient(attempt)))).code, 'AUTH_STEP_UP_FAILED');
  }
  assert.equal((await refusal(service.verifyStepUpPassword(stolen, PASSWORD, publicClient(9)))).statusCode, 429);
  assert.equal(lockout.status(OWNER.username, 'session', 'stolen-session').locked, true);
  // The owner's own session is untouched.
  await service.verifyStepUpPassword(owners, PASSWORD, OWNER_DEVICE);
  assert.equal(lockout.status(OWNER.username, 'session', 'owner-session').locked, false);
  // A sign-in that proves the owner forgets every session's step-up lock.
  await service.login(OWNER.username, PASSWORD, OWNER_DEVICE);
  assert.equal(lockout.status(OWNER.username, 'session', 'stolen-session').locked, false);
  assert.equal(lockout.clearScope(OWNER.username, 'session'), 0);
});

test('successful Tailscale and handoff sign-ins are recorded and kept apart from failed attempts', async () => {
  const { service, events } = createHarness();
  service.signInWithTailscale({
    remoteAddress: '127.0.0.1',
    host: 'laptop-acgghbuq.tail6e45f0.ts.net:8443',
    origin: TAILNET_ORIGIN,
    fetchSite: 'same-origin',
    forwardedFor: '100.101.102.103',
    userLogin: 'owner@example.com',
    funnelRequest: undefined,
  });
  const ticket = await service.issueHandoff(OWNER, undefined, { target: 'public', password: undefined, client: OWNER_DEVICE });
  service.redeemHandoff({ code: ticket.code, origin: PUBLIC_ORIGIN, client: publicClient(5) });
  await service.login(OWNER.username, PASSWORD, publicClient(6));
  for (let attempt = 0; attempt < 600; attempt += 1) events.record({ type: 'login-failed', detail: 'flood' });
  assert.deepEqual(events.recentSignIns(10).map((event) => event.type), ['login-succeeded', 'handoff-signin', 'tailscale-signin']);
  assert.equal(events.recentSignIns(10)[2].client, '100.101.*.*');
});
