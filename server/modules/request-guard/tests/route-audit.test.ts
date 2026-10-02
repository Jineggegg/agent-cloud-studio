import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

// The whole server is assembled in-process (server/app.ts) on a throwaway home directory and
// database, and every route it mounts is called without credentials. Environment first: modules
// read it when they are imported. node --test runs each file in its own process.
const tempHome = await mkdtemp(path.join(os.tmpdir(), 'route-audit-'));
await mkdir(path.join(tempHome, '.cloudcli'), { recursive: true });
const databasePath = path.join(tempHome, '.cloudcli', 'auth.db');
await writeFile(databasePath, '');
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.DATABASE_PATH = databasePath;
process.env.JWT_SECRET = 'route-audit-test-secret';
for (const name of Object.keys(process.env)) {
  if (name.startsWith('STUDIO_') || name === 'API_KEY' || name === 'VITE_IS_PLATFORM') delete process.env[name];
}

const database = await import('@/modules/database/index.js');
await database.initializeDatabase();
database.userDb.createUser('andrew', '$2b$12$tGGCKzQOSdxNXD/GlV9lc.3ajYv0196H6VwHboOo.SJQJ9G/KFQH2');
// The application root is not a feature module; the test walks exactly what the entrypoint serves.
// eslint-disable-next-line boundaries/no-unknown
const { createStudioServer } = await import('../../../app.js');
const { app, server } = createStudioServer();

server.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const port = (server.address() as AddressInfo).port;
const baseUrl = `http://127.0.0.1:${port}`;

test.after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => (server as Server).close(resolve));
  database.closeConnection();
  await rm(tempHome, { recursive: true, force: true });
});

type ExpressLayer = {
  name?: string;
  regexp: RegExp & { fast_slash?: boolean };
  route?: { path: string | RegExp | (string | RegExp)[]; methods: Record<string, boolean> };
  handle: { stack?: ExpressLayer[] };
};

// `mountRoot` marks the probe of a mounted router's root, which may have no route of its own.
type RouteProbe = { method: string; path: string; mountRoot?: boolean };

// The literal mount path of `app.use('/x/y', ...)` (Express 4 compiles it to ^\/x\/y\/?(?=\/|$)).
function mountPathOf(layer: ExpressLayer): string | null {
  if (layer.regexp.fast_slash) return '';
  const match = /^\^((?:\\\/[^\\?()]+)+)\\\/\?\(\?=\\\/\|\$\)$/i.exec(layer.regexp.source);
  return match ? match[1].replace(/\\\//g, '/') : null;
}

// Concrete paths for route patterns: parameters and wildcards become a harmless value.
function concretePaths(routePath: string | RegExp | (string | RegExp)[]): string[] {
  const paths = Array.isArray(routePath) ? routePath : [routePath];
  return paths.flatMap((candidate) => (typeof candidate === 'string'
    ? [candidate.replace(/:(\w+)\??(\([^)]*\))?/g, 'probe').replace(/\*/g, 'probe')]
    : []));
}

// Every route the app serves, including the router-wide handlers (`router.use`) of mounted routers.
function walk(stack: ExpressLayer[], prefix: string, probes: RouteProbe[], unknownMounts: string[]) {
  for (const layer of stack) {
    if (layer.route) {
      for (const routePath of concretePaths(layer.route.path)) {
        for (const method of Object.keys(layer.route.methods)) {
          if (method !== '_all') probes.push({ method: method.toUpperCase(), path: `${prefix}${routePath}` });
          else probes.push({ method: 'GET', path: `${prefix}${routePath}` }, { method: 'POST', path: `${prefix}${routePath}` });
        }
      }
    } else if (layer.handle.stack) {
      const mount = mountPathOf(layer);
      if (mount === null) {
        unknownMounts.push(layer.regexp.source);
        continue;
      }
      // A router that answers everything itself (the SNR gateway) is probed at its root.
      probes.push({ method: 'GET', path: `${prefix}${mount}/`, mountRoot: true }, { method: 'POST', path: `${prefix}${mount}/`, mountRoot: true });
      walk(layer.handle.stack, `${prefix}${mount}`, probes, unknownMounts);
    }
  }
}

