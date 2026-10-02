import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import { createAuthRouter } from '../auth.routes.js';
import { createAuthService } from '../auth.service.js';
import { maskTailscaleLogin, parseTailscaleSignInConfig } from '../tailscale-session.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];
type TailscaleRequest = Parameters<ReturnType<typeof createAuthService>['signInWithTailscale']>[0];
type StoredUser = { id: number; username: string };

const OWNER_LOGIN = 'owner@example.com';
const SERVE_HOST = 'studio-pc.tail1234.ts.net:8443';

// What Tailscale Serve delivers for the owner's iPad: loopback socket, one tailnet X-Forwarded-For,
// the browser's ts.net Host, a same-origin Origin and the identity header.
function serveRequest(overrides: Partial<TailscaleRequest> = {}): TailscaleRequest {
  return {
    remoteAddress: '127.0.0.1',
    host: SERVE_HOST,
    origin: `https://${SERVE_HOST}`,
    fetchSite: 'same-origin',
    forwardedFor: '100.101.102.103',
    userLogin: OWNER_LOGIN,
    funnelRequest: undefined,
    ...overrides,
  };
}

function createHarness(options: {
  env?: Record<string, string | undefined>;
  users?: StoredUser[];
} = {}) {
  const users = options.users ?? [{ id: 1, username: 'andrew' }];
  const env = options.env ?? { STUDIO_TAILSCALE_LOGINS: OWNER_LOGIN };
  const logs: string[] = [];
  const lastLogins: number[] = [];
  const issuedFor: { id: number | bigint; username: string }[] = [];
  const dependencies: AuthDependencies = {
    users: {
      hasUsers: () => users.length > 0,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: (username) => {
        const user = users.find((candidate) => candidate.username === username);
        return user ? { ...user, password_hash: 'hash' } : undefined;
      },
      updateLastLogin: (userId) => lastLogins.push(userId),
      countActiveUsers: () => users.length,
      getFirstUser: () => users[0],
    },
    transaction: { begin: () => undefined, commit: () => undefined, rollback: () => undefined },
    hashPassword: async () => 'hash',
    comparePassword: async () => false,
    generateToken: (user) => {
      issuedFor.push(user);
      return `token-for-${user.username}`;
    },
    tailscaleSignIn: () => parseTailscaleSignInConfig(env),
    logInfo: (message) => logs.push(message),
  };
  return { service: createAuthService(dependencies), logs, lastLogins, issuedFor };
}

function assertRefused(
  harness: ReturnType<typeof createHarness>,
  request: TailscaleRequest,
  reason: string,
) {
  assert.throws(
    () => harness.service.signInWithTailscale(request),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 403
      && error.code === 'AUTH_TAILSCALE_UNAVAILABLE'
      && error.message === 'Tailscale sign-in is not available',
  );
  assert.match(harness.logs.at(-1) ?? '', new RegExp(`refused \\(${reason}\\)`));
  assert.deepEqual(harness.issuedFor, []);
  assert.deepEqual(harness.lastLogins, []);
}

test('an allowlisted Serve identity receives the normal login session for the only user', () => {
  const harness = createHarness();

  const result = harness.service.signInWithTailscale(serveRequest({ userLogin: 'Owner@Example.com' }));

  assert.deepEqual(result, {
    success: true,
    user: { id: 1, username: 'andrew' },
    token: 'token-for-andrew',
  });
  assert.deepEqual(harness.lastLogins, [1]);
  assert.deepEqual(harness.issuedFor, [{ id: 1, username: 'andrew' }]);
  assert.equal(harness.logs.length, 1);
  assert.match(harness.logs[0], /granted for Ow\*\*\*@Example\.com as local user "andrew"/);
  assert.ok(!harness.logs[0].toLowerCase().includes(OWNER_LOGIN));
});

test('a different tailnet member is refused', () => {
  assertRefused(createHarness(), serveRequest({ userLogin: 'friend@example.com' }), 'login-not-allowed');
});

test('a request without the Serve identity header is refused', () => {
  // Tagged devices and requests from the Serve machine itself arrive without identity headers.
  assertRefused(createHarness(), serveRequest({ userLogin: undefined }), 'identity-missing');
  assertRefused(createHarness(), serveRequest({ userLogin: '  ' }), 'identity-missing');
});

