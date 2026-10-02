import assert from 'node:assert/strict';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { readCloudflareAccessConfig } from '@/shared/utils.js';

import { createCloudflareAccessGate, createCloudflareAccessMiddleware } from '../cloudflare-access.service.js';

// jsonwebtoken ships no TypeScript declarations here; the test only needs `sign`.
type JwtAdapter = {
  sign(payload: object, key: KeyObject | string, options: Record<string, unknown>): string;
};
const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken') as JwtAdapter;

const TEAM = 'ajarche';
const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`;
const AUD = 'a'.repeat(64);
const ENV = { STUDIO_CF_ACCESS_TEAM_DOMAIN: `${TEAM}.cloudflareaccess.com`, STUDIO_CF_ACCESS_AUD: AUD };

// Cloudflare signs with 2048-bit RSA keys; jsonwebtoken refuses smaller ones for RS256.
const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'access-key-1';

function jwks(...entries: { key: KeyObject; kid: string }[]) {
  return { keys: entries.map(({ key, kid }) => ({ ...key.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' })) };
}

function assertion(overrides: {
  payload?: Record<string, unknown>;
  key?: KeyObject;
  kid?: string;
  options?: Record<string, unknown>;
  /** false leaves out the 1 h expiry (for tokens without exp, or with exp in the payload). */
  expires?: boolean;
} = {}) {
  return jwt.sign(
    { email: 'owner@example.com', ...overrides.payload },
    overrides.key ?? signingKey.privateKey,
    {
      algorithm: 'RS256',
      keyid: overrides.kid ?? KID,
      audience: [AUD],
      issuer: ISSUER,
      ...(overrides.expires === false ? {} : { expiresIn: '1h' }),
      ...overrides.options,
    },
  );
}

// What cloudflared delivers from the public domain once Access let the visitor through.
function viaCloudflare(extra: Record<string, string> = {}) {
  return { host: 'studio.ajarche.com', 'cf-ray': '8c1f2e3d4a5b6c7d-HKG', 'cf-connecting-ip': '198.51.100.7', ...extra };
}

function createHarness(options: { env?: Record<string, string | undefined>; keySet?: unknown; failFetch?: boolean } = {}) {
  const clock = { now: 1_000_000 };
  const fetched: string[] = [];
  const logs: string[] = [];
  const state = { keySet: options.keySet ?? jwks({ key: signingKey.publicKey, kid: KID }), failFetch: options.failFetch ?? false };
  const fakeFetch = (async (url: string | URL | Request) => {
    fetched.push(String(url));
    if (state.failFetch) throw new TypeError('fetch failed');
    return Response.json(state.keySet);
  }) as typeof fetch;
  const gate = createCloudflareAccessGate({
    config: () => readCloudflareAccessConfig(options.env ?? ENV),
    fetch: fakeFetch,
    now: () => clock.now,
    logWarn: (message) => logs.push(message),
  });
  const check = (headers: Record<string, string>, path = '/api/projects', method = 'GET') => gate.check({ headers, method, path });
  return { gate, check, clock, fetched, logs, state };
}

test('readCloudflareAccessConfig is off by default and fails closed when half-configured', () => {
  assert.deepEqual(readCloudflareAccessConfig({}), { status: 'off' });
  assert.deepEqual(readCloudflareAccessConfig({ STUDIO_CF_ACCESS_TEAM_DOMAIN: ' ', STUDIO_CF_ACCESS_AUD: '' }), { status: 'off' });
  for (const env of [
    { STUDIO_CF_ACCESS_TEAM_DOMAIN: TEAM },
    { STUDIO_CF_ACCESS_AUD: AUD },
    { STUDIO_CF_ACCESS_TEAM_DOMAIN: 'evil.example.com', STUDIO_CF_ACCESS_AUD: AUD },
    { STUDIO_CF_ACCESS_TEAM_DOMAIN: TEAM, STUDIO_CF_ACCESS_AUD: 'has space' },
  ]) {
    assert.equal(readCloudflareAccessConfig(env).status, 'invalid');
  }
  for (const team of [TEAM, `${TEAM}.cloudflareaccess.com`, `https://${TEAM}.cloudflareaccess.com/`, 'AJARCHE']) {
    assert.deepEqual(readCloudflareAccessConfig({ STUDIO_CF_ACCESS_TEAM_DOMAIN: team, STUDIO_CF_ACCESS_AUD: `${AUD}, ${'b'.repeat(64)}` }), {
      status: 'on',
      teamDomain: `${TEAM}.cloudflareaccess.com`,
      issuer: ISSUER,
      certsUrl: CERTS_URL,
      audience: [AUD, 'b'.repeat(64)],
    });
  }
});

