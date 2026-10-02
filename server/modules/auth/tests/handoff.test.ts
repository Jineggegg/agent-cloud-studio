import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { AppError, readStudioIngressOrigins } from '@/shared/utils.js';

import { createAuthRouter } from '../auth.routes.js';
import { createAuthService } from '../auth.service.js';
import { createHandoffCodeStore } from '../handoff.service.js';
import { parseTailscaleSignInConfig } from '../tailscale-session.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];
type TailscaleSessionClaim = Parameters<AuthDependencies['generateToken']>[1];

const PUBLIC_ORIGIN = 'https://studio.ajarche.com';
const TAILNET_ORIGIN = 'https://laptop-acgghbuq.tail6e45f0.ts.net:8443';
const OWNER_LOGIN = 'owner@example.com';
const OWNER_SESSION = { login: OWNER_LOGIN, node: '100.101.102.103' };
const OWNER = { id: 1, username: 'andrew' };
const PASSWORD = 'correct horse battery staple';
// What auth.routes reports for a request through Tailscale Serve (loopback) and through Cloudflare.
const TAILNET_CLIENT = { door: 'direct', address: '127.0.0.1' } as const;
const publicClient = (address: string) => ({ door: 'cloudflare', address }) as const;

function createHarness(options: { env?: Record<string, string | undefined> } = {}) {
  const env: Record<string, string | undefined> = options.env ?? {
    STUDIO_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    STUDIO_TAILNET_ORIGIN: TAILNET_ORIGIN,
    STUDIO_TAILSCALE_LOGINS: OWNER_LOGIN,
  };
  const clock = { now: 1_000_000 };
  const users = [OWNER];
  const logs: string[] = [];
  const issuedFor: { user: { id: number | bigint; username: string }; session: TailscaleSessionClaim }[] = [];
  const dependencies: AuthDependencies = {
    users: {
      hasUsers: () => users.length > 0,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: (username) => {
        const user = users.find((candidate) => candidate.username === username);
        return user ? { ...user, password_hash: 'hash' } : undefined;
      },
      updateLastLogin: () => undefined,
      countActiveUsers: () => users.length,
      getFirstUser: () => users[0],
    },
    transaction: { begin: () => undefined, commit: () => undefined, rollback: () => undefined },
    hashPassword: async () => 'hash',
    comparePassword: async (password) => password === PASSWORD,
    generateToken: (user, session) => {
      issuedFor.push({ user, session });
      return `token-${issuedFor.length}`;
    },
    tailscaleSignIn: () => parseTailscaleSignInConfig(env),
    // Generous redemption limits: several tests redeem many codes from one client in a row.
    handoffCodes: createHandoffCodeStore({ now: () => clock.now, redeemAttemptsPerClient: 100, redeemAttemptsPerDoor: 100 }),
    ingressOrigins: () => readStudioIngressOrigins(env),
    logInfo: (message) => logs.push(message),
    now: () => clock.now,
  };
  return { service: createAuthService(dependencies), env, clock, users, logs, issuedFor };
}

function assertAppError(code: string, statusCode: number) {
  return (error: unknown) => error instanceof AppError && error.code === code && error.statusCode === statusCode;
}

test('the store issues 43-character base64url codes, each redeemable exactly once', () => {
  const store = createHandoffCodeStore();
  const grant = { userId: 1, username: 'andrew', target: 'public' as const, targetOrigin: PUBLIC_ORIGIN };
  const first = store.issue(grant);
  const second = store.issue(grant);
  assert.match(first.code, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.code, second.code);

  assert.deepEqual(store.redeem(first.code, TAILNET_CLIENT), { status: 'ok', grant });
  assert.deepEqual(store.redeem(first.code, TAILNET_CLIENT), { status: 'invalid' });
  for (const code of [undefined, 42, '', 'short', `${second.code}=`, 'A'.repeat(43)]) {
    assert.deepEqual(store.redeem(code, TAILNET_CLIENT), { status: 'invalid' });
  }
  assert.equal(store.redeem(second.code, TAILNET_CLIENT).status, 'ok');
});

