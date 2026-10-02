import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import zlib from 'node:zlib';

import express from 'express';

import { createWebClientModule } from '../index.js';

type RawResponse = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

// A bundle-like script: big enough to compress, repetitive enough to shrink a lot.
const BUNDLE = `export const studio = ${JSON.stringify(Array.from({ length: 400 }, (_, index) => ({ index, label: `tile-${index}` })))};\n`;
const INDEX_HTML = `<!doctype html><html><head><title>Agent Cloud Studio</title><style>${'.acs-launch{position:fixed}'.repeat(80)}</style></head><body><div id="root"></div></body></html>`;

let rootDir = '';
let distDir = '';
let server: http.Server;
let origin = '';

// Raw HTTP on purpose: fetch() would decode Content-Encoding and hide what went over the wire.
function request(urlPath: string, headers: http.OutgoingHttpHeaders = {}, method = 'GET'): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(`${origin}${urlPath}`, { method, headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks) }));
      incoming.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

before(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-client-test-'));
  distDir = path.join(rootDir, 'dist');
  await fs.mkdir(path.join(distDir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(distDir, 'index.html'), INDEX_HTML);
  await fs.writeFile(path.join(distDir, 'assets', 'index-abc123.js'), BUNDLE);
  await fs.writeFile(path.join(distDir, 'assets', 'cache-probe-def456.js'), BUNDLE);
  await fs.writeFile(path.join(distDir, 'assets', 'mark-0a1b2c.png'), Buffer.alloc(4096, 7));
  await fs.writeFile(path.join(rootDir, 'secret.js'), BUNDLE.replace('studio', 'secret'));

  // The same wiring as server/index.ts.
  const webClient = createWebClientModule({ distDir });
  const app = express();
  app.use(webClient.compressedAssets);
  app.use(express.static(distDir, { index: false, setHeaders: webClient.staticCacheHeaders }));
  app.get('*', (req, res, next) => {
    if (path.extname(req.path)) {
      res.status(404).send('Not found');
      return;
    }
    webClient.sendIndexHtml(req, res, next);
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(rootDir, { recursive: true, force: true });
});

test('hashed bundles go out brotli-compressed, cached for a year and varying by encoding', async () => {
  const response = await request('/assets/index-abc123.js', { 'Accept-Encoding': 'gzip, deflate, br' });

  assert.equal(response.status, 200);
  assert.equal(response.headers['content-encoding'], 'br');
  assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.match(String(response.headers.vary), /accept-encoding/i);
  assert.match(String(response.headers['content-type']), /javascript/);
  assert.equal(Number(response.headers['content-length']), response.body.length);
  assert.ok(response.body.length < BUNDLE.length / 3, `expected real compression, got ${response.body.length} bytes`);
  assert.equal(zlib.brotliDecompressSync(response.body).toString(), BUNDLE);
});

test('gzip is used when brotli is refused or not offered', async () => {
  const refused = await request('/assets/index-abc123.js', { 'Accept-Encoding': 'br;q=0, gzip' });
  assert.equal(refused.headers['content-encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(refused.body).toString(), BUNDLE);

  const notOffered = await request('/assets/index-abc123.js', { 'Accept-Encoding': 'gzip, deflate' });
  assert.equal(notOffered.headers['content-encoding'], 'gzip');
});

test('without an accepted encoding the bundle is sent as it is, still immutable', async () => {
  const response = await request('/assets/index-abc123.js');

  assert.equal(response.status, 200);
  assert.equal(response.headers['content-encoding'], undefined);
  assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.match(String(response.headers.vary), /accept-encoding/i);
  assert.equal(response.body.toString(), BUNDLE);
});

test('a compressed bundle is kept in memory and recompressed only when the file changes', async () => {
  const filePath = path.join(distDir, 'assets', 'cache-probe-def456.js');
  // Whole seconds, so the mtime can be restored exactly (the file system keeps sub-millisecond digits).
  const mtime = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  await fs.utimes(filePath, mtime, mtime);
  const first = await request('/assets/cache-probe-def456.js', { 'Accept-Encoding': 'br' });
  assert.equal(zlib.brotliDecompressSync(first.body).toString(), BUNDLE);

  // Same size and mtime, different bytes: only a cached copy can still answer with the old content.
  const changed = BUNDLE.replace('studio', 'STUDIO');
  await fs.writeFile(filePath, changed);
  await fs.utimes(filePath, mtime, mtime);
  const cached = await request('/assets/cache-probe-def456.js', { 'Accept-Encoding': 'br' });
  assert.equal(zlib.brotliDecompressSync(cached.body).toString(), BUNDLE);

  // A new mtime (a rebuild) invalidates the copy.
  const later = new Date(mtime.getTime() + 5000);
  await fs.utimes(filePath, later, later);
  const fresh = await request('/assets/cache-probe-def456.js', { 'Accept-Encoding': 'br' });
  assert.equal(zlib.brotliDecompressSync(fresh.body).toString(), changed);
});

test('a revalidation with the current ETag gets 304 and no body', async () => {
  const first = await request('/assets/index-abc123.js', { 'Accept-Encoding': 'br' });
  const etag = String(first.headers.etag);
  assert.match(etag, /br"$/);

  const revalidated = await request('/assets/index-abc123.js', { 'Accept-Encoding': 'br', 'If-None-Match': etag });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.body.length, 0);
});

test('HEAD answers with the compressed headers and no body', async () => {
  const response = await request('/assets/index-abc123.js', { 'Accept-Encoding': 'br' }, 'HEAD');

  assert.equal(response.status, 200);
  assert.equal(response.headers['content-encoding'], 'br');
  assert.equal(response.body.length, 0);
});

test('binary assets are not recompressed', async () => {
  const response = await request('/assets/mark-0a1b2c.png', { 'Accept-Encoding': 'br, gzip' });

  assert.equal(response.status, 200);
  assert.equal(response.headers['content-encoding'], undefined);
  assert.equal(response.body.length, 4096);
});

test('asset paths cannot reach files outside dist/assets', async () => {
  for (const attempt of ['/assets/..%2f..%2fsecret.js', '/assets/%2e%2e/%2e%2e/secret.js', '/assets/..%5c..%5csecret.js']) {
    const response = await request(attempt, { 'Accept-Encoding': 'br' });
    assert.ok(response.status >= 400, `${attempt} answered ${response.status}`);
    assert.equal(response.headers['content-encoding'], undefined, attempt);
    assert.ok(!response.body.toString().includes('secret'), attempt);
  }
});

test('index.html is compressed for app routes and revalidated on every launch', async () => {
  for (const route of ['/', '/projects/t212']) {
    const response = await request(route, { 'Accept-Encoding': 'gzip, br' });
    assert.equal(response.status, 200, route);
    assert.equal(response.headers['content-encoding'], 'br', route);
    assert.equal(response.headers['cache-control'], 'no-cache', route);
    assert.match(String(response.headers['content-type']), /text\/html/, route);
    assert.equal(zlib.brotliDecompressSync(response.body).toString(), INDEX_HTML, route);
  }

  const plain = await request('/workspace');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.headers['cache-control'], 'no-cache');
  assert.equal(plain.body.toString(), INDEX_HTML);
});
