import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { findApplicationRoot, getModuleDirectory } from '@/shared/utils.js';

import {
  applyHttpServerLimits,
  BODY_LIMITS,
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
  // Node's own guidance behind proxies, and every value non-zero (zero means "no limit").
  assert.ok(server.headersTimeout > server.keepAliveTimeout);
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