test('codes expire after 60 seconds and the oldest is dropped beyond the pending limit', () => {
  const clock = { now: 0 };
  const store = createHandoffCodeStore({ now: () => clock.now, maxPending: 2 });
  const grant = { userId: 1, username: 'andrew', target: 'tailnet' as const, targetOrigin: TAILNET_ORIGIN };
  const expiring = store.issue(grant);
  assert.equal(expiring.expiresAt, 60_000);
  clock.now = 60_000;
  assert.deepEqual(store.redeem(expiring.code, TAILNET_CLIENT), { status: 'invalid' });

  const oldest = store.issue(grant);
  const middle = store.issue(grant);
  const newest = store.issue(grant);
  assert.deepEqual(store.redeem(oldest.code, TAILNET_CLIENT), { status: 'invalid' });
  assert.equal(store.redeem(middle.code, TAILNET_CLIENT).status, 'ok');
  assert.equal(store.redeem(newest.code, TAILNET_CLIENT).status, 'ok');
});

test('redemption attempts are rate limited per client and per door', () => {
  const clock = { now: 0 };
  const store = createHandoffCodeStore({
    now: () => clock.now,
    redeemAttemptsPerClient: 3,
    redeemAttemptsPerDoor: 5,
    redeemWindowMs: 10_000,
  });
  const { code } = store.issue({ userId: 1, username: 'andrew', target: 'public', targetOrigin: PUBLIC_ORIGIN });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(store.redeem('x'.repeat(43), TAILNET_CLIENT).status, 'invalid');
  }
  // Even the right code is refused while the window is exhausted, and it stays redeemable after.
  assert.equal(store.redeem(code, TAILNET_CLIENT).status, 'rate-limited');
  clock.now = 10_000;
  assert.equal(store.redeem(code, TAILNET_CLIENT).status, 'ok');
});

test('a flood through the public domain blocks neither tailnet switches nor, per client, others', () => {
  const store = createHandoffCodeStore({ redeemAttemptsPerClient: 3, redeemAttemptsPerDoor: 5 });
  const grant = { userId: 1, username: 'andrew', target: 'tailnet' as const, targetOrigin: TAILNET_ORIGIN };
  // One public client is cut off after its own budget, while another public client still gets in.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(store.redeem('x'.repeat(43), publicClient('198.51.100.7')).status, 'invalid');
  }
  assert.equal(store.redeem('x'.repeat(43), publicClient('198.51.100.7')).status, 'rate-limited');
  assert.equal(store.redeem(store.issue(grant).code, publicClient('203.0.113.9')).status, 'ok');
  // Many public addresses exhaust the public door's total...
  assert.equal(store.redeem('x'.repeat(43), publicClient('203.0.113.10')).status, 'invalid');
  assert.equal(store.redeem('x'.repeat(43), publicClient('203.0.113.11')).status, 'rate-limited');
  // ...but the tailnet door has its own budget, so the owner's switch still works.
  assert.equal(store.redeem(store.issue(grant).code, TAILNET_CLIENT).status, 'ok');
});

test('a password session moves to either door as a password session', async () => {
  for (const [target, origin] of [['public', PUBLIC_ORIGIN], ['tailnet', TAILNET_ORIGIN]] as const) {
    const harness = createHarness();
    const ticket = await harness.service.issueHandoff(OWNER, undefined, { target, password: undefined });
    assert.deepEqual(
      { target: ticket.target, origin: ticket.origin, expiresAt: ticket.expiresAt },
      { target, origin, expiresAt: new Date(1_060_000).toISOString() },
    );

    const session = harness.service.redeemHandoff({ code: ticket.code, origin });
    assert.deepEqual(session, { success: true, user: OWNER, token: 'token-1', target });
    assert.deepEqual(harness.issuedFor, [{ user: OWNER, session: undefined }]);
    // The code never appears in the log.
    assert.ok(harness.logs.every((line) => !line.includes(ticket.code)));
  }
});

