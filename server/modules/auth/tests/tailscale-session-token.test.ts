import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// jsonwebtoken ships no TypeScript declarations here; the test only needs `sign`.
type JwtAdapter = {
  sign(payload: object, secret: string, options: { expiresIn: string }): string;
};

type FakeResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  setHeader(name: string, value: string): void;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
};

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken') as JwtAdapter;

const JWT_TEST_SECRET = 'tailscale-session-token-test-secret';
const OWNER_LOGIN = 'owner@example.com';
const IPAD_NODE = '100.101.102.103';
const OWNER_SESSION = { login: OWNER_LOGIN, node: IPAD_NODE };

// The middleware reads JWT_SECRET, and shared/utils reads VITE_IS_PLATFORM, when first imported,
// so both are settled before the dynamic imports. node --test runs each file in its own process.
process.env.JWT_SECRET = JWT_TEST_SECRET;
delete process.env.VITE_IS_PLATFORM;
const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'tailscale-session-token-'));
const databasePath = path.join(tempDirectory, 'auth.db');
process.env.DATABASE_PATH = databasePath;
await writeFile(databasePath, '');

const database = await import('@/modules/database/index.js');
await database.initializeDatabase();
const userId = Number(database.userDb.createUser('andrew', 'hash').id);
const sessionUser = { id: userId, username: 'andrew' };
const middleware = await import('../auth.middleware.js');

test.after(async () => {
  database.closeConnection();
  await rm(tempDirectory, { recursive: true, force: true });
});

// The middleware reads the settings from process.env on every request (production fills it from
// .env once at startup, so there a change needs a restart).
function setTailscaleEnv(settings: { logins?: string; nodes?: string }) {
  for (const [name, value] of [
    ['STUDIO_TAILSCALE_LOGINS', settings.logins],
    ['STUDIO_TAILSCALE_NODES', settings.nodes],
  ] as const) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function tokenClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function authenticate(token: string) {
  const request: Record<string, unknown> = { headers: { authorization: `Bearer ${token}` }, query: {} };
  const response: FakeResponse = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  let nextCalled = false;
  await middleware.authenticateToken(request, response, () => {
    nextCalled = true;
  });
  return { request, response, nextCalled };
}

function assertRevoked(result: Awaited<ReturnType<typeof authenticate>>) {
  assert.equal(result.nextCalled, false);
  assert.equal(result.response.statusCode, 401);
  assert.equal(result.response.headers['X-Auth-Error'], 'invalid-token');
  assert.equal((result.response.body as { code?: string }).code, 'AUTH_TOKEN_INVALID');
}

test('a Tailscale session token carries its claim and works while the login stays allowlisted', async () => {
  setTailscaleEnv({ logins: OWNER_LOGIN });
  const token = middleware.generateToken(sessionUser, OWNER_SESSION);
  assert.deepEqual(tokenClaims(token).tailscale, OWNER_SESSION);

  const result = await authenticate(token);
  assert.equal(result.nextCalled, true);
  assert.equal((result.request.user as { username: string }).username, 'andrew');
  // The /refresh route reads this to keep the claim on an explicit refresh.
  assert.deepEqual(result.request.tailscaleSession, OWNER_SESSION);
  assert.deepEqual(middleware.authenticateWebSocket(token), { userId, username: 'andrew' });
});

test('clearing STUDIO_TAILSCALE_LOGINS or removing the login revokes issued Tailscale sessions', async () => {
  setTailscaleEnv({ logins: OWNER_LOGIN });
  const token = middleware.generateToken(sessionUser, OWNER_SESSION);

  setTailscaleEnv({});
  assertRevoked(await authenticate(token));
  assert.equal(middleware.authenticateWebSocket(token), null);

  setTailscaleEnv({ logins: 'friend@example.com' });
  assertRevoked(await authenticate(token));
  assert.equal(middleware.authenticateWebSocket(token), null);
});

test('STUDIO_TAILSCALE_NODES revokes sessions issued to devices it does not list', async () => {
  const token = middleware.generateToken(sessionUser, OWNER_SESSION);

  setTailscaleEnv({ logins: OWNER_LOGIN, nodes: '100.101.102.104' });
  assertRevoked(await authenticate(token));
  assert.equal(middleware.authenticateWebSocket(token), null);

  setTailscaleEnv({ logins: OWNER_LOGIN, nodes: `${IPAD_NODE}, 100.101.102.104` });
  assert.equal((await authenticate(token)).nextCalled, true);
});

test('password sessions carry no claim and ignore the Tailscale settings', async () => {
  setTailscaleEnv({});
  const token = middleware.generateToken(sessionUser);
  assert.equal(tokenClaims(token).tailscale, undefined);

  const result = await authenticate(token);
  assert.equal(result.nextCalled, true);
  assert.equal(result.request.tailscaleSession, undefined);
  assert.deepEqual(middleware.authenticateWebSocket(token), { userId, username: 'andrew' });
});

test('the automatic half-life refresh keeps the claim, so the new token stays revocable', async () => {
  setTailscaleEnv({ logins: OWNER_LOGIN });
  // Issued four days ago with the normal 7-day lifetime: past half-life, so a refresh is sent.
  const issuedAt = Math.floor(Date.now() / 1000) - 4 * 24 * 60 * 60;
  const agedToken = jwt.sign(
    { userId, username: 'andrew', tailscale: OWNER_SESSION, iat: issuedAt },
    JWT_TEST_SECRET,
    { expiresIn: '7d' },
  );

  const result = await authenticate(agedToken);
  assert.equal(result.nextCalled, true);
  const refreshedToken = result.response.headers['X-Refreshed-Token'];
  assert.ok(refreshedToken);
  assert.deepEqual(tokenClaims(refreshedToken).tailscale, OWNER_SESSION);

  setTailscaleEnv({});
  assertRevoked(await authenticate(refreshedToken));
});
