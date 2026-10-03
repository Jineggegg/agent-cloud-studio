import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';

import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import {
  STUDIO_APP_SANDBOX, STUDIO_APP_SITE_PREFIX, adaptAppCss, adaptAppHtml, adaptAppLocation, adaptAppScript,
} from './app-gateway.service.js';
import type { createStudioAppGateway } from './app-gateway.service.js';
import type { createStudioAppRunner } from './app-runner.service.js';

// Responses Studio rewrites (HTML, CSS, JavaScript) are read whole; anything larger passes through untouched.
const MAX_ADAPTED_BYTES = 10 * 1024 * 1024;
// Uploads an app may receive through the gateway.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 120_000;
// Request headers an app may see; cookies, Studio credentials and proxy headers never reach it.
const FORWARDED_REQUEST_HEADERS = new Set(['accept', 'accept-language', 'content-type', 'content-length', 'range', 'if-none-match',
  'if-modified-since', 'if-range', 'user-agent', 'cache-control', 'last-event-id']);
const BLOCKED_X_HEADERS = /^x-(forwarded|real-ip|refreshed-token|api-key|auth)/i;
// Response headers passed back to the browser; Studio sets its own security and caching headers.
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'content-disposition'];
const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
};

/** The app a user may run: its build's project folder. Throws 404 when the project is not an AI-built app of theirs. */
export type StudioAppLookup = (userId: number, projectId: string) => { directory: string; name: string };

function user(req: express.Request) {
  const id = Number((req as express.Request & { user?: { id: number } }).user?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError('需要登录', { statusCode: 401 });
  return id;
}

const runKey = (userId: number, projectId: string) => `${userId}:${projectId}`;

// What Studio adds to every gateway response: the app is sandboxed even when opened in a tab of its own.
function securityHeaders(res: express.Response) {
  res.setHeader('Content-Security-Policy', `sandbox ${STUDIO_APP_SANDBOX}; frame-ancestors 'self'`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}

function adapterFor(type: string): ((source: string, prefix: string) => string) | null {
  if (type.includes('text/html')) return adaptAppHtml;
  if (type.includes('text/css')) return adaptAppCss;
  if (/(java|ecma)script/.test(type)) return adaptAppScript;
  return null;
}

function forwardHeaders(headers: IncomingHttpHeaders, port: number) {
  const forwarded: Record<string, string> = { host: `127.0.0.1:${port}`, 'accept-encoding': 'identity' };
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (FORWARDED_REQUEST_HEADERS.has(lower) || (lower.startsWith('x-') && !BLOCKED_X_HEADERS.test(lower))) {
      forwarded[lower] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return forwarded;
}

function sendError(res: express.Response, status: number, message: string) {
  if (res.headersSent) { res.destroy(); return; }
  securityHeaders(res);
  res.status(status).type('text/plain; charset=utf-8').send(message);
}

// Serves a static app's file (GET/HEAD only), never a dotfile or anything outside its root, symlinks included.
function serveStatic(req: express.Request, res: express.Response, root: string, relative: string, prefix: string) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { sendError(res, 405, '静态应用只能读取'); return; }
  let decoded: string;
  try { decoded = decodeURIComponent(relative.split('?')[0]); } catch { sendError(res, 400, '地址无效'); return; }
  if (decoded.split('/').some(part => part.startsWith('.'))) { sendError(res, 404, '没有这个文件'); return; }
  const realRoot = realpathSync(root);
  let file = path.resolve(realRoot, `.${decoded}`);
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!existsSync(file)) { sendError(res, 404, '没有这个文件'); return; }
  const real = realpathSync(file);
  if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) { sendError(res, 404, '没有这个文件'); return; }
  const type = STATIC_TYPES[path.extname(real).toLowerCase()] ?? 'application/octet-stream';
  securityHeaders(res);
  res.setHeader('Content-Type', type);
  const adapt = adapterFor(type);
  const size = statSync(real).size;
  if (adapt && size <= MAX_ADAPTED_BYTES) {
    const chunks: Buffer[] = [];
    createReadStream(real).on('data', chunk => chunks.push(chunk as Buffer)).on('error', () => sendError(res, 500, '读取失败'))
      .on('end', () => res.status(200).send(req.method === 'HEAD' ? '' : adapt(Buffer.concat(chunks).toString('utf8'), prefix)));
    return;
  }
  res.setHeader('Content-Length', String(size));
  if (req.method === 'HEAD') { res.status(200).end(); return; }
  res.status(200);
  createReadStream(real).on('error', () => res.destroy()).pipe(res);
}