test('a valid Access assertion lets a Cloudflare request through, and the keys are cached', async () => {
  const harness = createHarness();
  for (let index = 0; index < 3; index += 1) {
    assert.deepEqual(await harness.check(viaCloudflare({ 'cf-access-jwt-assertion': assertion() })), { allowed: true });
  }
  assert.deepEqual(harness.fetched, [CERTS_URL]);
  // A key set older than an hour is refreshed on the next request.
  harness.clock.now += 60 * 60_000;
  assert.deepEqual(await harness.check(viaCloudflare({ 'cf-access-jwt-assertion': assertion() })), { allowed: true });
  assert.equal(harness.fetched.length, 2);
});

test('requests through Cloudflare without a valid assertion are refused', async () => {
  const harness = createHarness();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expired = assertion({ payload: { exp: nowSeconds - 120, iat: nowSeconds - 3600 }, expires: false });
  const noExpiry = assertion({ expires: false });
  const cases: [Record<string, string>, string][] = [
    [viaCloudflare(), 'assertion-missing'],
    [viaCloudflare({ 'cf-access-jwt-assertion': 'not-a-jwt' }), 'assertion-malformed'],
    [viaCloudflare({ 'cf-access-jwt-assertion': assertion({ options: { audience: ['c'.repeat(64)] } }) }), 'assertion-invalid'],
    [viaCloudflare({ 'cf-access-jwt-assertion': assertion({ options: { issuer: 'https://evil.cloudflareaccess.com' } }) }), 'assertion-invalid'],
    [viaCloudflare({ 'cf-access-jwt-assertion': expired }), 'assertion-invalid'],
    [viaCloudflare({ 'cf-access-jwt-assertion': noExpiry }), 'assertion-invalid'],
    // Signed by another key under the published kid.
    [viaCloudflare({ 'cf-access-jwt-assertion': assertion({ key: otherKey.privateKey }) }), 'assertion-invalid'],
    // HS256 "signed" with a guessable secret is refused before any key is looked up.
    [viaCloudflare({ 'cf-access-jwt-assertion': jwt.sign({ aud: [AUD], iss: ISSUER }, 'secret', { algorithm: 'HS256', keyid: KID, expiresIn: '1h' }) }), 'assertion-malformed'],
  ];
  for (const [headers, reason] of cases) {
    assert.deepEqual(await harness.check(headers), { allowed: false, reason }, reason);
  }
  // Any one Cloudflare edge header is enough to require the assertion.
  assert.equal((await harness.check({ host: 'studio.ajarche.com', 'cdn-loop': 'cloudflare; loops=1' })).allowed, false);
  // Logs name the path and the reason, never the query string or the assertion.
  await harness.check(viaCloudflare(), '/ws?token=secret-token');
  assert.equal(harness.logs.at(-1), '[auth] Cloudflare Access refused /ws (assertion-missing)');
});

test('tailnet and local requests are not affected, and nothing is checked while it is off', async () => {
  const harness = createHarness();
  assert.deepEqual(await harness.check({ host: 'laptop-acgghbuq.tail6e45f0.ts.net:8443' }), { allowed: true });
  assert.deepEqual(await harness.check({ host: '127.0.0.1:3002' }), { allowed: true });
  assert.deepEqual(harness.fetched, []);

  const off = createHarness({ env: {} });
  assert.deepEqual(await off.check(viaCloudflare()), { allowed: true });
  assert.deepEqual(off.fetched, []);
});

test('a half-configured check refuses every Cloudflare request without contacting Cloudflare', async () => {
  const harness = createHarness({ env: { STUDIO_CF_ACCESS_TEAM_DOMAIN: TEAM } });
  assert.deepEqual(await harness.check(viaCloudflare({ 'cf-access-jwt-assertion': assertion() })), { allowed: false, reason: 'config-invalid' });
  assert.deepEqual(await harness.check({ host: 'laptop-acgghbuq.tail6e45f0.ts.net:8443' }), { allowed: true });
  assert.deepEqual(harness.fetched, []);
});