const probes: RouteProbe[] = [];
const unknownMounts: string[] = [];
walk((app as unknown as { _router: { stack: ExpressLayer[] } })._router.stack, '', probes, unknownMounts);
// A real route wins over the root probe of the same path.
const uniqueProbes = [...probes.reduce((byKey, probe) => {
  const key = `${probe.method} ${probe.path}`;
  if (!byKey.has(key) || byKey.get(key)?.mountRoot) byKey.set(key, probe);
  return byKey;
}, new Map<string, RouteProbe>()).values()];

// Every endpoint that answers without a session, what it answers, and why that is safe. A new
// public route fails the walk below until it is added here (and to docs/security.md).
const PUBLIC_ROUTES: Record<string, { status: number[]; why: string }> = {
  'GET /health': { status: [200], why: 'status, time, version and install mode only (update check)' },
  'GET /api/auth/status': { status: [200], why: 'only whether first-run setup is needed' },
  'POST /api/auth/register': { status: [403], why: 'refused once an account exists' },
  'POST /api/auth/login': { status: [400], why: 'password sign-in; throttled, locked out, generic errors' },
  'POST /api/auth/passkey/options': { status: [403], why: 'a challenge for a configured door only' },
  'POST /api/auth/passkey': { status: [403], why: 'passkey sign-in; generic refusal' },
  'POST /api/auth/tailscale-session': { status: [403], why: 'owner devices through Tailscale Serve only' },
  'POST /api/auth/handoff/redeem': { status: [400], why: 'single-use 60 s codes, throttled' },
  'GET /api/studio/gmail/callback/': { status: [400], why: 'OAuth state bound to a signed-in user' },
  'GET /api/studio/snr-site/': { status: [401], why: 'scoped cookie checked first' },
  'POST /api/studio/snr-site/': { status: [401], why: 'scoped cookie checked first' },
};

function bodyKeys(body: unknown): string[] {
  return typeof body === 'object' && body !== null ? Object.keys(body).sort() : [];
}

test('the route walk found the whole route table', (context) => {
  context.diagnostic(`${uniqueProbes.filter((probe) => !probe.mountRoot).length} routes, ${uniqueProbes.length} probes`);
  assert.deepEqual(unknownMounts, []);
  // Every module mounted by the entrypoint contributes routes; a broken walk would find a handful.
  assert.ok(uniqueProbes.length > 150, `only ${uniqueProbes.length} routes found`);
  for (const mount of ['/api/auth', '/api/studio', '/api/projects', '/api/git', '/api/settings', '/api/agent', '/api/browser-use-mcp']) {
    assert.ok(uniqueProbes.some((probe) => probe.path.startsWith(`${mount}/`)), `no routes found under ${mount}`);
  }
});

