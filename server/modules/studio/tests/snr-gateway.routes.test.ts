import assert from 'node:assert/strict';
import { test } from 'node:test';

import express from 'express';

import { createSnrGateway } from '../snr-gateway.service.js';
import { createSnrGatewayRouter } from '../snr-gateway.routes.js';

test('gateway requires its capability and rejects foreign or malformed write origins', async () => {
  let calls = 0;
  const gateway = createSnrGateway({
    baseUrl: 'http://127.0.0.1:8768', validUser: () => true, authorization: () => null,
    request: (async () => { calls++; return Response.json({ status: 'ok' }); }) as typeof fetch,
  });
  const app = express();
  app.use(express.json());
  app.use('/gateway', createSnrGatewayRouter(gateway));
  app.use((error: { message: string; statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const missing = await fetch(`${base}/gateway/api/health`);
    assert.equal(missing.status, 401);
    const cookie = `studio-snr-access=${gateway.grant(1).key}`;
    const status = await fetch(`${base}/gateway/api/health`, { headers: { Cookie: cookie } });
    assert.equal(status.status, 200);
    assert.equal(status.headers.get('x-frame-options'), 'SAMEORIGIN');
    for (const origin of ['https://evil.example', 'null', '', `https://127.0.0.1:${address.port}`]) {
      const response = await fetch(`${base}/gateway/api/sessions`, {
        method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(response.status, 403);
    }
    assert.equal(calls, 1);
    const permitted = await fetch(`${base}/gateway/api/sessions`, {
      method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(permitted.status, 200);
    assert.equal(calls, 2);
    // The integration manifest is readable, but even a same-origin write to it never reaches SNR.
    const manifest = await fetch(`${base}/gateway/api/integration/v1/manifest`, { headers: { Cookie: cookie } });
    assert.equal(manifest.status, 200);
    const write = await fetch(`${base}/gateway/api/integration/v1/manifest`, {
      method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(write.status, 405);
    assert.equal(calls, 3);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('with two front doors configured, writes are accepted from either door and nowhere else', async () => {
  const saved = { public: process.env.STUDIO_PUBLIC_ORIGIN, tailnet: process.env.STUDIO_TAILNET_ORIGIN };
  // The route reads process.env per request; a trailing slash is normalised away.
  process.env.STUDIO_PUBLIC_ORIGIN = 'https://studio.ajarche.com/';
  process.env.STUDIO_TAILNET_ORIGIN = 'https://laptop-acgghbuq.tail6e45f0.ts.net:8443';
  let calls = 0;
  const gateway = createSnrGateway({
    baseUrl: 'http://127.0.0.1:8768', validUser: () => true, authorization: () => null,
    request: (async () => { calls++; return Response.json({ status: 'ok' }); }) as typeof fetch,
  });
  const app = express();
  app.use(express.json());
  app.use('/gateway', createSnrGatewayRouter(gateway));
  app.use((error: { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({});
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cookie = `studio-snr-access=${gateway.grant(1).key}`;
  const write = (origin: string) => fetch(`${base}/gateway/api/sessions`, {
    method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: '{}',
  }).then(response => response.status);
  try {
    assert.equal(await write('https://studio.ajarche.com'), 200);
    assert.equal(await write('https://laptop-acgghbuq.tail6e45f0.ts.net:8443'), 200);
    for (const origin of [base, 'https://evil.example', 'https://laptop-acgghbuq.tail6e45f0.ts.net', 'http://studio.ajarche.com']) {
      assert.equal(await write(origin), 403);
    }
    assert.equal(calls, 2);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [name, value] of [['STUDIO_PUBLIC_ORIGIN', saved.public], ['STUDIO_TAILNET_ORIGIN', saved.tailnet]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