test('an unknown kid refetches the keys at most once a minute, and stale keys survive a failed fetch', async () => {
  const harness = createHarness();
  assert.equal((await harness.check(viaCloudflare({ 'cf-access-jwt-assertion': assertion() }))).allowed, true);

  // Cloudflare rotated keys: the new kid triggers one refetch.
  harness.clock.now += 60_000;
  harness.state.keySet = jwks({ key: signingKey.publicKey, kid: KID }, { key: otherKey.publicKey, kid: 'access-key-2' });
  const rotated = assertion({ key: otherKey.privateKey, kid: 'access-key-2' });
  assert.equal((await harness.check(viaCloudflare({ 'cf-access-jwt-assertion': rotated }))).allowed, true);
  assert.equal(harness.fetched.length, 2);

  // Forged kids within the cooldown do not refetch.
  for (let index = 0; index < 5; index += 1) {
    const forged = assertion({ kid: `forged-${index}` });
    assert.deepEqual(await harness.check(viaCloudflare({ 'cf-access-jwt-assertion': forged })), { allowed: false, reason: 'key-unavailable' });
  }
  assert.equal(harness.fetched.length, 2);

  // The certs endpoint is down after the keys went stale: the cached keys keep working.
  harness.clock.now += 2 * 60 * 60_000;
  harness.state.failFetch = true;
  assert.equal((await harness.check(viaCloudflare({ 'cf-access-jwt-assertion': assertion() }))).allowed, true);
  assert.equal(harness.fetched.length, 3);
  assert.match(harness.logs.find((line) => line.includes('could not be fetched')) ?? '', /fetch failed/);
});

test('without any fetched keys, a failed fetch refuses the request', async () => {
  const harness = createHarness({ failFetch: true });
  assert.deepEqual(await harness.check(viaCloudflare({ 'cf-access-jwt-assertion': assertion() })), { allowed: false, reason: 'key-unavailable' });
});

test('the middleware answers 403 before any route, only for Cloudflare requests without a valid assertion', async () => {
  const harness = createHarness();
  const app = express();
  app.use(createCloudflareAccessMiddleware(harness.gate));
  app.get('/api/projects', (_req, res) => { res.json({ status: 'ok' }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const get = async (headers: Record<string, string>) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/projects`, { headers });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  try {
    const refused = await get({ 'CF-Ray': '8c1f2e3d4a5b6c7d-HKG', 'CF-Connecting-IP': '198.51.100.7' });
    assert.equal(refused.status, 403);
    assert.deepEqual(refused.body, { success: false, error: { code: 'CF_ACCESS_REQUIRED', message: '请先通过 Cloudflare Access 验证，再打开 Studio' } });
    const admitted = await get({ 'CF-Ray': '8c1f2e3d4a5b6c7d-HKG', 'Cf-Access-Jwt-Assertion': assertion() });
    assert.deepEqual(admitted, { status: 200, body: { status: 'ok' } });
    assert.deepEqual(await get({}), { status: 200, body: { status: 'ok' } });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('only GET/HEAD of the documented bypass paths skip the assertion', async () => {
  const harness = createHarness();
  for (const path of ['/health', '/manifest.json', '/icons/studio-192.png', '/icons/studio-icon.svg', '/health?probe=1']) {
    assert.deepEqual(await harness.check(viaCloudflare(), path), { allowed: true }, path);
    assert.deepEqual(await harness.check(viaCloudflare(), path, 'HEAD'), { allowed: true }, path);
  }
  for (const [path, method] of [
    ['/health', 'POST'],
    ['/', 'GET'],
    ['/api/studio/network', 'GET'],
    ['/icons/..', 'GET'],
    ['/icons/%2e%2e/index.html', 'GET'],
    ['/icons/sub/studio.png', 'GET'],
    ['/icons/studio.js', 'GET'],
    ['/healthz', 'GET'],
    ['/ws', 'GET'],
  ]) {
    assert.deepEqual(await harness.check(viaCloudflare(), path, method), { allowed: false, reason: 'assertion-missing' }, `${method} ${path}`);
  }
  assert.deepEqual(harness.fetched, []);
});