// Streams one request to the app on its loopback port; documents, stylesheets and scripts are adapted on the way back.
function proxy(req: express.Request, res: express.Response, port: number, relative: string, prefix: string) {
  let received = 0;
  const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: relative, headers: forwardHeaders(req.headers, port), timeout: UPSTREAM_TIMEOUT_MS });
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', () => sendError(res, 502, '应用没有回应'));
  res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
  upstream.on('response', response => {
    securityHeaders(res);
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers[name];
      if (value !== undefined) res.setHeader(name, value);
    }
    const location = response.headers.location;
    if (typeof location === 'string') res.setHeader('Location', adaptAppLocation(location, prefix));
    const type = String(response.headers['content-type'] ?? '');
    const adapt = adapterFor(type);
    const length = Number(response.headers['content-length'] ?? 0);
    if (!adapt || length > MAX_ADAPTED_BYTES || req.method === 'HEAD') {
      res.status(response.statusCode ?? 502);
      response.pipe(res);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ADAPTED_BYTES) { response.destroy(); sendError(res, 502, '应用的页面太大'); return; }
      chunks.push(chunk);
    });
    response.on('end', () => {
      if (res.headersSent) return;
      res.removeHeader('content-length');
      res.status(response.statusCode ?? 502).send(adapt(Buffer.concat(chunks).toString('utf8'), prefix));
    });
    response.on('error', () => sendError(res, 502, '应用的回应中断了'));
  });
  req.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) { upstream.destroy(); sendError(res, 413, '上传的内容太大'); req.destroy(); }
  });
  req.pipe(upstream);
}

/**
 * Mounted by studio.module at /api/studio/apps behind authentication: open (start the app if needed and get its
 * sandboxed address), read the status, and stop an AI-built app. `restart: true` on open starts it afresh.
 */
export function createStudioAppsRouter({ runner, gateway, lookup }: {
  runner: ReturnType<typeof createStudioAppRunner>;
  gateway: ReturnType<typeof createStudioAppGateway>;
  lookup: StudioAppLookup;
}) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.post('/:projectId/open', asyncHandler(async (req, res) => {
    const userId = user(req);
    const projectId = String(req.params.projectId);
    const { directory } = lookup(userId, projectId);
    const status = await runner.open(runKey(userId, projectId), directory, { restart: req.body?.restart === true });
    res.json({ ...status, url: status.state === 'running' ? gateway.grant(userId, projectId).url : null });
  }));
  router.get('/:projectId', asyncHandler(async (req, res) => {
    const userId = user(req);
    const projectId = String(req.params.projectId);
    lookup(userId, projectId);
    res.json(runner.status(runKey(userId, projectId)));
  }));
  router.post('/:projectId/stop', asyncHandler(async (req, res) => {
    const userId = user(req);
    const projectId = String(req.params.projectId);
    lookup(userId, projectId);
    res.json(runner.stop(runKey(userId, projectId)));
  }));
  return router;
}

/**
 * Mounted by the server at /api/studio/app-site WITHOUT session authentication or body parsing: the random token in
 * the path is the credential (createStudioAppGateway), requests stream to the app, and every response carries the
 * sandbox CSP so the app's code never runs with Studio's origin.
 */
export function createStudioAppSiteRouter({ runner, gateway, lookup }: {
  runner: ReturnType<typeof createStudioAppRunner>;
  gateway: ReturnType<typeof createStudioAppGateway>;
  lookup: StudioAppLookup;
}) {
  const router = express.Router();
  router.use(asyncHandler(async (req, res) => {
    const match = /^\/([a-f0-9]{64})(\/[^?#]*)?(\?.*)?$/.exec(req.url);
    if (!match) { sendError(res, 404, '没有这个应用'); return; }
    const [, token, rest, query = ''] = match;
    const grant = gateway.resolve(token);
    if (!grant) { sendError(res, 401, '应用入口已过期，请从 Studio 重新打开'); return; }
    const prefix = `${STUDIO_APP_SITE_PREFIX}/${token}`;
    // The document must sit under the trailing slash, or its relative addresses resolve one level too high.
    if (!rest) { res.redirect(308, `${prefix}/${query}`); return; }
    let app: { directory: string };
    try { app = lookup(grant.userId, grant.projectId); } catch { sendError(res, 404, '这个应用已被删除'); return; }
    let target: Awaited<ReturnType<typeof runner.target>>;
    try { target = await runner.target(runKey(grant.userId, grant.projectId), app.directory); } catch (failure) {
      sendError(res, 502, failure instanceof Error ? failure.message : '应用没有在运行');
      return;
    }
    if (target.kind === 'static') serveStatic(req, res, target.root, rest, prefix);
    else proxy(req, res, target.port, `${rest}${query}`, prefix);
  }));
  return router;
}
