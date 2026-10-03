import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { findApplicationRoot, getModuleDirectory } from '@/shared/utils.js';

import { startCloudflaredListener } from '../tunnel-listener.service.js';
import {
  applyHttpServerLimits,
  BODY_LIMITS,
  BODY_RECEIVE_DEADLINES,
  clientErrorStatus,
  createBodyParsers,
  HTTP_SERVER_LIMITS,
} from '../server-limits.service.js';

const SERVER_ROOT = path.join(findApplicationRoot(getModuleDirectory(import.meta.url)), 'server');

test('the HTTP server gets request, header and keep-alive timeouts and connection caps', () => {
  const server = http.createServer();
  applyHttpServerLimits(server);
  assert.equal(server.requestTimeout, HTTP_SERVER_LIMITS.requestTimeoutMs);
  assert.equal(server.headersTimeout, HTTP_SERVER_LIMITS.headersTimeoutMs);
  assert.equal(server.keepAliveTimeout, HTTP_SERVER_LIMITS.keepAliveTimeoutMs);
  assert.equal(server.maxRequestsPerSocket, HTTP_SERVER_LIMITS.maxRequestsPerSocket);
  assert.equal(server.maxConnections, HTTP_SERVER_LIMITS.maxConnections);
  // Every value non-zero (zero means "no limit"); headers have to come quickly.
  assert.ok(server.headersTimeout <= 30_000);
  assert.ok(server.requestTimeout >= server.headersTimeout);
  assert.ok(Object.values(HTTP_SERVER_LIMITS).every((value) => value > 0));
});

