import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { AppError, readStudioIngressOrigins } from '@/shared/utils.js';

import { createAuthRouter } from '../auth.routes.js';
import { createAuthService } from '../auth.service.js';
import { createHandoffCodeStore } from '../handoff.service.js';
import {
  isTailscaleSessionRevoked,
  maskTailscaleLogin,
  parseTailscaleSignInConfig,
} from '../tailscale-session.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];
type TailscaleRequest = Parameters<ReturnType<typeof createAuthService>['signInWithTailscale']>[0];
type TailscaleSessionClaim = Parameters<AuthDependencies['generateToken']>[1];
type StoredUser = { id: number; username: string };

const OWNER_LOGIN = 'owner@example.com';
const SERVE_HOST = 'studio-pc.tail1234.ts.net:8443';
const IPAD_NODE = '100.101.102.103';
const OWNER_SESSION = { login: OWNER_LOGIN, node: IPAD_NODE };

// What Tailscale Serve delivers for the owner's iPad: loopback socket, one tailnet X-Forwarded-For,
// the browser's ts.net Host, a same-origin Origin and the identity header.
function serveRequest(overrides: Partial<TailscaleRequest> = {}): TailscaleRequest {
  return {
    remoteAddress: '127.0.0.1',
    host: SERVE_HOST,
    origin: `https://${SERVE_HOST}`,
    fetchSite: 'same-origin',
    forwardedFor: IPAD_NODE,
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
  const issuedFor: { user: { id: number | bigint; username: string }; session: TailscaleSessionClaim }[] = [];
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
    generateToken: (user, session) => {
      issuedFor.push({ user, session });
      return `token-for-${user.username}`;
    },
    tailscaleSignIn: () => parseTailscaleSignInConfig(env),
    handoffCodes: createHandoffCodeStore(),
    ingressOrigins: () => readStudioIngressOrigins(env),
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
  // The token records the normalised login and the device, so it can be revoked later.
  assert.deepEqual(harness.issuedFor, [{ user: { id: 1, username: 'andrew' }, session: OWNER_SESSION }]);
  assert.equal(harness.logs.length, 1);
  assert.match(harness.logs[0], /granted for Ow\*\*\*@Example\.com from 100\.101\.102\.103 as local user "andrew"/);
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
  for (const forwardedFor of ['fe80::1%eth0', 'fd7a:115c:a1e0::53%tailscale0']) {
    assertRefused(createHarness(), serveRequest({ forwardedFor }), 'forwarded-for-not-tailnet');
  }
});

test('STUDIO_TAILSCALE_NODES limits sign-in to the listed devices of the allowed login', () => {
  // Origin and Sec-Fetch-Site are forgeable by any program, so the device list is what narrows
  // the boundary below "every untagged device signed in as the owner".
  const env = { STUDIO_TAILSCALE_LOGINS: OWNER_LOGIN, STUDIO_TAILSCALE_NODES: `${IPAD_NODE}, FD7A:115C:A1E0:0:0:0:0:53` };

  const otherDevice = createHarness({ env });
  assertRefused(otherDevice, serveRequest({ forwardedFor: '100.101.102.104' }), 'node-not-allowed');
  // The refusal names the validated address, which is what the operator adds to the list.
  assert.match(otherDevice.logs[0], /refused \(node-not-allowed\) for ow\*\*\*@example\.com from 100\.101\.102\.104$/);

  const ipad = createHarness({ env });
  assert.equal(ipad.service.signInWithTailscale(serveRequest()).success, true);
  assert.deepEqual(ipad.issuedFor[0].session, OWNER_SESSION);

  // Entries compare by address, not spelling: the expanded upper-case IPv6 entry matches the
  // compressed address Serve writes, and the token records the canonical spelling.
  const ipadOverIpv6 = createHarness({ env });
  assert.equal(ipadOverIpv6.service.signInWithTailscale(serveRequest({ forwardedFor: 'fd7a:115c:a1e0::53' })).success, true);
  assert.deepEqual(ipadOverIpv6.issuedFor[0].session, { login: OWNER_LOGIN, node: 'fd7a:115c:a1e0::53' });
});

