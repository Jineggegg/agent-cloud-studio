import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

// jsonwebtoken ships no TypeScript declarations here; the test only needs `sign`.
type JwtAdapter = { sign(payload: object, secret: string, options: { expiresIn: string }): string };

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken') as JwtAdapter;
const JWT_TEST_SECRET = 'session-revocation-test-secret';

// The middleware reads JWT_SECRET when first imported, so the environment and a throwaway
// database are settled before the dynamic imports. node --test runs each file in its own process.
process.env.JWT_SECRET = JWT_TEST_SECRET;
delete process.env.VITE_IS_PLATFORM;
const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-revocation-'));
const databasePath = path.join(tempDirectory, 'auth.db');
process.env.DATABASE_PATH = databasePath;
await writeFile(databasePath, '');

const database = await import('@/modules/database/index.js');
await database.initializeDatabase();
const userId = Number(database.userDb.createUser('andrew', 'hash').id);
const sessionUser = { id: userId, username: 'andrew' };
const middleware = await import('../auth.middleware.js');
const { getAuthSecurityStore } = await import('../auth-security.store.js');
const { createAccountSecurityService } = await import('../account-security.service.js');
const { createAuthRouter } = await import('../auth.routes.js');
const { createAuthService } = await import('../auth.service.js');
const { createHandoffCodeStore } = await import('../handoff.service.js');

test.after(async () => {
  database.closeConnection();
  await rm(tempDirectory, { recursive: true, force: true });
});

const revokedUsers: number[] = [];
const store = getAuthSecurityStore();
const authService = createAuthService({
  users: {
    hasUsers: () => true,
    createUser: () => { throw new Error('unused'); },
    getUserByUsername: () => undefined,
    updateLastLogin: () => undefined,
    countActiveUsers: () => 1,
    getFirstUser: () => sessionUser,
  },
  transaction: { begin: () => undefined, commit: () => undefined, rollback: () => undefined },
  hashPassword: async () => 'hash',
  comparePassword: async () => false,
  generateToken: middleware.generateToken,
  tailscaleSignIn: () => ({ allowedLogins: [], allowedNodes: [], mappedUsername: null, pinnedOrigin: null }),
  handoffCodes: createHandoffCodeStore(),
  ingressOrigins: () => ({ public: null, tailnet: null, invalid: [] }),
  logInfo: () => undefined,
});
const accountSecurity = createAccountSecurityService({
  verifyStepUpPassword: authService.verifyStepUpPassword,
  passkeys: {
    trustedOrigin: () => ({ origin: 'https://studio.ajarche.com', rpId: 'studio.ajarche.com' }),
    allowedOrigins: () => [],
    registrationOptions: async () => { throw new Error('unused'); },
    register: async () => { throw new Error('unused'); },
    list: () => [],
    remove: () => null,
  },
  events: { record: () => undefined, recent: () => [] },
  lockout: { status: () => ({ locked: false, lockedUntil: null, failures: 0, level: 0 }) },
  sessionVersions: store.sessionVersions,
  onSessionsRevoked: (revokedUserId) => revokedUsers.push(revokedUserId),
  logInfo: () => undefined,
});

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use('/api/auth', createAuthRouter(authService, middleware.authenticateToken, accountSecurity));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const upgradeRequest = { headers: { host: '127.0.0.1:3001' }, socket: { remoteAddress: '127.0.0.1' }, url: '/ws' };

test('tokens signed before token versions existed keep working until the first revocation', async () => {
  const legacyToken = jwt.sign({ userId, username: 'andrew' }, JWT_TEST_SECRET, { expiresIn: '7d' });
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/user`, { headers: { authorization: `Bearer ${legacyToken}` } });
    assert.equal(response.status, 200);
  });
  assert.deepEqual(middleware.authenticateWebSocket(legacyToken, upgradeRequest), { userId, username: 'andrew' });
});

test('退出所有设备 refuses every earlier token over HTTP and WebSocket, the revoking one included', async () => {
  const otherDevice = middleware.generateToken(sessionUser);
  const thisDevice = middleware.generateToken(sessionUser);
  const legacyToken = jwt.sign({ userId, username: 'andrew' }, JWT_TEST_SECRET, { expiresIn: '7d' });
  await withServer(async (baseUrl) => {
    const revoke = await fetch(`${baseUrl}/api/auth/security/revoke-all`, {
      method: 'POST',
      headers: { authorization: `Bearer ${thisDevice}` },
    });
    assert.equal(revoke.status, 200);
    assert.deepEqual(revokedUsers, [userId]);

    for (const token of [otherDevice, thisDevice, legacyToken]) {
      const response = await fetch(`${baseUrl}/api/auth/user`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('x-auth-error'), 'invalid-token');
      assert.equal(((await response.json()) as { code: string }).code, 'AUTH_TOKEN_REVOKED');
      assert.equal(middleware.authenticateWebSocket(token, upgradeRequest), null);
    }

    // Signing in again issues a token with the new version, which works everywhere.
    const fresh = middleware.generateToken(sessionUser);
    const response = await fetch(`${baseUrl}/api/auth/user`, { headers: { authorization: `Bearer ${fresh}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(middleware.authenticateWebSocket(fresh, upgradeRequest), { userId, username: 'andrew' });

    // An unauthenticated caller cannot revoke anything.
    const anonymous = await fetch(`${baseUrl}/api/auth/security/revoke-all`, { method: 'POST' });
    assert.equal(anonymous.status, 401);
    assert.deepEqual(revokedUsers, [userId]);
  });
});

test('the half-life refresh issues the current version, so a refreshed token survives only until the next revocation', async () => {
  const token = middleware.generateToken(sessionUser);
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { ver: number };
  assert.equal(claims.ver, store.sessionVersions.current(userId));
  store.sessionVersions.bump(userId);
  assert.equal(middleware.authenticateWebSocket(token, upgradeRequest), null);
});
