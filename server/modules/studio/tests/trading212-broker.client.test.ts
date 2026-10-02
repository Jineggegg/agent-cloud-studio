import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createTrading212BrokerClient } from '../trading212-broker.client.js';

type Respond = (socket: net.Socket) => void;
type Settlement = { kind: 'resolved'; value: unknown } | { kind: 'rejected'; error: Error & { code?: string; statusCode?: number } };

const ORIGIN = 'https://studio.ajarche.com';
const CONFIRM = { origin: ORIGIN, id: '00000000-0000-0000-0000-000000000000', confirmed: true as const };
const PREVIEW = { origin: ORIGIN, order: { env: 'demo' }, acknowledgeUnknown: false };
const DEADLINE_MS = 300;

/**
 * A broker stand-in at the byte level, so a test can stall, cut or flood a response the way a crashed, killed or
 * misbehaving broker would. `respond` runs once the whole request (headers and Content-Length body) has arrived.
 */
async function rawBroker(respond: Respond) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 't212-raw-broker-'));
  const socketPath = path.join(directory, 'broker.sock');
  const closed: number[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => { closed.push(Date.now()); sockets.delete(socket); });
    let buffered = Buffer.alloc(0);
    let answered = false;
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      const headerEnd = buffered.indexOf('\r\n\r\n');
      if (answered || headerEnd < 0) return;
      const length = Number(/content-length:\s*(\d+)/i.exec(buffered.subarray(0, headerEnd).toString('latin1'))?.[1] ?? 0);
      if (buffered.length - headerEnd - 4 < length) return;
      answered = true;
      respond(socket);
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  return {
    socketPath, closed,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

// Records every way the call ends, then waits past the client's deadline: a second settlement attempt, a late
// timer or a stray error event would show up as an uncaught exception or unhandled rejection in that window.
async function settleOf(call: () => Promise<unknown>, waitAfterMs = DEADLINE_MS + 200) {
  const stray: unknown[] = [];
  const onStray = (error: unknown) => { stray.push(error); };
  process.on('uncaughtException', onStray);
  process.on('unhandledRejection', onStray);
  try {
    const settlements: Settlement[] = [];
    const started = Date.now();
    await call().then(
      value => { settlements.push({ kind: 'resolved', value }); },
      error => { settlements.push({ kind: 'rejected', error }); },
    );
    const elapsed = Date.now() - started;
    await delay(waitAfterMs);
    assert.deepEqual(stray, [], 'nothing fires after the call has ended');
    assert.equal(settlements.length, 1);
    return { settlement: settlements[0], elapsed };
  } finally {
    process.off('uncaughtException', onStray);
    process.off('unhandledRejection', onStray);
  }
}
function rejectedWith(result: { settlement: Settlement }, code: string, statusCode: number) {
  assert.equal(result.settlement.kind, 'rejected', `expected ${code}`);
  const { error } = result.settlement as Extract<Settlement, { kind: 'rejected' }>;
  assert.equal(error.code, code);
  assert.equal(error.statusCode, statusCode);
}
function client(socketPath: string) {
  return createTrading212BrokerClient({ socketPath, timeoutMs: DEADLINE_MS, confirmTimeoutMs: DEADLINE_MS });
}

test('a well-formed response resolves, and a broker refusal keeps its own code (control for the fake broker)', async () => {
  const body = JSON.stringify({ error: 'already used', code: 'T212_PREVIEW_GONE' });
  const ok = await rawBroker(socket => socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 13\r\n\r\n{"placed":1}\n`));
  const refused = await rawBroker(socket => socket.end(`HTTP/1.1 404 Not Found\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
  try {
    const placed = await settleOf(() => client(ok.socketPath).confirm(CONFIRM), 0);
    assert.deepEqual(placed.settlement, { kind: 'resolved', value: { placed: 1 } });
    rejectedWith(await settleOf(() => client(refused.socketPath).confirm(CONFIRM), 0), 'T212_PREVIEW_GONE', 404);
  } finally { await ok.close(); await refused.close(); }
});

test('a broker that never answers: the absolute deadline settles once, as unknown for a confirmation', async () => {
  const broker = await rawBroker(() => { /* accepts the request and says nothing */ });
  try {
    const confirm = await settleOf(() => client(broker.socketPath).confirm(CONFIRM));
    rejectedWith(confirm, 'T212_ORDER_UNKNOWN', 502);
    assert.ok(confirm.elapsed >= DEADLINE_MS - 20 && confirm.elapsed < DEADLINE_MS + 1_000, `settled after ${confirm.elapsed} ms`);
    rejectedWith(await settleOf(() => client(broker.socketPath).preview(PREVIEW)), 'T212_BROKER_UNREACHABLE', 503);
    // The client gave up on both connections instead of leaving them open.
    assert.equal(broker.closed.length, 2);
  } finally { await broker.close(); }
});

test('a response that trickles in forever is cut off by the absolute deadline, not kept alive by each byte', async () => {
  const timers: NodeJS.Timeout[] = [];
  const broker = await rawBroker(socket => {
    socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"orderId":');
    timers.push(setInterval(() => { if (!socket.destroyed) socket.write(' '); }, 40));
  });
  try {
    const confirm = await settleOf(() => client(broker.socketPath).confirm(CONFIRM));
    rejectedWith(confirm, 'T212_ORDER_UNKNOWN', 502);
    assert.ok(confirm.elapsed < DEADLINE_MS + 1_000, `settled after ${confirm.elapsed} ms`);
    rejectedWith(await settleOf(() => client(broker.socketPath).preview(PREVIEW)), 'T212_BROKER_UNREACHABLE', 503);
  } finally {
    for (const timer of timers) clearInterval(timer);
    await broker.close();
  }
});

test('a connection dropped in the middle of the body settles at once, as unknown for a confirmation', async () => {
  const broker = await rawBroker(socket => {
    socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"orderId":12');
    setTimeout(() => socket.destroy(), 20);
  });
  try {
    // Deadlines far away: only the dropped connection can end these calls.
    const confirm = await settleOf(() => createTrading212BrokerClient({ socketPath: broker.socketPath, confirmTimeoutMs: 10_000 }).confirm(CONFIRM));
    rejectedWith(confirm, 'T212_ORDER_UNKNOWN', 502);
    assert.ok(confirm.elapsed < 2_000, `settled after ${confirm.elapsed} ms, not at the deadline`);
    const preview = await settleOf(() => createTrading212BrokerClient({ socketPath: broker.socketPath, timeoutMs: 10_000 }).preview(PREVIEW));
    rejectedWith(preview, 'T212_BROKER_UNREACHABLE', 503);
    assert.ok(preview.elapsed < 2_000);
  } finally { await broker.close(); }
});

test('a success whose body ends early without a length (connection close) is never taken as a result', async () => {
  const broker = await rawBroker(socket => socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"orderId":12'));
  try {
    rejectedWith(await settleOf(() => client(broker.socketPath).confirm(CONFIRM), 0), 'T212_ORDER_UNKNOWN', 502);
    rejectedWith(await settleOf(() => client(broker.socketPath).status(), 0), 'T212_BROKER_UNREACHABLE', 503);
  } finally { await broker.close(); }
});

test('an oversized body is refused once, the connection closed, and a confirmation reported as unknown', async () => {
  const broker = await rawBroker(socket => {
    socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n');
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    // Far more than the client's 256 KiB limit, written until the client hangs up.
    let sent = 0;
    const pump = () => {
      while (!socket.destroyed && sent < 64) {
        sent += 1;
        if (!socket.write(`${chunk.length.toString(16)}\r\n`) || !socket.write(chunk) || !socket.write('\r\n')) { socket.once('drain', pump); return; }
      }
    };
    pump();
  });
  try {
    const confirm = await settleOf(() => client(broker.socketPath).confirm(CONFIRM));
    rejectedWith(confirm, 'T212_ORDER_UNKNOWN', 502);
    assert.ok(confirm.elapsed < DEADLINE_MS, `refused after ${confirm.elapsed} ms, before the deadline`);
    rejectedWith(await settleOf(() => client(broker.socketPath).preview(PREVIEW)), 'T212_BROKER_UNREACHABLE', 503);
    assert.equal(broker.closed.length, 2);
  } finally { await broker.close(); }
});

test('a missing socket means the request never left Studio: unreachable, never unknown', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 't212-raw-broker-'));
  try {
    rejectedWith(await settleOf(() => client(path.join(directory, 'missing.sock')).confirm(CONFIRM), 0), 'T212_BROKER_UNREACHABLE', 503);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
