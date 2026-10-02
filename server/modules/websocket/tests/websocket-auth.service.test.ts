import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';

import { verifyWebSocketUpgrade } from '@/modules/websocket/services/websocket-auth.service.js';

type VerifyInfo = Parameters<typeof verifyWebSocketUpgrade>[0];

function upgrade(headers: Record<string, string>, url = '/ws?token=jwt-from-query'): VerifyInfo {
  const req = { headers, url, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
  return { origin: 'https://studio.ajarche.com', secure: false, req };
}

test('the upgrade request reaches the token check, so the auth module can see which door it used', async () => {
  const seen: { token: string | null; host: string | undefined }[] = [];
  const info = upgrade({ host: 'laptop-acgghbuq.tail6e45f0.ts.net:8443' });
  const result = await verifyWebSocketUpgrade(info, {
    isPlatform: false,
    authenticateWebSocket: (token, request) => {
      seen.push({ token, host: request.headers.host });
      return { userId: 1, username: 'andrew' };
    },
  });
  assert.deepEqual(result, { allowed: true });
  assert.deepEqual(seen, [{ token: 'jwt-from-query', host: 'laptop-acgghbuq.tail6e45f0.ts.net:8443' }]);
  assert.deepEqual((info.req as IncomingMessage & { user?: unknown }).user, { userId: 1, username: 'andrew' });
});

test('a refused token is a 401, and a refused edge check is a 403 before the token is looked at', async () => {
  const refusedToken = await verifyWebSocketUpgrade(upgrade({ host: 'studio.ajarche.com' }), {
    isPlatform: false,
    authenticateWebSocket: () => null,
  });
  assert.deepEqual(refusedToken, { allowed: false, statusCode: 401 });

  let tokenChecks = 0;
  const edgeRequests: IncomingMessage[] = [];
  const info = upgrade({ host: 'studio.ajarche.com', 'cf-ray': '8c1f2e3d4a5b6c7d-HKG' });
  const refusedEdge = await verifyWebSocketUpgrade(info, {
    isPlatform: false,
    authenticateWebSocket: () => {
      tokenChecks += 1;
      return { userId: 1, username: 'andrew' };
    },
    admitEdgeRequest: async (request) => {
      edgeRequests.push(request);
      return false;
    },
  });
  assert.deepEqual(refusedEdge, { allowed: false, statusCode: 403 });
  assert.equal(tokenChecks, 0);
  assert.deepEqual(edgeRequests, [info.req]);

  const admitted = await verifyWebSocketUpgrade(upgrade({ host: 'studio.ajarche.com' }), {
    isPlatform: false,
    authenticateWebSocket: () => ({ userId: 1, username: 'andrew' }),
    admitEdgeRequest: async () => true,
  });
  assert.deepEqual(admitted, { allowed: true });
});
