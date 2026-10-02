import assert from 'node:assert/strict';
import { test } from 'node:test';

import express from 'express';

import { AppError, readCloudflareAccessConfig, readStudioIngressOrigins } from '@/shared/utils.js';

import { createStudioNetworkRouter } from '../network.routes.js';
import { createStudioNetworkService } from '../network.service.js';

const PUBLIC_ORIGIN = 'https://studio.ajarche.com';
const TAILNET_ORIGIN = 'https://laptop-acgghbuq.tail6e45f0.ts.net:8443';

function serviceFor(env: Record<string, string | undefined>, readGuide?: () => string | null) {
  return createStudioNetworkService({
    origins: () => readStudioIngressOrigins(env),
    cloudflareAccess: () => readCloudflareAccessConfig(env),
    ...(readGuide ? { readGuide } : {}),
  });
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

test('the guidance reports the Cloudflare Access check: missing, half-configured or on', () => {
  const doors = { STUDIO_PUBLIC_ORIGIN: PUBLIC_ORIGIN, STUDIO_TAILNET_ORIGIN: TAILNET_ORIGIN };
  const describe = (env: Record<string, string>) => serviceFor({ ...doors, ...env }).describe({ host: 'studio.ajarche.com', tailscaleSession: false }).guidance;
  assert.ok(describe({}).some(line => line.includes('STUDIO_CF_ACCESS_TEAM_DOMAIN')));
  const halfConfigured = describe({ STUDIO_CF_ACCESS_TEAM_DOMAIN: 'ajarche' });
  assert.ok(halfConfigured.some(line => line.includes('要一起设置') && line.includes('全部被拒绝')));
  const on = describe({ STUDIO_CF_ACCESS_TEAM_DOMAIN: 'ajarche', STUDIO_CF_ACCESS_AUD: 'a'.repeat(64) });
  assert.ok(!on.some(line => line.includes('STUDIO_CF_ACCESS')));
  // Without a public door there is nothing to recommend.
  assert.ok(!serviceFor({ STUDIO_TAILNET_ORIGIN: TAILNET_ORIGIN }).describe({ host: undefined, tailscaleSession: false })
    .guidance.some(line => line.includes('STUDIO_CF_ACCESS')));
});

test('the guide route serves docs/network.md from Studio itself', async () => {
  const app = express();
  app.use('/served', createStudioNetworkRouter(serviceFor({}, () => '# 连接方式\n\n说明')));
  app.use('/missing', createStudioNetworkRouter(serviceFor({}, () => null)));
  // The default reader finds the real guide in this checkout.
  app.use('/default', createStudioNetworkRouter(serviceFor({})));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const appError = error instanceof AppError ? error : null;
    res.status(appError?.statusCode ?? 500).json({ error: { code: appError?.code } });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  const get = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: await response.json() as { markdown?: string; error?: { code?: string } } };
  };
  try {
    assert.deepEqual(await get('/served/guide'), { status: 200, body: { markdown: '# 连接方式\n\n说明' } });
    assert.deepEqual(await get('/missing/guide'), { status: 404, body: { error: { code: 'NETWORK_GUIDE_MISSING' } } });
    const real = await get('/default/guide');
    assert.equal(real.status, 200);
    assert.match(real.body.markdown ?? '', /^# 连接方式/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
