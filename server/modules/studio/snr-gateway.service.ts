import { randomBytes } from 'node:crypto';

import { parse, parseFragment, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

import { AppError } from '@/shared/utils.js';

const PREFIX = '/api/studio/snr-site';
const LIFE = 30 * 60 * 1000;
type Node = DefaultTreeAdapterMap['node'];

function adaptHtml(source: string) {
  const document = parse(source);
  function walk(node: Node) {
    if ('attrs' in node) {
      for (const attribute of node.attrs) {
        if (['src', 'href'].includes(attribute.name) && attribute.value.startsWith('/static/')) attribute.value = PREFIX + attribute.value;
      }
    }
    if ('tagName' in node && node.tagName === 'head') {
      const bridge = parseFragment(`<script>
        const studioFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          if (url.origin === location.origin && url.pathname.startsWith('/api/') && !url.pathname.startsWith('${PREFIX}/')) {
            url.pathname = '${PREFIX}' + url.pathname;
            return studioFetch(input instanceof Request ? new Request(url, input) : url, init);
          }
          return studioFetch(input, init);
        };
      </script>`);
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

/** Used by Studio's transport to grant a short-lived, user-bound gateway to the fixed local SNR app. */
export function createSnrGateway({ baseUrl, validUser, request = fetch }: {
  baseUrl: string; validUser: (id: number) => boolean; request?: typeof fetch;
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
      if (target.origin !== base.origin || !/^(\/replay|\/static\/[a-zA-Z0-9_./-]+|\/api\/(?:health|detector|speech|datasets|sessions)(?:\/[^?#]*)?)$/.test(target.pathname)) {
        throw new AppError('研究入口路径不可用', { statusCode: 404 });
      }
      if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(method) || (method !== 'GET' && method !== 'HEAD' && !target.pathname.startsWith('/api/'))) {
        throw new AppError('研究入口不允许此操作', { statusCode: 405 });
      }
      const headers: Record<string, string> = {};
      if (contentType) headers['Content-Type'] = contentType;
      if (method !== 'GET' && method !== 'HEAD') headers.Origin = base.origin;
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
      return {
        status: response.status, contentType: type,
        disposition: response.headers.get('content-disposition'),
        body: type.includes('text/html') ? Buffer.from(adaptHtml(new TextDecoder().decode(bytes))) : Buffer.from(bytes),
      };
    },
  };
}