test('a socket that is not loopback is refused even with forged Serve headers', () => {
  for (const remoteAddress of ['100.101.102.103', '192.168.1.20', '::ffff:10.0.0.4', undefined]) {
    assertRefused(createHarness(), serveRequest({ remoteAddress }), 'socket-not-loopback');
  }
});

test('IPv6 and IPv4-mapped loopback sockets are accepted', () => {
  for (const remoteAddress of ['::1', '::ffff:127.0.0.1']) {
    assert.equal(createHarness().service.signInWithTailscale(serveRequest({ remoteAddress })).success, true);
  }
});

test('a Funnel request is refused', () => {
  assertRefused(createHarness(), serveRequest({ funnelRequest: '?1' }), 'funnel-request');
  assertRefused(createHarness(), serveRequest({ funnelRequest: '' }), 'funnel-request');
});

test('sign-in is disabled when STUDIO_TAILSCALE_LOGINS is unset or blank', () => {
  assertRefused(createHarness({ env: {} }), serveRequest(), 'disabled');
  assertRefused(createHarness({ env: { STUDIO_TAILSCALE_LOGINS: ' , ' } }), serveRequest(), 'disabled');
});

test('several users without STUDIO_TAILSCALE_USER are refused, and the mapping picks one', () => {
  const users = [{ id: 1, username: 'andrew' }, { id: 2, username: 'guest' }];
  assertRefused(createHarness({ users }), serveRequest(), 'ambiguous-user');

  const mapped = createHarness({
    users,
    env: { STUDIO_TAILSCALE_LOGINS: `other@example.com, ${OWNER_LOGIN}`, STUDIO_TAILSCALE_USER: 'guest' },
  });
  assert.deepEqual(mapped.service.signInWithTailscale(serveRequest()).user, { id: 2, username: 'guest' });
  assert.deepEqual(mapped.lastLogins, [2]);

  assertRefused(
    createHarness({ users, env: { STUDIO_TAILSCALE_LOGINS: OWNER_LOGIN, STUDIO_TAILSCALE_USER: 'nobody' } }),
    serveRequest(),
    'mapped-user-missing',
  );
  assertRefused(createHarness({ users: [] }), serveRequest(), 'no-user');
});

test('X-Forwarded-For must be the single tailnet address Serve writes', () => {
  for (const forwardedFor of [undefined, '', '127.0.0.1', '203.0.113.9', '100.101.102.103, 203.0.113.9', 'nonsense']) {
    assertRefused(createHarness(), serveRequest({ forwardedFor }), 'forwarded-for-not-tailnet');
  }
  const ipv6Peer = createHarness().service.signInWithTailscale(serveRequest({ forwardedFor: 'fd7a:115c:a1e0::53' }));
  assert.equal(ipv6Peer.success, true);
});

test('only a MagicDNS host is accepted, which defeats DNS rebinding to the loopback port', () => {
  for (const host of [undefined, 'localhost:3002', '127.0.0.1:3002', 'rebind.attacker.example', 'tail1234.ts.net', 'a@b.tail1234.ts.net']) {
    assertRefused(createHarness(), serveRequest({ host, origin: `https://${host}` }), 'host-not-tailnet');
  }
});

test('cross-site and non-browser-origin requests are refused because Tailscale identity is ambient', () => {
  const cases: Partial<TailscaleRequest>[] = [
    { origin: undefined },
    { origin: 'null' },
    { origin: 'https://attacker.example' },
    { origin: 'https://studio-pc.tail1234.ts.net' },
    { fetchSite: 'cross-site' },
    { fetchSite: 'same-site' },
  ];
  for (const overrides of cases) {
    assertRefused(createHarness(), serveRequest(overrides), 'cross-site');
  }

  // Default ports compare equal, and a missing Sec-Fetch-Site falls back to the Origin check.
  const defaultPort = createHarness().service.signInWithTailscale(serveRequest({
    host: 'studio-pc.tail1234.ts.net:443',
    origin: 'https://studio-pc.tail1234.ts.net',
    fetchSite: undefined,
  }));
  assert.equal(defaultPort.success, true);
});

test('STUDIO_PUBLIC_ORIGIN pins the only accepted origin', () => {
  const pinned = { STUDIO_TAILSCALE_LOGINS: OWNER_LOGIN, STUDIO_PUBLIC_ORIGIN: `https://${SERVE_HOST}` };
  assert.equal(createHarness({ env: pinned }).service.signInWithTailscale(serveRequest()).success, true);

  const otherServeName = 'laptop.tail1234.ts.net';
  assertRefused(
    createHarness({ env: pinned }),
    serveRequest({ host: otherServeName, origin: `https://${otherServeName}` }),
    'cross-site',
  );
});