test('a redeemed code cannot be replayed, and a wrong origin burns it', async () => {
  const harness = createHarness();
  const replayed = await harness.service.issueHandoff(OWNER, undefined, { target: 'public', password: undefined });
  harness.service.redeemHandoff({ code: replayed.code, origin: PUBLIC_ORIGIN });
  assert.throws(() => harness.service.redeemHandoff({ code: replayed.code, origin: PUBLIC_ORIGIN }), assertAppError('AUTH_HANDOFF_INVALID', 400));

  // Origin must be exactly the target door; the first wrong attempt consumes the code.
  for (const origin of [undefined, 'null', TAILNET_ORIGIN, 'https://attacker.example', 'http://studio.ajarche.com', 'not a url']) {
    const ticket = await harness.service.issueHandoff(OWNER, undefined, { target: 'public', password: undefined });
    assert.throws(() => harness.service.redeemHandoff({ code: ticket.code, origin }), assertAppError('AUTH_HANDOFF_INVALID', 400));
    assert.throws(() => harness.service.redeemHandoff({ code: ticket.code, origin: PUBLIC_ORIGIN }), assertAppError('AUTH_HANDOFF_INVALID', 400));
  }
  assert.ok(harness.logs.some((line) => line.includes('refused (origin-mismatch)')));
  // Origins compare after normalisation, so an explicit default port still matches.
  const ticket = await harness.service.issueHandoff(OWNER, undefined, { target: 'public', password: undefined });
  assert.equal(harness.service.redeemHandoff({ code: ticket.code, origin: 'https://studio.ajarche.com:443' }).success, true);
});

test('codes expire after 60 seconds', async () => {
  const harness = createHarness();
  const ticket = await harness.service.issueHandoff(OWNER, undefined, { target: 'tailnet', password: undefined });
  harness.clock.now += 60_000;
  assert.throws(() => harness.service.redeemHandoff({ code: ticket.code, origin: TAILNET_ORIGIN }), assertAppError('AUTH_HANDOFF_INVALID', 400));
});

test('a Tailscale session keeps its claim when it moves to the tailnet door', async () => {
  const harness = createHarness();
  const ticket = await harness.service.issueHandoff(OWNER, OWNER_SESSION, { target: 'tailnet', password: undefined });
  const session = harness.service.redeemHandoff({ code: ticket.code, origin: TAILNET_ORIGIN });
  assert.equal(session.success, true);
  assert.deepEqual(harness.issuedFor, [{ user: OWNER, session: OWNER_SESSION }]);
});

test('a Tailscale session needs the password to move to the public door and loses its claim', async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.service.issueHandoff(OWNER, OWNER_SESSION, { target: 'public', password: undefined }),
    assertAppError('AUTH_HANDOFF_PASSWORD_REQUIRED', 403),
  );
  await assert.rejects(
    harness.service.issueHandoff(OWNER, OWNER_SESSION, { target: 'public', password: 'wrong' }),
    assertAppError('AUTH_INVALID_CREDENTIALS', 401),
  );

  const ticket = await harness.service.issueHandoff(OWNER, OWNER_SESSION, { target: 'public', password: PASSWORD });
  harness.service.redeemHandoff({ code: ticket.code, origin: PUBLIC_ORIGIN });
  // Exactly what a password login on the public door would have issued: no Tailscale claim.
  assert.deepEqual(harness.issuedFor, [{ user: OWNER, session: undefined }]);
});

test('wrong handoff passwords are throttled', async () => {
  const harness = createHarness();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      harness.service.issueHandoff(OWNER, OWNER_SESSION, { target: 'public', password: 'wrong' }),
      assertAppError('AUTH_INVALID_CREDENTIALS', 401),
    );
  }
  await assert.rejects(
    harness.service.issueHandoff(OWNER, OWNER_SESSION, { target: 'public', password: PASSWORD }),
    assertAppError('AUTH_HANDOFF_RATE_LIMITED', 429),
  );
  harness.clock.now += 10 * 60_000;
  const ticket = await harness.service.issueHandoff(OWNER, OWNER_SESSION, { target: 'public', password: PASSWORD });
  assert.equal(ticket.target, 'public');
});

test('a claim revoked between issuing and redeeming refuses the handoff', async () => {
  const harness = createHarness();
  const ticket = await harness.service.issueHandoff(OWNER, OWNER_SESSION, { target: 'tailnet', password: undefined });
  harness.env.STUDIO_TAILSCALE_LOGINS = '';
  assert.throws(() => harness.service.redeemHandoff({ code: ticket.code, origin: TAILNET_ORIGIN }), assertAppError('AUTH_HANDOFF_INVALID', 400));
  assert.match(harness.logs.at(-1) ?? '', /refused \(tailscale-revoked\)/);
  assert.deepEqual(harness.issuedFor, []);
});

