import assert from 'node:assert/strict';
import test from 'node:test';

import { maskClientAddress, readRequestClient } from '../request-client.service.js';

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
