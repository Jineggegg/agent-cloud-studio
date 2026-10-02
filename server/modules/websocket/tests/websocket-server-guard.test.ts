import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { WebSocket } from 'ws';

import { closeUserWebSockets, createWebSocketServer } from '@/modules/websocket/services/websocket-server.service.js';

type GuardCalls = { admitted: number; tracked: number; released: number };

// A gateway with fake auth (token "user-7" or "user-8") and a scripted connection guard; the
// /shell route is used because it only waits for an init message.
async function startGateway(admit: () => { allowed: true } | { allowed: false; statusCode: number; retryAfterSeconds: number }) {
  const calls: GuardCalls = { admitted: 0, tracked: 0, released: 0 };
  const server = http.createServer();
  const wss = createWebSocketServer(server, {
    verifyClient: {
      isPlatform: false,
      authenticateWebSocket: (token) => {
        const match = /^user-(\d+)$/.exec(token ?? '');
        return match ? { userId: Number(match[1]), username: `user${match[1]}` } : null;
      },
    },
    chat: { runtime: {} as never },
    shell: { resolveProviderSessionId: () => null },
    getPluginPort: () => null,
    maxPayloadBytes: 1024,
    connectionGuard: {
      admitUpgrade: () => {
        calls.admitted += 1;
        return admit();
      },
      trackConnection: () => {
        calls.tracked += 1;
        return () => { calls.released += 1; };
      },
    },
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = (token: string) => `ws://127.0.0.1:${(server.address() as AddressInfo).port}/shell?token=${token}`;
  const close = async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  };
  return { url, calls, close };
}

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
}

test('a refused upgrade is answered 429 with Retry-After before the token is checked', async () => {
  const gateway = await startGateway(() => ({ allowed: false, statusCode: 429, retryAfterSeconds: 17 }));
  try {
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const socket = new WebSocket(gateway.url('user-7'));
      socket.once('unexpected-response', (_request, incoming) => resolve(incoming));
      socket.once('open', () => reject(new Error('the upgrade should have been refused')));
      socket.once('error', () => undefined);
    });
    assert.equal(response.statusCode, 429);
    assert.equal(response.headers['retry-after'], '17');
    assert.deepEqual(gateway.calls, { admitted: 1, tracked: 0, released: 0 });
  } finally {
    await gateway.close();
  }
});

test('closeUserWebSockets closes only that user\'s sockets, with 4401, and releases their slots', async () => {
  const gateway = await startGateway(() => ({ allowed: true }));
  try {
    const first = await open(gateway.url('user-7'));
    const second = await open(gateway.url('user-7'));
    const other = await open(gateway.url('user-8'));
    assert.equal(gateway.calls.tracked, 3);

    const firstClosed = closed(first);
    const secondClosed = closed(second);
    assert.equal(closeUserWebSockets(7), 2);
    assert.deepEqual(await firstClosed, { code: 4401, reason: 'Session revoked' });
    assert.deepEqual(await secondClosed, { code: 4401, reason: 'Session revoked' });
    assert.equal(other.readyState, WebSocket.OPEN);
    // Released once per closed socket.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(gateway.calls.released, 2);
    assert.equal(closeUserWebSockets(7), 0);

    const otherClosed = closed(other);
    other.close();
    await otherClosed;
  } finally {
    await gateway.close();
  }
});

test('a message over the payload limit closes the socket with 1009', async () => {
  const gateway = await startGateway(() => ({ allowed: true }));
  try {
    const socket = await open(gateway.url('user-7'));
    const result = closed(socket);
    socket.send('x'.repeat(4096));
    assert.equal((await result).code, 1009);
  } finally {
    await gateway.close();
  }
});