test('a deleted user or a reconfigured door refuses the handoff', async () => {
  const removed = createHarness();
  const forRemoved = await removed.service.issueHandoff(OWNER, undefined, { target: 'public', password: undefined });
  removed.users.length = 0;
  assert.throws(() => removed.service.redeemHandoff({ code: forRemoved.code, origin: PUBLIC_ORIGIN }), assertAppError('AUTH_HANDOFF_INVALID', 400));

  const moved = createHarness();
  const forMoved = await moved.service.issueHandoff(OWNER, undefined, { target: 'public', password: undefined });
  moved.env.STUDIO_PUBLIC_ORIGIN = 'https://studio2.ajarche.com';
  assert.throws(() => moved.service.redeemHandoff({ code: forMoved.code, origin: PUBLIC_ORIGIN }), assertAppError('AUTH_HANDOFF_INVALID', 400));
  assert.match(moved.logs.at(-1) ?? '', /refused \(target-changed\)/);
});

test('an unknown or unconfigured target is refused before any code is issued', async () => {
  const harness = createHarness({ env: { STUDIO_PUBLIC_ORIGIN: PUBLIC_ORIGIN } });
  await assert.rejects(
    harness.service.issueHandoff(OWNER, undefined, { target: 'local', password: undefined }),
    assertAppError('AUTH_HANDOFF_TARGET_INVALID', 400),
  );
  await assert.rejects(
    harness.service.issueHandoff(OWNER, undefined, { target: 'tailnet', password: undefined }),
    assertAppError('AUTH_HANDOFF_TARGET_UNCONFIGURED', 409),
  );
  const invalid = createHarness({ env: { STUDIO_TAILNET_ORIGIN: 'laptop.tail6e45f0.ts.net' } });
  await assert.rejects(
    invalid.service.issueHandoff(OWNER, undefined, { target: 'tailnet', password: undefined }),
    assertAppError('AUTH_HANDOFF_TARGET_UNCONFIGURED', 409),
  );
  await assert.rejects(
    harness.service.issueHandoff(null, undefined, { target: 'public', password: undefined }),
    assertAppError('AUTH_USER_REQUIRED', 401),
  );
});

test('the routes issue behind authentication and redeem by Origin without a token', async () => {
  const harness = createHarness();
  const app = express();
  app.use(express.json());
  // Stands in for authenticateToken after it verified a password session.
  const passwordAuth: express.RequestHandler = (req, _res, next) => {
    Object.assign(req, { user: OWNER });
    next();
  };
  app.use(createAuthRouter(harness.service, passwordAuth));
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
    return { status: response.status, cacheControl: response.headers.get('cache-control'), body: await response.json() as Record<string, unknown> };
  };

  try {
    const issued = await post('/handoff', { target: 'tailnet' });
    assert.equal(issued.status, 200);
    assert.equal(issued.cacheControl, 'no-store');
    assert.equal(issued.body.origin, TAILNET_ORIGIN);
    assert.equal(typeof issued.body.code, 'string');

    // Node's fetch lets the test set Origin the way the browser on the tailnet door would.
    const redeemed = await post('/handoff/redeem', { code: issued.body.code }, { Origin: TAILNET_ORIGIN });
    assert.equal(redeemed.status, 200);
    assert.equal(redeemed.cacheControl, 'no-store');
    assert.deepEqual(redeemed.body, { success: true, user: OWNER, token: 'token-1', target: 'tailnet' });

    const again = await post('/handoff/redeem', { code: issued.body.code }, { Origin: TAILNET_ORIGIN });
    assert.deepEqual([again.status, again.body], [400, { error: { code: 'AUTH_HANDOFF_INVALID' } }]);
    const unknownTarget = await post('/handoff', { target: 'elsewhere' });
    assert.deepEqual([unknownTarget.status, unknownTarget.body], [400, { error: { code: 'AUTH_HANDOFF_TARGET_INVALID' } }]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
