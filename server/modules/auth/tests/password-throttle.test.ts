import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { AppError, readStudioIngressOrigins } from '@/shared/utils.js';

import { createAuthRouter } from '../auth.routes.js';
import { createAuthService } from '../auth.service.js';
import { createClientThrottle } from '../client-throttle.service.js';
import { createHandoffCodeStore } from '../handoff.service.js';
import { parseTailscaleSignInConfig } from '../tailscale-session.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];

const OWNER = { id: 1, username: 'andrew' };
const OWNER_SESSION = { login: 'owner@example.com', node: '100.101.102.103' };
const PASSWORD = 'correct horse battery staple';
const TAILNET_CLIENT = { door: 'direct', address: '127.0.0.1' } as const;
const publicClient = (address: string) => ({ door: 'cloudflare', address }) as const;

function createHarness() {
  const clock = { now: 1_000_000 };
  const logs: string[] = [];
  let compared = 0;
  const env = {
    STUDIO_PUBLIC_ORIGIN: 'https://studio.ajarche.com',
    STUDIO_TAILNET_ORIGIN: 'https://laptop-acgghbuq.tail6e45f0.ts.net:8443',
    STUDIO_TAILSCALE_LOGINS: OWNER_SESSION.login,
  };
  const dependencies: AuthDependencies = {
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: (username) => (username === OWNER.username ? { ...OWNER, password_hash: 'hash' } : undefined),
      updateLastLogin: () => undefined,
      countActiveUsers: () => 1,
      getFirstUser: () => OWNER,
    },
    transaction: { begin: () => undefined, commit: () => undefined, rollback: () => undefined },
    hashPassword: async () => 'hash',
    comparePassword: async (password) => {
      compared += 1;
      return password === PASSWORD;
    },
    generateToken: () => 'token',
    tailscaleSignIn: () => parseTailscaleSignInConfig(env),
    handoffCodes: createHandoffCodeStore({ now: () => clock.now }),
    ingressOrigins: () => readStudioIngressOrigins(env),
    logInfo: (message) => logs.push(message),
    now: () => clock.now,
  };
  return { service: createAuthService(dependencies), clock, logs, compared: () => compared };
}

function isAppError(code: string, statusCode: number) {
  return (error: unknown) => error instanceof AppError && error.code === code && error.statusCode === statusCode;
}

test('wrong login passwords are throttled per client, before the password is compared', async () => {
  const harness = createHarness();
  const attacker = publicClient('198.51.100.7');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(harness.service.login('andrew', 'guess', attacker), isAppError('AUTH_INVALID_CREDENTIALS', 401));
  }
  const comparedBefore = harness.compared();
  // Blocked: even the right password is refused, and bcrypt is not run for it.
  await assert.rejects(harness.service.login('andrew', PASSWORD, attacker), isAppError('AUTH_RATE_LIMITED', 429));
  assert.equal(harness.compared(), comparedBefore);
  assert.match(harness.logs.at(-1) ?? '', /Login refused \(rate-limited, cloudflare door\)/);
  // Unknown usernames count as well, and other clients are unaffected.
  await assert.rejects(harness.service.login('nobody', 'guess', attacker), isAppError('AUTH_RATE_LIMITED', 429));
  assert.equal((await harness.service.login('andrew', PASSWORD, publicClient('203.0.113.9'))).success, true);

  harness.clock.now += 10 * 60_000;
  assert.equal((await harness.service.login('andrew', PASSWORD, attacker)).success, true);
});

test('parallel guesses cannot slip past the limit while bcrypt runs', async () => {
  const harness = createHarness();
  const attacker = publicClient('198.51.100.7');
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => harness.service.login('andrew', 'guess', attacker)));
  const codes = results.map(result => (result.status === 'rejected' && result.reason instanceof AppError ? result.reason.code : 'ok'));
  assert.equal(codes.filter(code => code === 'AUTH_INVALID_CREDENTIALS').length, 5);
  assert.equal(codes.filter(code => code === 'AUTH_RATE_LIMITED').length, 7);
  assert.equal(harness.compared(), 5);
});

test('successful logins do not use up the door total', async () => {
  const harness = createHarness();
  for (let index = 0; index < 30; index += 1) {
    assert.equal((await harness.service.login('andrew', PASSWORD, publicClient(`203.0.113.${index}`))).success, true);
  }
  await assert.rejects(harness.service.login('andrew', 'guess', publicClient('192.0.2.1')), isAppError('AUTH_INVALID_CREDENTIALS', 401));
});

test('the public door has a total, which never blocks logins through the tailnet door', async () => {
  const harness = createHarness();
  // 20 wrong passwords from 20 addresses (4 each from 5 addresses would do the same).
  for (let index = 0; index < 20; index += 1) {
    await assert.rejects(harness.service.login('andrew', 'guess', publicClient(`203.0.113.${index}`)), isAppError('AUTH_INVALID_CREDENTIALS', 401));
  }
  await assert.rejects(harness.service.login('andrew', PASSWORD, publicClient('192.0.2.1')), isAppError('AUTH_RATE_LIMITED', 429));
  assert.equal((await harness.service.login('andrew', PASSWORD, TAILNET_CLIENT)).success, true);
});

