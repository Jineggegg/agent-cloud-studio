import assert from 'node:assert/strict';
import test from 'node:test';

import { maskClientAddress, readRequestClient } from '../request-client.service.js';
import { evaluateTailscaleSessionRequest, isTailnetDoorRequest, parseTailscaleSignInConfig } from '../tailscale-session.service.js';

const CLOUDFLARE_HEADERS = {
  host: 'studio.ajarche.com',
  'cf-ray': '8c1f2e3d4a5b6c7d-HKG',
  'cf-connecting-ip': '198.51.100.7',
  'cdn-loop': 'cloudflare; loops=1',
};
const TAILNET_HOST = 'laptop-acgghbuq.tail6e45f0.ts.net:8443';
const ENV = { STUDIO_TAILNET_ORIGIN: `https://${TAILNET_HOST}` };

test('CF-Connecting-IP is trusted only when cloudflared delivered the request on loopback', () => {
  assert.deepEqual(
    readRequestClient({ headers: CLOUDFLARE_HEADERS, socket: { remoteAddress: '127.0.0.1' } }, ENV),
    { door: 'cloudflare', address: '198.51.100.7' },
  );
  assert.deepEqual(
    readRequestClient({ headers: CLOUDFLARE_HEADERS, socket: { remoteAddress: '::ffff:127.0.0.1' } }, ENV),
    { door: 'cloudflare', address: '198.51.100.7' },
  );
  // The same headers from anywhere else are forged: the caller is keyed by its own socket address,
  // so it cannot pick (or spread over) other clients' buckets.
  assert.deepEqual(
    readRequestClient({ headers: CLOUDFLARE_HEADERS, socket: { remoteAddress: '192.168.1.20' } }, ENV),
    { door: 'direct', address: '192.168.1.20' },
  );
  assert.deepEqual(
    readRequestClient({ headers: { ...CLOUDFLARE_HEADERS, 'cf-connecting-ip': '203.0.113.9' }, socket: { remoteAddress: '::ffff:100.64.1.2' } }, ENV),
    { door: 'direct', address: '100.64.1.2' },
  );
});

test('a garbage CF-Connecting-IP becomes one shared "unknown" bucket instead of a new key per value', () => {
  for (const value of ['not-an-ip', 'x'.repeat(5000), '198.51.100.7, 10.0.0.1']) {
    assert.deepEqual(
      readRequestClient({ headers: { ...CLOUDFLARE_HEADERS, 'cf-connecting-ip': value }, socket: { remoteAddress: '127.0.0.1' } }, ENV),
      { door: 'cloudflare', address: 'unknown' },
    );
  }
});

test('Tailscale Serve traffic is keyed by the tailnet device, and X-Forwarded-For is ignored elsewhere', () => {
  assert.deepEqual(
    readRequestClient({ headers: { host: TAILNET_HOST, 'x-forwarded-for': '100.101.102.103' }, socket: { remoteAddress: '127.0.0.1' } }, ENV),
    { door: 'tailnet', address: '100.101.102.103' },
  );
  // A public address, a list, or a non-loopback peer never moves a request into the tailnet door.
  assert.deepEqual(
    readRequestClient({ headers: { host: TAILNET_HOST, 'x-forwarded-for': '198.51.100.7' }, socket: { remoteAddress: '127.0.0.1' } }, ENV),
    { door: 'direct', address: '127.0.0.1' },
  );
  assert.deepEqual(
    readRequestClient({ headers: { host: TAILNET_HOST, 'x-forwarded-for': '100.101.102.103, 100.101.102.104' }, socket: { remoteAddress: '127.0.0.1' } }, ENV),
    { door: 'direct', address: '127.0.0.1' },
  );
  assert.deepEqual(
    readRequestClient({ headers: { host: TAILNET_HOST, 'x-forwarded-for': '100.101.102.103' }, socket: { remoteAddress: '192.168.1.20' } }, ENV),
    { door: 'direct', address: '192.168.1.20' },
  );
  assert.deepEqual(readRequestClient({ headers: {} }, ENV), { door: 'direct', address: 'unknown' });
});

test('event log addresses are masked', () => {
  assert.equal(maskClientAddress('198.51.100.7'), '198.51.*.*');
  assert.equal(maskClientAddress('2001:db8:85a3::8a2e:370:7334'), '2001:db8:*');
  assert.equal(maskClientAddress('unknown'), 'unknown');
});

test('with STUDIO_CLOUDFLARED_PORT set, only the cloudflared listener is the public door', () => {
  const env = { ...ENV, STUDIO_CLOUDFLARED_PORT: '3012', SERVER_PORT: '3002' };
  // Everything arriving on the listener is public, with or without Cloudflare headers.
  assert.deepEqual(
    readRequestClient({ headers: CLOUDFLARE_HEADERS, socket: { remoteAddress: '127.0.0.1', localPort: 3012 } }, env),
    { door: 'cloudflare', address: '198.51.100.7' },
  );
  assert.deepEqual(
    readRequestClient({ headers: { host: 'studio.ajarche.com' }, socket: { remoteAddress: '127.0.0.1', localPort: 3012 } }, env),
    { door: 'cloudflare', address: 'unknown' },
  );
  // Cloudflare headers on the main port are ignored: a tailnet device forging them through
  // Tailscale Serve stays that tailnet device, and a local program stays loopback.
  assert.deepEqual(
    readRequestClient({
      headers: { ...CLOUDFLARE_HEADERS, host: TAILNET_HOST, 'x-forwarded-for': '100.101.102.104' },
      socket: { remoteAddress: '127.0.0.1', localPort: 3002 },
    }, env),
    { door: 'tailnet', address: '100.101.102.104' },
  );
  assert.deepEqual(
    readRequestClient({ headers: CLOUDFLARE_HEADERS, socket: { remoteAddress: '127.0.0.1', localPort: 3002 } }, env),
    { door: 'direct', address: '127.0.0.1' },
  );
});

