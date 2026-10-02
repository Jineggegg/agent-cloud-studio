import { randomBytes } from 'node:crypto';

import { parse, parseFragment, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

import { AppError, readSnrBasicAuthorization } from '@/shared/utils.js';

const PREFIX = '/api/studio/snr-site';
const LIFE = 30 * 60 * 1000;
// Lab pages, static assets and the lab API families the workbench uses; writes are further limited to /api/.
const LAB_PATH = /^(\/replay|\/static\/[a-zA-Z0-9_./-]+|\/api\/(?:health|detector|speech|datasets|sessions)(?:\/[^?#]*)?)$/;
// The read-only integration endpoints; session ids must be strict lowercase UUIDs, and only GET/HEAD may reach them.
const INTEGRATION_PATH = /^\/api\/integration\/v1\/(?:manifest|sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/context)$/;
// SNR edits levels, HPA and AOI annotations with PUT, so it must pass alongside the other write verbs.
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
type Node = DefaultTreeAdapterMap['node'];

// Runs before any lab script. SNR builds absolute /api/ and /static/ URLs at runtime (fetch calls, the
// dictation AudioWorklet module), which would otherwise resolve against Studio's root and miss the gateway.
// HTML src/href attributes are rewritten on the server instead. EventSource and WebSocket stay untouched:
// the gateway buffers responses and cannot upgrade connections, so rebasing them would only hide the failure.
const BRIDGE_SCRIPT = `(() => {
  const prefix = ${JSON.stringify(PREFIX)};
  const rebase = value => {
    try {
      const url = new URL(value instanceof Request ? value.url : String(value), location.href);
      if (url.origin !== location.origin || url.pathname.startsWith(prefix + '/')) return null;
      if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/static/')) return null;
      url.pathname = prefix + url.pathname;
      return url.href;
    } catch { return null; }
  };
  const studioFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = rebase(input);
    if (!url) return studioFetch(input, init);
    return studioFetch(input instanceof Request ? new Request(url, input) : url, init);
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { return open.call(this, method, rebase(url) ?? url, ...rest); };
  if (navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => beacon(rebase(url) ?? url, data);
  }
  if (window.AudioWorklet) {
    const addModule = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = function (url, options) { return addModule.call(this, rebase(url) ?? url, options); };
  }
  if (window.Worker) {
    const StudioWorker = window.Worker;
    window.Worker = class extends StudioWorker { constructor(url, options) { super(rebase(url) ?? url, options); } };
  }
})();`;

function adaptHtml(source: string) {
  const document = parse(source);
  function walk(node: Node) {
    if ('attrs' in node) {
      for (const attribute of node.attrs) {
        if (['src', 'href'].includes(attribute.name) && attribute.value.startsWith('/static/')) attribute.value = PREFIX + attribute.value;
      }
    }
    if ('tagName' in node && node.tagName === 'head') {
      const bridge = parseFragment(`<script>${BRIDGE_SCRIPT}</script>`);
      for (const child of bridge.childNodes) {
        child.parentNode = node;
        node.childNodes.unshift(child);
      }
    }
    if ('childNodes' in node) node.childNodes.forEach(walk);
  }
  walk(document);
  return serialize(document);
}

// Stylesheet url() and @import paths resolve against the stylesheet's own URL, so absolute lab paths need the prefix.
function adaptCss(source: string) {
  return source.replace(/(url\(\s*["']?|@import\s+["'])\/static\//g, `$1${PREFIX}/static/`);
}

// Only lab routes may leave Studio; integration endpoints are read-only and other writes stay on /api/.
function assertAllowed(pathname: string, method: string) {
  const read = method === 'GET' || method === 'HEAD';
  if (INTEGRATION_PATH.test(pathname)) {
    if (!read) throw new AppError('研究入口不允许此操作', { statusCode: 405 });
    return;
  }
  if (!LAB_PATH.test(pathname)) throw new AppError('研究入口路径不可用', { statusCode: 404 });
  if (!read && (!WRITE_METHODS.includes(method) || !pathname.startsWith('/api/'))) {
    throw new AppError('研究入口不允许此操作', { statusCode: 405 });
  }
}

/** Used by Studio's transport to grant a short-lived, user-bound gateway to the fixed local SNR app. */
export function createSnrGateway({ baseUrl, validUser, request = fetch, authorization = readSnrBasicAuthorization }: {
  baseUrl: string; validUser: (id: number) => boolean; request?: typeof fetch;
  // SNR's optional Basic credential, resolved per request (STUDIO_SNR_USER + STUDIO_SNR_PASSWORD_FILE by default).
  authorization?: () => string | null;
}) {
  const access = new Map<string, { id: number; expires: number }>();
  const base = new URL(baseUrl);
  // A gateway must never become an arbitrary-network proxy.
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
    throw new Error('SNR gateway must target a fixed loopback HTTP service');
  }
  return {
    grant(id: number) {
      for (const [key, value] of access) if (value.expires < Date.now()) access.delete(key);
      if (access.size >= 128) throw new AppError('研究入口暂时繁忙', { statusCode: 429 });
      const key = randomBytes(32).toString('hex');
      access.set(key, { id, expires: Date.now() + LIFE });
      return { key, maxAge: LIFE, url: `${PREFIX}/replay` };
    },
    authorized(key: string | undefined) {
      const entry = key ? access.get(key) : undefined;
      return Boolean(entry && entry.expires > Date.now() && validUser(entry.id));
    },
    revoke(id: number) {
      for (const [key, entry] of access) if (entry.id === id) access.delete(key);
    },
    async proxy(relative: string, method: string, body: RequestInit['body'], contentType: string | undefined, signal: AbortSignal) {
      const target = new URL(relative, base);
      if (target.origin !== base.origin) throw new AppError('研究入口路径不可用', { statusCode: 404 });
      assertAllowed(target.pathname, method);
      // Headers are built from scratch, so a browser can never hand its own credential to SNR.
      const headers: Record<string, string> = {};
      if (contentType) headers['Content-Type'] = contentType;
      if (method !== 'GET' && method !== 'HEAD') headers.Origin = base.origin;
      const credential = authorization();
      if (credential) headers.Authorization = credential;
      const response = await request(target, { method, body, headers, signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]), redirect: 'error', duplex: 'half' } as RequestInit);
      const type = response.headers.get('content-type') ?? 'application/octet-stream';
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 50 * 1024 * 1024) {
              await reader.cancel();
              throw new AppError('研究响应超过大小限制', { statusCode: 413 });
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      }
      const bytes = Buffer.concat(chunks);
      const adapt = type.includes('text/html') ? adaptHtml : type.includes('text/css') ? adaptCss : null;
      return {
        status: response.status, contentType: type,
        disposition: response.headers.get('content-disposition'),
        body: adapt ? Buffer.from(adapt(new TextDecoder().decode(bytes))) : Buffer.from(bytes),
      };
    },
  };
}