test('no route returns data without credentials, on the public door or locally', async () => {
  const failures: string[] = [];
  let index = 0;
  for (const probe of uniqueProbes) {
    // The web client's catch-all (`GET *`) serves the app shell (or, without a build, a redirect
    // to Vite); the static test below covers it.
    if (!probe.path.startsWith('/')) continue;
    for (const door of ['cloudflare', 'local'] as const) {
      index += 1;
      // Through cloudflared: loopback socket plus Cloudflare's headers, a fresh client each time.
      const headers: Record<string, string> = door === 'cloudflare'
        ? { 'cf-ray': `8c1f2e3d4a5b${index}-HKG`, 'cf-connecting-ip': `198.51.${Math.floor(index / 250) % 250}.${index % 250}`, 'cdn-loop': 'cloudflare; loops=1', host: 'studio.ajarche.com' }
        : {};
      const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(probe.method);
      const response = await fetch(`${baseUrl}${probe.path}`, {
        method: probe.method,
        headers: { ...headers, ...(hasBody ? { 'content-type': 'application/json' } : {}) },
        body: hasBody ? '{}' : undefined,
        redirect: 'manual',
      });
      const text = await response.text();
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { body = text; }
      const key = `${probe.method} ${probe.path}`;
      const declared = PUBLIC_ROUTES[key];
      if (declared) {
        if (!declared.status.includes(response.status)) failures.push(`${key} (${door}) -> ${response.status}, expected ${declared.status.join('/')}`);
        continue;
      }
      // Everything else must refuse: 401 from authenticateToken or the route's own credential
      // check (or 404 at a router root without a route), with nothing but an error in the body.
      if (response.status !== 401 && !(probe.mountRoot && response.status === 404)) {
        failures.push(`${key} (${door}) -> ${response.status} ${text.slice(0, 120)}`);
        continue;
      }
      const keys = bodyKeys(body);
      if (!keys.every((name) => ['code', 'error', 'success'].includes(name))) failures.push(`${key} (${door}) -> ${response.status} body ${keys.join(',')}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('the public endpoints answer without data, and register is refused once an account exists', async () => {
  const health = await (await fetch(`${baseUrl}/health`)).json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(health).sort(), ['installMode', 'status', 'timestamp', 'version']);
  assert.deepEqual(await (await fetch(`${baseUrl}/api/auth/status`)).json(), { needsSetup: false, isAuthenticated: false });

  const register = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'intruder', password: 'long enough password' }),
  });
  assert.equal(register.status, 403);
  assert.equal(((await register.json()) as { error: { code: string } }).error.code, 'AUTH_USER_ALREADY_CONFIGURED');
  assert.equal(database.userDb.getUserByUsername('intruder'), undefined);

  // Unknown API paths are a JSON 404, never the web client.
  const unknown = await fetch(`${baseUrl}/api/does-not-exist`);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
});

test('static paths serve only the web client and public files, never the repository', async () => {
  for (const probe of ['/.env', '/..%2f.env', '/%2e%2e/package.json', '/assets/..%2f..%2fpackage.json', '/server/index.ts', '/node_modules/express/package.json', '/.git/config', '/public/../package.json']) {
    const response = await fetch(`${baseUrl}${probe}`, { redirect: 'manual' });
    const text = await response.text();
    assert.ok(![200, 206].includes(response.status) || !/"name":\s*"agent-cloud-studio"|\[core\]|JWT_SECRET/.test(text), `${probe} leaked ${text.slice(0, 80)}`);
    assert.notEqual(response.status, 500, probe);
  }
  const manifest = await fetch(`${baseUrl}/manifest.json`);
  assert.equal(manifest.status, 200);
});

test('oversized bodies are refused before authentication or routing reads them', async () => {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'andrew', password: 'x'.repeat(64 * 1024) }),
  });
  assert.equal(login.status, 413);
  // A protected route never parses the body of a request without a valid token: 401, not 413.
  const protectedRoute = await fetch(`${baseUrl}/api/settings/api-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blob: 'x'.repeat(1024 * 1024) }),
  });
  assert.equal(protectedRoute.status, 401);
});

test('the HTTP server carries the DoS limits', () => {
  assert.ok(server.headersTimeout > 0 && server.headersTimeout <= 120_000);
  assert.ok(server.requestTimeout > 0 && server.requestTimeout <= 300_000);
  assert.ok(server.keepAliveTimeout > 0);
  assert.ok((server.maxRequestsPerSocket ?? 0) > 0);
  assert.ok(server.maxConnections > 0);
});

test('every WebSocket path refuses an upgrade without a token', async () => {
  for (const wsPath of ['/ws', '/shell', '/desktop-notifications', '/plugin-ws/example']) {
    const status = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
      socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      socket.once('open', () => { socket.close(); resolve(101); });
      socket.once('error', () => undefined);
    });
    assert.equal(status, 401, wsPath);
  }
});
