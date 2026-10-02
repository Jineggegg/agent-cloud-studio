import assert from 'node:assert/strict';
import { test } from 'node:test';

import express from 'express';

import { readStudioIngressOrigins } from '@/shared/utils.js';

import { createStudioNetworkRouter } from '../network.routes.js';
import { createStudioNetworkService } from '../network.service.js';

const PUBLIC_ORIGIN = 'https://studio.ajarche.com';
const TAILNET_ORIGIN = 'https://laptop-acgghbuq.tail6e45f0.ts.net:8443';

function serviceFor(env: Record<string, string | undefined>) {
  return createStudioNetworkService({ origins: () => readStudioIngressOrigins(env) });
}

test('readStudioIngressOrigins normalises both origins and reports malformed ones', () => {
  assert.deepEqual(readStudioIngressOrigins({}), { public: null, tailnet: null, invalid: [] });
  assert.deepEqual(
    readStudioIngressOrigins({ STUDIO_PUBLIC_ORIGIN: ' https://Studio.AJArche.com/ ', STUDIO_TAILNET_ORIGIN: `${TAILNET_ORIGIN}` }),
    { public: PUBLIC_ORIGIN, tailnet: TAILNET_ORIGIN, invalid: [] },
  );
  // The development runner uses an http origin; default ports are dropped.
  assert.equal(readStudioIngressOrigins({ STUDIO_PUBLIC_ORIGIN: 'http://127.0.0.1:5174' }).public, 'http://127.0.0.1:5174');
  assert.equal(readStudioIngressOrigins({ STUDIO_PUBLIC_ORIGIN: 'https://studio.ajarche.com:443' }).public, PUBLIC_ORIGIN);
  for (const value of ['studio.ajarche.com', 'https://studio.ajarche.com/app', 'https://studio.ajarche.com/?x=1', 'ftp://studio.ajarche.com', 'https://u:p@studio.ajarche.com']) {
    assert.deepEqual(readStudioIngressOrigins({ STUDIO_TAILNET_ORIGIN: value }), { public: null, tailnet: null, invalid: ['tailnet'] });
  }
});

test('the network view lists both doors and recognises the door that served the request', () => {
  const service = serviceFor({ STUDIO_PUBLIC_ORIGIN: PUBLIC_ORIGIN, STUDIO_TAILNET_ORIGIN: TAILNET_ORIGIN });
  const viaTunnel = service.describe({ host: 'studio.ajarche.com', tailscaleSession: false });
  assert.deepEqual(viaTunnel.ingresses, [
    { id: 'public', label: '公网域名', origin: PUBLIC_ORIGIN, configured: true, isDefault: true },
    { id: 'tailnet', label: 'Tailscale · AJ 通道', origin: TAILNET_ORIGIN, configured: true, isDefault: false },
  ]);
  assert.equal(viaTunnel.current, 'public');
  assert.equal(viaTunnel.session, 'password');
  assert.ok(viaTunnel.guidance[0].includes('同一个数据库'));

  assert.equal(service.describe({ host: 'laptop-acgghbuq.tail6e45f0.ts.net:8443', tailscaleSession: true }).current, 'tailnet');
  // Host comparison ignores case and an explicit default port, like a browser.
  assert.equal(service.describe({ host: 'STUDIO.ajarche.com:443', tailscaleSession: false }).current, 'public');
  for (const host of [undefined, '', 'localhost:3002', '127.0.0.1:3002', 'laptop-acgghbuq.tail6e45f0.ts.net', 'studio.ajarche.com:8443', 'evil.example/studio.ajarche.com', 'x@studio.ajarche.com']) {
    assert.equal(service.describe({ host, tailscaleSession: false }).current, 'local');
  }
});

test('the guidance explains missing or malformed configuration and the Tailscale session rule', () => {
  const unset = serviceFor({}).describe({ host: 'localhost:3002', tailscaleSession: false });
  assert.deepEqual(unset.ingresses.map(ingress => [ingress.id, ingress.configured, ingress.origin]), [['public', false, null], ['tailnet', false, null]]);
  assert.ok(unset.guidance.some(line => line.includes('STUDIO_PUBLIC_ORIGIN')));
  assert.ok(unset.guidance.some(line => line.includes('STUDIO_TAILNET_ORIGIN')));

  const malformed = serviceFor({ STUDIO_PUBLIC_ORIGIN: 'studio.ajarche.com', STUDIO_TAILNET_ORIGIN: TAILNET_ORIGIN })
    .describe({ host: 'laptop-acgghbuq.tail6e45f0.ts.net:8443', tailscaleSession: true });
  assert.ok(malformed.guidance.some(line => line.startsWith('STUDIO_PUBLIC_ORIGIN 格式不对')));
  assert.equal(malformed.session, 'tailscale');
  assert.ok(malformed.guidance.some(line => line.includes('需要输入一次账户密码')));
});

test('the route reports the Host header and whether the token came from Tailscale sign-in', async () => {
  const app = express();
  // Stands in for authenticateToken after it verified a Tailscale-issued token.
  app.use((req, _res, next) => {
    Object.assign(req, { user: { id: 1 }, tailscaleSession: { login: 'owner@example.com', node: '100.101.102.103' } });
    next();
  });
  app.use('/network', createStudioNetworkRouter(serviceFor({ STUDIO_PUBLIC_ORIGIN: PUBLIC_ORIGIN, STUDIO_TAILNET_ORIGIN: TAILNET_ORIGIN })));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/network`)).json() as { current: string; session: string };
    assert.deepEqual([body.current, body.session], ['local', 'tailscale']);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