test('body parsers refuse bodies over their limit with 413 and malformed JSON with 400', async () => {
  const app = express();
  app.post('/small', ...createBodyParsers(BODY_LIMITS.public), (req: express.Request, res: express.Response) => { res.json({ received: Object.keys(req.body ?? {}).length }); });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(clientErrorStatus(error) ?? 500).json({ status: clientErrorStatus(error) });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/small`;
    const post = (body: string, type: string) => fetch(url, { method: 'POST', headers: { 'content-type': type }, body });
    assert.equal((await post(JSON.stringify({ username: 'andrew' }), 'application/json')).status, 200);
    assert.equal((await post(JSON.stringify({ blob: 'x'.repeat(40 * 1024) }), 'application/json')).status, 413);
    assert.equal((await post(`blob=${'x'.repeat(40 * 1024)}`, 'application/x-www-form-urlencoded')).status, 413);
    assert.equal((await post('{"broken', 'application/json')).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('clientErrorStatus only passes through exposed 4xx errors', () => {
  assert.equal(clientErrorStatus({ status: 413, expose: true, type: 'entity.too.large' }), 413);
  assert.equal(clientErrorStatus({ statusCode: 400 }), 400);
  assert.equal(clientErrorStatus({ status: 500 }), null);
  assert.equal(clientErrorStatus({ status: 401, expose: false }), null);
  assert.equal(clientErrorStatus(new Error('boom')), null);
  assert.equal(clientErrorStatus(null), null);
});

// Every server source file outside tests and node_modules.
function serverSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'tests' || entry.name === 'node_modules' ? [] : serverSources(full);
    return /\.(ts|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

// The argument text of each call `name(...)`, matched by parenthesis depth.
function callArguments(source: string, name: string): string[] {
  const calls: string[] = [];
  let index = source.indexOf(`${name}(`);
  while (index !== -1) {
    let depth = 0;
    let end = index + name.length;
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1;
      if (source[end] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(index + name.length + 1, end));
    index = source.indexOf(`${name}(`, end);
  }
  return calls;
}

test('every body parser and upload handler in the server states a size limit', () => {
  const findings: string[] = [];
  let parsers = 0;
  for (const file of serverSources(SERVER_ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const parser of ['express.json', 'express.urlencoded', 'express.raw', 'express.text', 'bodyParser.json', 'bodyParser.urlencoded', 'bodyParser.raw', 'bodyParser.text']) {
      for (const args of callArguments(source, parser)) {
        parsers += 1;
        if (!/\blimit\b/.test(args)) findings.push(`${path.relative(SERVER_ROOT, file)}: ${parser} without limit`);
      }
    }
    for (const args of callArguments(source, 'multer')) {
      if (!/\blimits\b/.test(args)) findings.push(`${path.relative(SERVER_ROOT, file)}: multer without limits`);
    }
  }
  assert.ok(parsers >= 2, 'the scan found the body parsers');
  assert.deepEqual(findings, []);
});

// A raw HTTP/1.1 exchange on one socket, so keep-alive and slow headers can be observed.
function rawSocket(port: number) {
  const socket = net.connect(port, '127.0.0.1');
  let received = '';
  socket.on('data', (chunk) => { received += chunk.toString('utf8'); });
  return {
    socket,
    write: (text: string) => socket.write(text),
    waitFor: (pattern: RegExp, timeoutMs = 3000) => new Promise<string>((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        if (pattern.test(received)) return resolve(received);
        if (Date.now() - started > timeoutMs) return reject(new Error(`no match for ${pattern}: ${received}`));
        setTimeout(check, 20);
      };
      check();
    }),
    closed: () => new Promise<void>((resolve) => { if (socket.destroyed) resolve(); else socket.once('close', () => resolve()); }),
  };
}

test('headersTimeout counts from each request\'s first byte: idle keep-alive survives it, slow headers do not', async () => {
  const server = http.createServer({ connectionsCheckingInterval: 50 }, (_req, res) => { res.end('ok'); });
  applyHttpServerLimits(server, { ...HTTP_SERVER_LIMITS, headersTimeoutMs: 300, requestTimeoutMs: 1000, keepAliveTimeoutMs: 3000 });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const keepAlive = rawSocket(port);
    keepAlive.write('GET /one HTTP/1.1\r\nHost: x\r\n\r\n');
    await keepAlive.waitFor(/ok$/);
    // Idle for longer than headersTimeout, then a second request on the same connection.
    await new Promise((resolve) => setTimeout(resolve, 700));
    keepAlive.write('GET /two HTTP/1.1\r\nHost: x\r\n\r\n');
    await keepAlive.waitFor(/ok[\s\S]*ok$/);
    keepAlive.socket.destroy();

    const slow = rawSocket(port);
    slow.write('GET /slow HTTP/1.1\r\nHost: x\r\n');
    await slow.waitFor(/408/, 3000);
    await slow.closed();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the cloudflared listener hands its connections to the main server, which sees the listener port', async () => {
  const seenPorts: number[] = [];
  const server = http.createServer((req, res) => {
    seenPorts.push(req.socket.localPort ?? 0);
    res.end('ok');
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const listener = await startCloudflaredListener(server, 0, { maxConnections: 10 });
  const mainPort = (server.address() as AddressInfo).port;
  const tunnelPort = (listener.address() as AddressInfo).port;
  try {
    assert.equal(await (await fetch(`http://127.0.0.1:${tunnelPort}/`)).text(), 'ok');
    assert.equal(await (await fetch(`http://127.0.0.1:${mainPort}/`)).text(), 'ok');
    assert.deepEqual(seenPorts, [tunnelPort, mainPort]);
    assert.equal(listener.maxConnections, 10);
  } finally {
    listener.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a pre-auth body that trickles in is answered 408 and cut off at its deadline', async () => {
  const app = express();
  app.post('/public', ...createBodyParsers(BODY_LIMITS.public, 300), (req: express.Request, res: express.Response) => { res.json({ got: req.body }); });
  app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) { next(error); return; }
    res.status(clientErrorStatus(error) ?? 500).json({});
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const slow = rawSocket(port);
    const started = Date.now();
    slow.write('POST /public HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 40\r\n\r\n{"a":');
    await slow.waitFor(/408/, 3000);
    await slow.closed();
    assert.ok(Date.now() - started < 2000);
    // A body that arrives in time is unaffected.
    const quick = await fetch(`http://127.0.0.1:${port}/public`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    assert.deepEqual(await quick.json(), { got: { a: 1 } });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  // Pre-auth deadlines are short; only authenticated uploads get the long requestTimeout.
  assert.ok(BODY_RECEIVE_DEADLINES.public <= 60_000 && BODY_RECEIVE_DEADLINES.gateway <= 60_000);
  assert.ok(HTTP_SERVER_LIMITS.requestTimeoutMs > BODY_RECEIVE_DEADLINES.gateway);
});
