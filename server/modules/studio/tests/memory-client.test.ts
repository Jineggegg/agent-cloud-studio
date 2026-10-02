import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { test } from 'node:test';

import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, McpError, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { createMemoryMcpClient } from '../memory/memory-client.adapter.js';

// A tiny in-process MCP server (no basic-memory needed): `echo` answers with structured content, `plain` with JSON
// text, `broken` with a tool error, `slow` after 300 ms; any other name is a protocol error. `forget()` drops every session the way a
// server restart does; `stats.initializeDelayMs` holds back the answer to initialize, like a server still starting.
async function fakeServer(port = 0) {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const stats = { initialized: 0, initializeDelayMs: 0 };
  const app = express();
  app.use(express.json());
  app.post('/mcp', async (req, res) => {
    const id = req.get('mcp-session-id');
    let transport = id ? sessions.get(id) : undefined;
    if (!transport) {
      if (id || !isInitializeRequest(req.body)) {
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
        return;
      }
      if (stats.initializeDelayMs) {
        await new Promise(resolve => setTimeout(resolve, stats.initializeDelayMs));
        // The client gave up meanwhile; answering a closed socket would only throw.
        if (res.destroyed || res.writableEnded) return;
      }
      stats.initialized += 1;
      const created = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: value => { sessions.set(value, created); } });
      transport = created;
      const server = new Server({ name: 'fake-memory', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(CallToolRequestSchema, async request => {
        const args = request.params.arguments ?? {};
        if (request.params.name === 'echo') return { content: [{ type: 'text', text: JSON.stringify(args) }], structuredContent: { result: args } };
        if (request.params.name === 'plain') return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
        if (request.params.name === 'broken') return { content: [{ type: 'text', text: 'note not found' }], isError: true };
        if (request.params.name === 'slow') {
          await new Promise(resolve => setTimeout(resolve, 300));
          return { content: [{ type: 'text', text: '"late"' }] };
        }
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool ${request.params.name}`);
      });
      await server.connect(created);
    }
    await transport.handleRequest(req, res, req.body);
  });
  // No standalone SSE stream and no explicit session teardown are needed here.
  app.get('/mcp', (_req, res) => { res.status(405).end(); });
  app.delete('/mcp', (_req, res) => { res.status(200).end(); });
  const http: HttpServer = app.listen(port, '127.0.0.1');
  await new Promise<void>(resolve => http.once('listening', resolve));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`,
    port: (http.address() as AddressInfo).port,
    stats,
    forget: () => sessions.clear(),
    close: () => new Promise<void>(resolve => { http.closeAllConnections(); http.close(() => resolve()); }),
  };
}

test('tool results are decoded and tool errors stay tool errors', async () => {
  const server = await fakeServer();
  const client = createMemoryMcpClient({ url: server.url });
  try {
    assert.deepEqual(await client.call('echo', { query: '部署' }), { query: '部署' });
    assert.deepEqual(await client.call('plain', {}), { ok: true });
    await assert.rejects(client.call('broken', {}), (error: { code?: string; statusCode?: number; message: string }) =>
      error.code === 'MEMORY_TOOL_ERROR' && error.statusCode === 502 && error.message === 'note not found');
    await assert.rejects(client.call('missing', {}), (error: { code?: string }) => error.code === 'MEMORY_TOOL_ERROR');
    await client.ping();
    assert.equal(server.stats.initialized, 1, 'one session serves every call, including after errors');
  } finally { await server.close(); }
});

test('a server restart is survived by reconnecting once', async () => {
  const server = await fakeServer();
  const client = createMemoryMcpClient({ url: server.url });
  try {
    await client.call('echo', { n: 1 });
    server.forget();
    assert.deepEqual(await client.call('echo', { n: 2 }), { n: 2 });
    assert.equal(server.stats.initialized, 2);
  } finally { await server.close(); }
});

test('a stopped server fails fast for a while, then is tried again', async () => {
  // Reserve a free port, then leave it closed so the first attempts are refused.
  const probe = await fakeServer();
  const port = probe.port;
  await probe.close();
  let clock = 0;
  const client = createMemoryMcpClient({ url: `http://127.0.0.1:${port}/mcp`, now: () => clock });
  await assert.rejects(client.call('echo', {}), (error: { code?: string; statusCode?: number }) => error.code === 'MEMORY_UNAVAILABLE' && error.statusCode === 503);
  const server = await fakeServer(port);
  try {
    clock = 5_000;
    await assert.rejects(client.ping(), (error: { code?: string }) => error.code === 'MEMORY_UNAVAILABLE');
    assert.equal(server.stats.initialized, 0, 'no request is made inside the fail-fast window');
    clock = 11_000;
    assert.deepEqual(await client.call('echo', { back: true }), { back: true });
  } finally { await server.close(); }
});

test('a slow tool times out without marking the server down or dropping the session', async () => {
  const server = await fakeServer();
  const client = createMemoryMcpClient({ url: server.url });
  try {
    await assert.rejects(client.call('slow', {}, { timeoutMs: 80 }), (error: { code?: string; statusCode?: number }) =>
      error.code === 'MEMORY_TIMEOUT' && error.statusCode === 504);
    assert.deepEqual(await client.call('echo', { next: true }), { next: true });
    await client.ping();
    assert.equal(server.stats.initialized, 1, 'the session that timed out is reused');
  } finally { await server.close(); }
});

test('a slow initialize is a timeout, not a stopped server: the next call connects at once', async () => {
  const server = await fakeServer();
  // The clock never moves, so any fail-fast window would refuse the second call.
  const client = createMemoryMcpClient({ url: server.url, now: () => 0, connectTimeoutMs: 80 });
  try {
    server.stats.initializeDelayMs = 400;
    await assert.rejects(client.ping(), (error: { code?: string; statusCode?: number }) => error.code === 'MEMORY_TIMEOUT' && error.statusCode === 504);
    server.stats.initializeDelayMs = 0;
    assert.deepEqual(await client.call('echo', { after: 'timeout' }), { after: 'timeout' });
  } finally { await server.close(); }
});

test('two initialize timeouts in a row mark the server hung: calls then fail fast as timeouts', async () => {
  const server = await fakeServer();
  let clock = 0;
  const client = createMemoryMcpClient({ url: server.url, now: () => clock, connectTimeoutMs: 80 });
  const isTimeout = (error: { code?: string; statusCode?: number }) => error.code === 'MEMORY_TIMEOUT' && error.statusCode === 504;
  try {
    server.stats.initializeDelayMs = 400;
    await assert.rejects(client.ping(), isTimeout);
    await assert.rejects(client.call('echo', {}), isTimeout);
    // Inside the window nothing waits on the hung server, and the error stays a timeout (the status card says slow).
    const started = Date.now();
    await assert.rejects(client.call('echo', {}), isTimeout);
    await assert.rejects(client.ping(), isTimeout);
    assert.ok(Date.now() - started < 60, 'calls in the window fail at once');
    // After the window one more attempt is made; another timeout re-opens the window straight away.
    clock = 11_000;
    await assert.rejects(client.call('echo', {}), isTimeout);
    const again = Date.now();
    await assert.rejects(client.call('echo', {}), isTimeout);
    assert.ok(Date.now() - again < 60, 'a still-hung server re-enters the fail-fast window');
    // A server that recovers connects once the window has passed, and the count starts over.
    clock = 22_000;
    server.stats.initializeDelayMs = 0;
    assert.deepEqual(await client.call('echo', { back: 1 }), { back: 1 });
  } finally { await server.close(); }
});

test('an aborted call rejects with the abort reason and keeps the server marked up', async () => {
  const server = await fakeServer();
  const client = createMemoryMcpClient({ url: server.url });
  try {
    const controller = new AbortController();
    controller.abort(new Error('stopped by user'));
    await assert.rejects(client.call('echo', {}, { signal: controller.signal }), /stopped by user/);
    assert.deepEqual(await client.call('echo', { ok: 1 }), { ok: 1 });
  } finally { await server.close(); }
});