test('a successful login clears that client\'s own count', async () => {
  const harness = createHarness();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assert.rejects(harness.service.login('andrew', 'typo', TAILNET_CLIENT), isAppError('AUTH_INVALID_CREDENTIALS', 401));
  }
  assert.equal((await harness.service.login('andrew', PASSWORD, TAILNET_CLIENT)).success, true);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assert.rejects(harness.service.login('andrew', 'typo', TAILNET_CLIENT), isAppError('AUTH_INVALID_CREDENTIALS', 401));
  }
  assert.equal((await harness.service.login('andrew', PASSWORD, TAILNET_CLIENT)).success, true);
});

test('the handoff password has its own per-user budget, which wrong logins never use up', async () => {
  const harness = createHarness();
  // A flood of wrong logins on the tailnet door uses up that door's sign-in budget...
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(harness.service.login('andrew', 'guess', TAILNET_CLIENT), isAppError('AUTH_INVALID_CREDENTIALS', 401));
  }
  await assert.rejects(harness.service.login('andrew', PASSWORD, TAILNET_CLIENT), isAppError('AUTH_RATE_LIMITED', 429));
  // ...but the signed-in owner can still move to the public door with the password.
  const ticket = await harness.service.issueHandoff(OWNER, OWNER_SESSION, { target: 'public', password: PASSWORD, client: TAILNET_CLIENT });
  assert.equal(ticket.target, 'public');
  // Wrong handoff passwords are limited on their own: five, then 429.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      harness.service.issueHandoff(OWNER, OWNER_SESSION, { target: 'public', password: 'guess', client: TAILNET_CLIENT }),
      isAppError('AUTH_INVALID_CREDENTIALS', 401),
    );
  }
  await assert.rejects(
    harness.service.issueHandoff(OWNER, OWNER_SESSION, { target: 'public', password: PASSWORD, client: TAILNET_CLIENT }),
    isAppError('AUTH_HANDOFF_RATE_LIMITED', 429),
  );
});

test('the client throttle keeps door totals when it evicts clients', () => {
  const clock = { now: 0 };
  const throttle = createClientThrottle({ now: () => clock.now, windowMs: 1000, perClient: 2, perDoor: 5, maxClients: 2 });
  for (const address of ['a', 'b', 'c', 'd', 'e']) {
    throttle.record(publicClient(address));
  }
  // Only two clients are remembered, but the door total of five still blocks a new address.
  assert.equal(throttle.isBlocked(publicClient('f')), true);
  assert.equal(throttle.isBlocked(TAILNET_CLIENT), false);
  clock.now = 1000;
  assert.equal(throttle.isBlocked(publicClient('f')), false);
});

test('the routes count logins by CF-Connecting-IP through Cloudflare and by socket otherwise', async () => {
  const harness = createHarness();
  const app = express();
  app.use(express.json());
  app.use(createAuthRouter(harness.service, (_req, _res, next) => next()));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    res.status(appError?.statusCode ?? 500).json({ error: { code: appError?.code, message: appError?.message } });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const login = async (password: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ username: 'andrew', password }),
    });
    return { status: response.status, body: await response.json() as { error?: { code?: string; message?: string } } };
  };
  const viaCloudflare = (address: string) => ({ 'CF-Ray': '8c1f2e3d4a5b6c7d-HKG', 'CF-Connecting-IP': address });

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await login('guess', viaCloudflare('198.51.100.7'))).status, 401);
    }
    const blocked = await login(PASSWORD, viaCloudflare('198.51.100.7'));
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error?.code, 'AUTH_RATE_LIMITED');
    assert.match(blocked.body.error?.message ?? '', /10 分钟/);
    // A forged X-Forwarded-For does not change the bucket; another edge address or the socket does.
    assert.equal((await login(PASSWORD, { ...viaCloudflare('198.51.100.7'), 'X-Forwarded-For': '192.0.2.44' })).status, 429);
    assert.equal((await login(PASSWORD, viaCloudflare('203.0.113.9'))).status, 200);
    assert.equal((await login(PASSWORD)).status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('the redeem route buckets by door, so a public flood leaves tailnet switches working', async () => {
  const harness = createHarness();
  const app = express();
  app.use(express.json());
  app.use(createAuthRouter(harness.service, (req, _res, next) => {
    Object.assign(req, { user: OWNER });
    next();
  }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    res.status(appError?.statusCode ?? 500).json({ error: { code: appError?.code } });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  try {
    // 30 malformed junk attempts from rotating public addresses exhaust the public door's total.
    for (let index = 0; index < 30; index += 1) {
      const junk = await post('/handoff/redeem', { code: 'junk' }, { 'CF-Ray': 'r', 'CF-Connecting-IP': `203.0.113.${index}` });
      assert.equal(junk.status, 400);
    }
    const flooded = await post('/handoff/redeem', { code: 'junk' }, { 'CF-Ray': 'r', 'CF-Connecting-IP': '192.0.2.1' });
    assert.equal(flooded.status, 429);

    const ticket = await post('/handoff', { target: 'tailnet' });
    const redeemed = await post('/handoff/redeem', { code: ticket.body.code }, { Origin: 'https://laptop-acgghbuq.tail6e45f0.ts.net:8443' });
    assert.equal(redeemed.status, 200);
    assert.match(harness.logs.find((line) => line.includes('rate-limited')) ?? '', /cloudflare door/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