test('a malformed STUDIO_PUBLIC_ORIGIN refuses sign-in instead of skipping the origin pin', () => {
  assertRefused(
    createHarness({ env: { STUDIO_TAILSCALE_LOGINS: OWNER_LOGIN, STUDIO_PUBLIC_ORIGIN: 'not a url' } }),
    serveRequest(),
    'cross-site',
  );
});

test('parseTailscaleSignInConfig normalises the allowlist and optional settings', () => {
  assert.deepEqual(parseTailscaleSignInConfig({}), { allowedLogins: [], mappedUsername: null, publicOrigin: null });
  assert.deepEqual(
    parseTailscaleSignInConfig({
      STUDIO_TAILSCALE_LOGINS: ' Owner@Example.com ,, me@github ',
      STUDIO_TAILSCALE_USER: ' andrew ',
      STUDIO_PUBLIC_ORIGIN: ' ',
    }),
    { allowedLogins: ['owner@example.com', 'me@github'], mappedUsername: 'andrew', publicOrigin: null },
  );
});

test('maskTailscaleLogin keeps logs free of full login names', () => {
  assert.equal(maskTailscaleLogin('alice@example.com'), 'al***@example.com');
  assert.equal(maskTailscaleLogin('ab@github'), 'a***@github');
  assert.equal(maskTailscaleLogin('nodomain'), 'no***');
  assert.equal(maskTailscaleLogin(null), '(none)');
  assert.equal(maskTailscaleLogin('café@ex'), 'ca***@ex');
  assert.equal(maskTailscaleLogin('ééé@ex'), '??***@ex');
});

test('the route reads the raw socket and Serve headers and answers every refusal identically', async () => {
  const configured = createHarness();
  const disabled = createHarness({ env: {} });
  const app = express();
  const passThrough: express.RequestHandler = (_req, _res, next) => next();
  app.use('/configured', createAuthRouter(configured.service, passThrough));
  app.use('/disabled', createAuthRouter(disabled.service, passThrough));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    res.status(appError?.statusCode ?? 500).json({ error: { code: appError?.code, message: appError?.message } });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  // node:http lets the test send the exact Host/Origin a browser behind Serve would.
  function post(prefix: string, headers: Record<string, string>) {
    return new Promise<{ status: number; cacheControl: string | undefined; body: string }>((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: `${prefix}/tailscale-session`, headers },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => { body += chunk; });
          response.on('end', () => resolve({
            status: response.statusCode ?? 0,
            cacheControl: response.headers['cache-control'],
            body,
          }));
        },
      );
      request.on('error', reject);
      request.end();
    });
  }

  const serveHeaders = {
    Host: SERVE_HOST,
    Origin: `https://${SERVE_HOST}`,
    'Sec-Fetch-Site': 'same-origin',
    'X-Forwarded-For': '100.101.102.103',
    'Tailscale-User-Login': OWNER_LOGIN,
  };

  try {
    const granted = await post('/configured', serveHeaders);
    assert.equal(granted.status, 200);
    assert.equal(granted.cacheControl, 'no-store');
    assert.deepEqual(JSON.parse(granted.body), {
      success: true,
      user: { id: 1, username: 'andrew' },
      token: 'token-for-andrew',
    });

    // Sequential, so the refusal reasons are logged in request order.
    const refusals = [
      await post('/disabled', serveHeaders),
      await post('/configured', { ...serveHeaders, 'Tailscale-User-Login': 'friend@example.com' }),
      await post('/configured', { ...serveHeaders, 'X-Forwarded-For': '100.101.102.103, 203.0.113.9' }),
      await post('/configured', { ...serveHeaders, 'Tailscale-Funnel-Request': '?1' }),
      await post('/configured', { ...serveHeaders, Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` }),
    ];
    for (const refusal of refusals) {
      assert.equal(refusal.status, 403);
      assert.equal(refusal.cacheControl, 'no-store');
      assert.equal(refusal.body, refusals[0].body);
    }
    assert.ok(!refusals[0].body.includes('disabled'));
    assert.deepEqual(
      configured.logs.slice(1).map((line) => /refused \(([a-z-]+)\)/.exec(line)?.[1]),
      ['login-not-allowed', 'forwarded-for-not-tailnet', 'funnel-request', 'host-not-tailnet'],
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
