import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

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
const SERVE_HOST = 'laptop-acgghbuq.tail6e45f0.ts.net:8443';
const PUBLIC_HOST = 'studio.ajarche.com';

// How a request reaches Studio, as the middleware sees it: Host header, extra headers, socket peer.
type Door = { headers: Record<string, string>; remoteAddress: string };
// Tailscale Serve: loopback socket, the browser's MagicDNS Host, no Cloudflare headers.
const TAILNET_DOOR: Door = { headers: { host: SERVE_HOST }, remoteAddress: '127.0.0.1' };
// cloudflared: also loopback, but the public Host and the headers Cloudflare's edge always sets.
const PUBLIC_DOOR: Door = {
  headers: { host: PUBLIC_HOST, 'cf-ray': '8c1f2e3d4a5b6c7d-HKG', 'cf-connecting-ip': '198.51.100.7', 'cdn-loop': 'cloudflare; loops=1' },
  remoteAddress: '127.0.0.1',
};

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
const { createAuthRouter } = await import('../auth.routes.js');

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

// The two doors as configured in docs/network.md; tests that need no pin clear these again.
function setDoorEnv(doors: { public?: string; tailnet?: string }) {
  for (const [name, value] of [['STUDIO_PUBLIC_ORIGIN', doors.public], ['STUDIO_TAILNET_ORIGIN', doors.tailnet]] as const) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function upgradeRequest(door: Door) {
  return { headers: { ...door.headers }, socket: { remoteAddress: door.remoteAddress }, url: '/ws' };
}

async function authenticate(token: string, door: Door = TAILNET_DOOR) {
  const request: Record<string, unknown> = {
    headers: { ...door.headers, authorization: `Bearer ${token}` },
    socket: { remoteAddress: door.remoteAddress },
    query: {},
  };
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
  assert.deepEqual(middleware.authenticateWebSocket(token, upgradeRequest(TAILNET_DOOR)), { userId, username: 'andrew' });
});

test('clearing STUDIO_TAILSCALE_LOGINS or removing the login revokes issued Tailscale sessions', async () => {
  setTailscaleEnv({ logins: OWNER_LOGIN });
  const token = middleware.generateToken(sessionUser, OWNER_SESSION);

  setTailscaleEnv({});
  assertRevoked(await authenticate(token));
  assert.equal(middleware.authenticateWebSocket(token, upgradeRequest(TAILNET_DOOR)), null);

  setTailscaleEnv({ logins: 'friend@example.com' });
  assertRevoked(await authenticate(token));
  assert.equal(middleware.authenticateWebSocket(token, upgradeRequest(TAILNET_DOOR)), null);
});