test('an invalid STUDIO_TAILSCALE_NODES entry refuses every device instead of allowing all', () => {
  for (const nodes of ['ipad', `${IPAD_NODE}, 192.168.1.5`, `${IPAD_NODE},100.101.102`, 'fd7a:115c:a1e0::53%tailscale0']) {
    assertRefused(
      createHarness({ env: { STUDIO_TAILSCALE_LOGINS: OWNER_LOGIN, STUDIO_TAILSCALE_NODES: nodes } }),
      serveRequest(),
      'nodes-invalid',
    );
  }
});

test('only a MagicDNS host is accepted, which defeats DNS rebinding to the loopback port', () => {
  for (const host of [undefined, 'localhost:3002', '127.0.0.1:3002', 'rebind.attacker.example', 'tail1234.ts.net', 'a@b.tail1234.ts.net']) {
    assertRefused(createHarness(), serveRequest({ host, origin: `https://${host}` }), 'host-not-tailnet');
  }
});

// This stops other web pages from riding the ambient identity; it is not authentication, since a
// non-browser program can send any Origin it likes.
test('requests without a same-origin Origin are refused because Tailscale identity is ambient', () => {
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

test('an http Origin is cross-origin to the https page Serve terminates', () => {
  // E.g. another app served with `tailscale serve --http=80` on the same MagicDNS name, opened in
  // a browser that sends no Sec-Fetch-Site.
  const cases: Partial<TailscaleRequest>[] = [
    { host: 'studio-pc.tail1234.ts.net', origin: 'http://studio-pc.tail1234.ts.net', fetchSite: undefined },
    { origin: `http://${SERVE_HOST}`, fetchSite: undefined },
  ];
  for (const overrides of cases) {
    assertRefused(createHarness(), serveRequest(overrides), 'cross-site');
  }
});

test('STUDIO_PUBLIC_ORIGIN pins the only accepted origin while STUDIO_TAILNET_ORIGIN is unset', () => {
  // The single-door setup this feature started with keeps working unchanged.
  const pinned = { STUDIO_TAILSCALE_LOGINS: OWNER_LOGIN, STUDIO_PUBLIC_ORIGIN: `https://${SERVE_HOST}` };
  assert.equal(createHarness({ env: pinned }).service.signInWithTailscale(serveRequest()).success, true);

  const otherServeName = 'laptop.tail1234.ts.net';
  assertRefused(
    createHarness({ env: pinned }),
    serveRequest({ host: otherServeName, origin: `https://${otherServeName}` }),
    'cross-site',
  );

  const trailingSlash = { ...pinned, STUDIO_PUBLIC_ORIGIN: `https://${SERVE_HOST}/` };
  assert.equal(createHarness({ env: trailingSlash }).service.signInWithTailscale(serveRequest()).success, true);
});

test('STUDIO_TAILNET_ORIGIN pins the origin when the public origin is the Cloudflare domain', () => {
  const twoDoors = {
    STUDIO_TAILSCALE_LOGINS: OWNER_LOGIN,
    STUDIO_PUBLIC_ORIGIN: 'https://studio.ajarche.com',
    STUDIO_TAILNET_ORIGIN: `https://${SERVE_HOST}`,
  };
  assert.equal(createHarness({ env: twoDoors }).service.signInWithTailscale(serveRequest()).success, true);

  const otherServeName = 'laptop.tail1234.ts.net';
  assertRefused(
    createHarness({ env: twoDoors }),
    serveRequest({ host: otherServeName, origin: `https://${otherServeName}` }),
    'cross-site',
  );
  // STUDIO_TAILNET_ORIGIN wins over STUDIO_PUBLIC_ORIGIN, even when the latter is a ts.net origin.
  const tailnetWins = { ...twoDoors, STUDIO_PUBLIC_ORIGIN: `https://${otherServeName}` };
  assertRefused(
    createHarness({ env: tailnetWins }),
    serveRequest({ host: otherServeName, origin: `https://${otherServeName}` }),
    'cross-site',
  );
});

test('a public-domain pin without STUDIO_TAILNET_ORIGIN refuses with a clear reason', () => {
  // The likely migration mistake: STUDIO_PUBLIC_ORIGIN moved to the domain, the tailnet origin not set.
  const env = { STUDIO_TAILSCALE_LOGINS: OWNER_LOGIN, STUDIO_PUBLIC_ORIGIN: 'https://studio.ajarche.com' };
  assertRefused(createHarness({ env }), serveRequest(), 'pinned-origin-not-tailnet');
});

test('a malformed pinned origin refuses sign-in instead of skipping the pin', () => {
  const otherServeName = 'other.tail1234.ts.net';
  const malformed = [
    SERVE_HOST, // missing https://, which URL parses as a "studio-pc.tail1234.ts.net:" scheme
    `http://${SERVE_HOST}`,
    `https://${SERVE_HOST}/studio`,
    `https://${SERVE_HOST}/?x=1`,
    `https://user@${SERVE_HOST}`,
    'not a url',
  ];
  for (const value of malformed) {
    for (const env of [
      { STUDIO_TAILSCALE_LOGINS: OWNER_LOGIN, STUDIO_PUBLIC_ORIGIN: value },
      // A malformed tailnet origin fails closed rather than falling back to a valid public one.
      { STUDIO_TAILSCALE_LOGINS: OWNER_LOGIN, STUDIO_TAILNET_ORIGIN: value, STUDIO_PUBLIC_ORIGIN: `https://${SERVE_HOST}` },
    ]) {
      assertRefused(createHarness({ env }), serveRequest(), 'pinned-origin-invalid');
      assertRefused(
        createHarness({ env }),
        serveRequest({ host: otherServeName, origin: `https://${otherServeName}` }),
        'pinned-origin-invalid',
      );
    }
  }
});

test('a request through the Cloudflare tunnel with forged Tailscale headers is refused', () => {
  // cloudflared dials Studio over loopback, like Serve, and Cloudflare forwards client headers it
  // does not own, so an attacker on the public internet can send Tailscale-User-Login itself.
  const twoDoors = {
    STUDIO_TAILSCALE_LOGINS: OWNER_LOGIN,
    STUDIO_PUBLIC_ORIGIN: 'https://studio.ajarche.com',
    STUDIO_TAILNET_ORIGIN: `https://${SERVE_HOST}`,
  };
  const forged = {
    remoteAddress: '127.0.0.1',
    host: 'studio.ajarche.com',
    origin: 'https://studio.ajarche.com',
    fetchSite: 'same-origin',
    userLogin: OWNER_LOGIN,
    cfRay: '8c1f2e3d4a5b6c7d-HKG',
    cfConnectingIp: '203.0.113.9',
    cdnLoop: 'cloudflare; loops=1',
  };
  // Cloudflare appends the real client address to a forged X-Forwarded-For.
  assertRefused(createHarness({ env: twoDoors }), serveRequest({ ...forged, forwardedFor: `${IPAD_NODE}, 203.0.113.9` }), 'via-cloudflare');
  assertRefused(createHarness({ env: twoDoors }), serveRequest({ ...forged, forwardedFor: IPAD_NODE }), 'via-cloudflare');

  // Each Cloudflare header alone is enough, and the Host check would refuse it anyway.
  for (const header of [{ cfRay: forged.cfRay }, { cfConnectingIp: forged.cfConnectingIp }, { cdnLoop: 'cloudflare' }, { cdnLoop: 'other-cdn, cloudflare; loops=2' }]) {
    assertRefused(createHarness({ env: twoDoors }), serveRequest(header), 'via-cloudflare');
  }
  assertRefused(
    createHarness({ env: twoDoors }),
    serveRequest({ host: 'studio.ajarche.com', origin: 'https://studio.ajarche.com', forwardedFor: IPAD_NODE }),
    'host-not-tailnet',
  );
  // A CDN-Loop that only mentions another CDN does not trip the check.
  assert.equal(createHarness({ env: twoDoors }).service.signInWithTailscale(serveRequest({ cdnLoop: 'notcloudflare' })).success, true);
});

test('parseTailscaleSignInConfig normalises the allowlists and optional settings', () => {
  assert.deepEqual(
    parseTailscaleSignInConfig({}),
    { allowedLogins: [], allowedNodes: [], mappedUsername: null, pinnedOrigin: null },
  );
  assert.deepEqual(
    parseTailscaleSignInConfig({
      STUDIO_TAILSCALE_LOGINS: ' Owner@Example.com ,, me@github ',
      STUDIO_TAILSCALE_NODES: ` ${IPAD_NODE} ,, fd7a:115c:a1e0::53 `,
      STUDIO_TAILSCALE_USER: ' andrew ',
      STUDIO_PUBLIC_ORIGIN: ' ',
    }),
    {
      allowedLogins: ['owner@example.com', 'me@github'],
      allowedNodes: [IPAD_NODE, 'fd7a:115c:a1e0::53'],
      mappedUsername: 'andrew',
      pinnedOrigin: null,
    },
  );
  // A blank STUDIO_TAILNET_ORIGIN counts as unset and falls back to STUDIO_PUBLIC_ORIGIN.
  assert.equal(
    parseTailscaleSignInConfig({ STUDIO_TAILNET_ORIGIN: ' ', STUDIO_PUBLIC_ORIGIN: ` https://${SERVE_HOST} ` }).pinnedOrigin,
    `https://${SERVE_HOST}`,
  );
  assert.equal(
    parseTailscaleSignInConfig({ STUDIO_TAILNET_ORIGIN: `https://${SERVE_HOST}`, STUDIO_PUBLIC_ORIGIN: 'https://studio.ajarche.com' }).pinnedOrigin,
    `https://${SERVE_HOST}`,
  );
});

test('isTailscaleSessionRevoked re-checks an issued session against the current settings', () => {
  const config = (env: Record<string, string>) => parseTailscaleSignInConfig(env);
  const enabled = config({ STUDIO_TAILSCALE_LOGINS: OWNER_LOGIN });

  // Password sessions carry no claim and are never revoked by this feature.
  assert.equal(isTailscaleSessionRevoked(undefined, config({})), false);
  assert.equal(isTailscaleSessionRevoked(OWNER_SESSION, enabled), false);
  assert.equal(isTailscaleSessionRevoked({ login: 'Owner@Example.com', node: IPAD_NODE }, enabled), false);

  // Turning the feature off or removing the login revokes it.
  assert.equal(isTailscaleSessionRevoked(OWNER_SESSION, config({})), true);
  assert.equal(isTailscaleSessionRevoked(OWNER_SESSION, config({ STUDIO_TAILSCALE_LOGINS: 'friend@example.com' })), true);

  // A device list revokes sessions of unlisted devices, and a broken list revokes everything.
  const listed = config({ STUDIO_TAILSCALE_LOGINS: OWNER_LOGIN, STUDIO_TAILSCALE_NODES: IPAD_NODE });
  assert.equal(isTailscaleSessionRevoked(OWNER_SESSION, listed), false);
  assert.equal(isTailscaleSessionRevoked({ login: OWNER_LOGIN, node: '100.101.102.104' }, listed), true);
  assert.equal(
    isTailscaleSessionRevoked(OWNER_SESSION, config({ STUDIO_TAILSCALE_LOGINS: OWNER_LOGIN, STUDIO_TAILSCALE_NODES: 'ipad' })),
    true,
  );

  // A malformed claim fails closed.
  for (const claim of [null, 'owner', {}, { login: OWNER_LOGIN }, { login: OWNER_LOGIN, node: 7 }]) {
    assert.equal(isTailscaleSessionRevoked(claim, enabled), true);
  }
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
  const configured = createHarness({ env: { STUDIO_TAILSCALE_LOGINS: OWNER_LOGIN, STUDIO_TAILSCALE_NODES: IPAD_NODE } });
  const disabled = createHarness({ env: {} });
  const refreshing = createHarness();
  const app = express();
  const passThrough: express.RequestHandler = (_req, _res, next) => next();
  // Stands in for authenticateToken after it verified a Tailscale-issued token.
  const tailscaleTokenAuth: express.RequestHandler = (req, _res, next) => {
    Object.assign(req, { user: { id: 1, username: 'andrew' }, tailscaleSession: OWNER_SESSION });
    next();
  };
  app.use('/configured', createAuthRouter(configured.service, passThrough));
  app.use('/disabled', createAuthRouter(disabled.service, passThrough));
  app.use('/refreshing', createAuthRouter(refreshing.service, tailscaleTokenAuth));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    res.status(appError?.statusCode ?? 500).json({ error: { code: appError?.code, message: appError?.message } });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  // node:http sends the exact Host/Origin a browser behind Serve would. Any non-browser program on
  // a tailnet device can do the same, which is why STUDIO_TAILSCALE_NODES exists.
  function post(prefix: string, headers: Record<string, string>, endpoint = '/tailscale-session') {
    return new Promise<{ status: number; cacheControl: string | undefined; body: string }>((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: `${prefix}${endpoint}`, headers },
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
    'X-Forwarded-For': IPAD_NODE,
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
    assert.deepEqual(configured.issuedFor[0].session, OWNER_SESSION);

    // Sequential, so the refusal reasons are logged in request order.
    const { 'Sec-Fetch-Site': _fetchSite, ...withoutFetchSite } = serveHeaders;
    const refusals = [
      await post('/disabled', serveHeaders),
      await post('/configured', { ...serveHeaders, 'Tailscale-User-Login': 'friend@example.com' }),
      await post('/configured', { ...serveHeaders, 'X-Forwarded-For': '100.101.102.103, 203.0.113.9' }),
      await post('/configured', { ...serveHeaders, 'X-Forwarded-For': '100.101.102.104' }),
      await post('/configured', { ...serveHeaders, 'Tailscale-Funnel-Request': '?1' }),
      await post('/configured', { ...serveHeaders, Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` }),
      await post('/configured', { ...withoutFetchSite, Origin: `http://${SERVE_HOST}` }),
    ];
    for (const refusal of refusals) {
      assert.equal(refusal.status, 403);
      assert.equal(refusal.cacheControl, 'no-store');
      assert.equal(refusal.body, refusals[0].body);
    }
    assert.ok(!refusals[0].body.includes('disabled'));
    assert.deepEqual(
      configured.logs.slice(1).map((line) => /refused \(([a-z-]+)\)/.exec(line)?.[1]),
      ['login-not-allowed', 'forwarded-for-not-tailnet', 'node-not-allowed', 'funnel-request', 'host-not-tailnet', 'cross-site'],
    );

    // An explicit refresh keeps the Tailscale claim the middleware attached to the request.
    const refreshed = await post('/refreshing', {}, '/refresh');
    assert.equal(refreshed.status, 200);
    assert.deepEqual(JSON.parse(refreshed.body), { token: 'token-for-andrew' });
    assert.deepEqual(refreshing.issuedFor, [{ user: { id: 1, username: 'andrew' }, session: OWNER_SESSION }]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('the route refuses what cloudflared delivers from the public domain, forged headers included', async () => {
  // Both doors configured, as in docs/network.md. cloudflared connects to Studio over loopback,
  // exactly like Serve, so only the headers can tell the doors apart.
  const harness = createHarness({
    env: {
      STUDIO_TAILSCALE_LOGINS: OWNER_LOGIN,
      STUDIO_PUBLIC_ORIGIN: 'https://studio.ajarche.com',
      STUDIO_TAILNET_ORIGIN: `https://${SERVE_HOST}`,
    },
  });
  const app = express();
  app.use(createAuthRouter(harness.service, (_req, _res, next) => next()));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    res.status(appError?.statusCode ?? 500).json({ error: { code: appError?.code } });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const post = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/tailscale-session', headers },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.end();
  });

  // The attacker's own headers, as they reach Studio after Cloudflare's edge and cloudflared.
  const forgedThroughTunnel = {
    Host: 'studio.ajarche.com',
    Origin: 'https://studio.ajarche.com',
    'Sec-Fetch-Site': 'same-origin',
    'Tailscale-User-Login': OWNER_LOGIN,
    'X-Forwarded-For': `${IPAD_NODE}, 198.51.100.7`,
    'CF-Ray': '8c1f2e3d4a5b6c7d-HKG',
    'CF-Connecting-IP': '198.51.100.7',
    'CDN-Loop': 'cloudflare; loops=1',
  };
  try {
    const statuses = [
      await post(forgedThroughTunnel),
      // Even with every Cloudflare header stripped and a single forged tailnet address, the
      // public Host is refused, and so is a forged ts.net Host carrying the public Origin.
      await post({ Host: 'studio.ajarche.com', Origin: 'https://studio.ajarche.com', 'Tailscale-User-Login': OWNER_LOGIN, 'X-Forwarded-For': IPAD_NODE }),
      await post({ Host: SERVE_HOST, Origin: 'https://studio.ajarche.com', 'Tailscale-User-Login': OWNER_LOGIN, 'X-Forwarded-For': IPAD_NODE }),
    ];
    assert.deepEqual(statuses, [403, 403, 403]);
    assert.deepEqual(
      harness.logs.map((line) => /refused \(([a-z-]+)\)/.exec(line)?.[1]),
      ['via-cloudflare', 'host-not-tailnet', 'cross-site'],
    );
    assert.deepEqual(harness.issuedFor, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
