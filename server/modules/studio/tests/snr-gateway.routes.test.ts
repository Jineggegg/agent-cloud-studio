import assert from 'node:assert/strict';
import { test } from 'node:test';

import express from 'express';

import { createSnrGateway } from '../snr-gateway.service.js';
import { createSnrGatewayRouter } from '../snr-gateway.routes.js';

test('gateway requires its capability and rejects foreign or malformed write origins', async () => {
  let calls = 0;
  const gateway = createSnrGateway({
    baseUrl: 'http://127.0.0.1:8768', validUser: () => true,
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
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