test('without the listener, any Cloudflare header means the public door, whatever else is sent', () => {
  // Reproduction of the regression: a public client adding Tailscale-* headers through Cloudflare
  // must not land in the direct door (127.0.0.1), whose budgets the owner's local login uses.
  for (const extra of [
    { 'tailscale-user-login': 'x' },
    { 'tailscale-user-name': 'x', 'tailscale-user-profile-pic': 'x' },
    { 'x-forwarded-for': '100.101.102.104' },
    { host: TAILNET_HOST },
    { host: TAILNET_HOST, 'x-forwarded-for': '100.101.102.104', 'tailscale-user-login': 'owner@example.com' },
  ]) {
    assert.deepEqual(
      readRequestClient({ headers: { ...CLOUDFLARE_HEADERS, ...extra }, socket: { remoteAddress: '127.0.0.1' } }, ENV),
      { door: 'cloudflare', address: '198.51.100.7' },
    );
  }
  // A single Cloudflare header is enough, and Serve traffic without them is still the tailnet door.
  assert.equal(readRequestClient({ headers: { 'cdn-loop': 'cloudflare', host: TAILNET_HOST, 'x-forwarded-for': '100.101.102.104' }, socket: { remoteAddress: '127.0.0.1' } }, ENV).door, 'cloudflare');
  assert.deepEqual(
    readRequestClient({ headers: { host: TAILNET_HOST, 'x-forwarded-for': '100.101.102.104', 'tailscale-user-login': 'owner@example.com' }, socket: { remoteAddress: '127.0.0.1' } }, ENV),
    { door: 'tailnet', address: '100.101.102.104' },
  );
});

test('IPv6 clients are keyed by their /64, so rotating addresses inside it stays one client', () => {
  const key = (address: string) => readRequestClient(
    { headers: { ...CLOUDFLARE_HEADERS, 'cf-connecting-ip': address }, socket: { remoteAddress: '127.0.0.1' } },
    ENV,
  ).address;
  assert.equal(key('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:db8:85a3:8d3::/64');
  assert.equal(key('2001:DB8:85A3:08D3::1'), '2001:db8:85a3:8d3::/64');
  assert.equal(key('2001:db8::1'), '2001:db8:0:0::/64');
  assert.notEqual(key('2001:db8:85a3:8d4::1'), key('2001:db8:85a3:8d3::1'));
  assert.deepEqual(readRequestClient({ headers: {}, socket: { remoteAddress: 'fe80::1%eth0' } }, ENV), { door: 'direct', address: 'fe80:0:0:0::/64' });
  // Tailnet devices keep their own address: one tailnet shares a /64.
  assert.equal(
    readRequestClient({ headers: { host: TAILNET_HOST, 'x-forwarded-for': 'fd7a:115c:a1e0::53' }, socket: { remoteAddress: '::1' } }, ENV).address,
    'fd7a:115c:a1e0::53',
  );
  assert.equal(maskClientAddress('2001:db8:85a3:8d3::/64'), '2001:db8:*');
});

test('the cloudflared listener is never the Tailscale door, not for sign-in and not for Tailscale session tokens', () => {
  const env = { ...ENV, STUDIO_TAILSCALE_LOGINS: 'owner@example.com', STUDIO_CLOUDFLARED_PORT: '3012', SERVER_PORT: '3002' };
  const config = parseTailscaleSignInConfig(env);
  const serveRequest = {
    remoteAddress: '127.0.0.1',
    host: TAILNET_HOST,
    origin: `https://${TAILNET_HOST}`,
    fetchSite: 'same-origin',
    forwardedFor: '100.101.102.103',
    userLogin: 'owner@example.com',
    funnelRequest: undefined,
  };
  assert.equal(evaluateTailscaleSessionRequest({ ...serveRequest, localPort: 3002 }, config).allowed, true);
  const viaListener = evaluateTailscaleSessionRequest({ ...serveRequest, localPort: 3012 }, config);
  assert.equal(viaListener.allowed, false);
  assert.equal(viaListener.allowed ? null : viaListener.reason, 'via-cloudflare');

  const doorRequest = (localPort: number) => ({
    headers: { host: TAILNET_HOST, 'x-forwarded-for': '100.101.102.103' },
    socket: { remoteAddress: '127.0.0.1', localPort },
  });
  assert.equal(isTailnetDoorRequest(doorRequest(3002), config), true);
  assert.equal(isTailnetDoorRequest(doorRequest(3012), config), false);
});