test('STUDIO_TAILSCALE_NODES revokes sessions issued to devices it does not list', async () => {
  const token = middleware.generateToken(sessionUser, OWNER_SESSION);

  setTailscaleEnv({ logins: OWNER_LOGIN, nodes: '100.101.102.104' });
  assertRevoked(await authenticate(token));
  assert.equal(middleware.authenticateWebSocket(token, upgradeRequest(TAILNET_DOOR)), null);

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
  assert.deepEqual(middleware.authenticateWebSocket(token, upgradeRequest(TAILNET_DOOR)), { userId, username: 'andrew' });
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

test('a Tailscale session token is refused on the public door, over HTTP and WebSocket', async () => {
  setTailscaleEnv({ logins: OWNER_LOGIN });
  setDoorEnv({ public: `https://${PUBLIC_HOST}`, tailnet: `https://${SERVE_HOST}` });
  try {
    const token = middleware.generateToken(sessionUser, OWNER_SESSION);
    assert.equal((await authenticate(token, TAILNET_DOOR)).nextCalled, true);
    assert.deepEqual(middleware.authenticateWebSocket(token, upgradeRequest(TAILNET_DOOR)), { userId, username: 'andrew' });

    const offDoor: Door[] = [
      // What cloudflared delivers from https://studio.ajarche.com.
      PUBLIC_DOOR,
      // The public Host alone, and the tailnet Host with any one Cloudflare edge header.
      { headers: { host: PUBLIC_HOST }, remoteAddress: '127.0.0.1' },
      { headers: { host: SERVE_HOST, 'cf-ray': '8c1f2e3d4a5b6c7d-HKG' }, remoteAddress: '127.0.0.1' },
      { headers: { host: SERVE_HOST, 'cf-connecting-ip': '198.51.100.7' }, remoteAddress: '127.0.0.1' },
      { headers: { host: SERVE_HOST, 'cdn-loop': 'cloudflare' }, remoteAddress: '127.0.0.1' },
      // Funnel traffic, another machine's MagicDNS name, a local address and a non-loopback peer.
      { headers: { host: SERVE_HOST, 'tailscale-funnel-request': '?1' }, remoteAddress: '127.0.0.1' },
      { headers: { host: 'other-pc.tail6e45f0.ts.net:8443' }, remoteAddress: '127.0.0.1' },
      { headers: { host: '127.0.0.1:3002' }, remoteAddress: '127.0.0.1' },
      { headers: { host: SERVE_HOST }, remoteAddress: '192.168.1.20' },
    ];
    for (const door of offDoor) {
      const result = await authenticate(token, door);
      assertRevoked(result);
      assert.match((result.response.body as { error: string }).error, /Tailscale address/);
      assert.equal(result.response.headers['X-Refreshed-Token'], undefined);
      assert.equal(middleware.authenticateWebSocket(token, upgradeRequest(door)), null);
    }
    // Without the upgrade request the door is unknown, so the token is refused too.
    assert.equal(middleware.authenticateWebSocket(token), null);
  } finally {
    setDoorEnv({});
  }
});

test('password session tokens work on every door', async () => {
  setTailscaleEnv({ logins: OWNER_LOGIN });
  setDoorEnv({ public: `https://${PUBLIC_HOST}`, tailnet: `https://${SERVE_HOST}` });
  try {
    const token = middleware.generateToken(sessionUser);
    for (const door of [TAILNET_DOOR, PUBLIC_DOOR, { headers: { host: '127.0.0.1:3002' }, remoteAddress: '127.0.0.1' }]) {
      assert.equal((await authenticate(token, door)).nextCalled, true);
      assert.deepEqual(middleware.authenticateWebSocket(token, upgradeRequest(door)), { userId, username: 'andrew' });
    }
  } finally {
    setDoorEnv({});
  }
});

test('a misconfigured pin refuses Tailscale session tokens, like sign-in does', async () => {
  setTailscaleEnv({ logins: OWNER_LOGIN });
  const token = middleware.generateToken(sessionUser, OWNER_SESSION);
  try {
    // The public domain moved into STUDIO_PUBLIC_ORIGIN without STUDIO_TAILNET_ORIGIN.
    setDoorEnv({ public: `https://${PUBLIC_HOST}` });
    assertRevoked(await authenticate(token, TAILNET_DOOR));
    setDoorEnv({ tailnet: SERVE_HOST });
    assertRevoked(await authenticate(token, TAILNET_DOOR));
    // The single-door setup this feature started with: the ts.net origin in STUDIO_PUBLIC_ORIGIN.
    setDoorEnv({ public: `https://${SERVE_HOST}` });
    assert.equal((await authenticate(token, TAILNET_DOOR)).nextCalled, true);
  } finally {
    setDoorEnv({});
  }
});

test('POST /refresh refuses a Tailscale session token presented on the public door', async () => {
  setTailscaleEnv({ logins: OWNER_LOGIN });
  setDoorEnv({ public: `https://${PUBLIC_HOST}`, tailnet: `https://${SERVE_HOST}` });
  // Only refreshSession is reached; it signs with the real generateToken.
  const service = {
    refreshSession: (_user: unknown, claim?: { login: string; node: string }) => ({
      token: middleware.generateToken(sessionUser, claim),
    }),
  } as unknown as Parameters<typeof createAuthRouter>[0];
  const app = express();
  app.use(createAuthRouter(service, middleware.authenticateToken));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  // node:http sends the exact Host a browser behind Serve or cloudflared would.
  const refresh = (token: string, headers: Record<string, string>) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/refresh', headers: { ...headers, Authorization: `Bearer ${token}` } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on('error', reject);
    request.end();
  });

  try {
    const tailscaleToken = middleware.generateToken(sessionUser, OWNER_SESSION);
    const viaPublic = await refresh(tailscaleToken, PUBLIC_DOOR.headers);
    assert.equal(viaPublic.status, 401);
    assert.equal(JSON.parse(viaPublic.body).code, 'AUTH_TOKEN_INVALID');
    assert.equal((await refresh(tailscaleToken, { host: PUBLIC_HOST })).status, 401);

    const viaTailnet = await refresh(tailscaleToken, TAILNET_DOOR.headers);
    assert.equal(viaTailnet.status, 200);
    // The replacement keeps the claim, so it is just as door-bound as the original.
    const replacement = JSON.parse(viaTailnet.body).token as string;
    assert.deepEqual(tokenClaims(replacement).tailscale, OWNER_SESSION);
    assert.equal((await refresh(replacement, PUBLIC_DOOR.headers)).status, 401);

    const passwordToken = middleware.generateToken(sessionUser);
    assert.equal((await refresh(passwordToken, PUBLIC_DOOR.headers)).status, 200);
  } finally {
    setDoorEnv({});
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
