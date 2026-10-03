import { randomBytes } from 'node:crypto';

import { parse, serialize } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

import { AppError } from '@/shared/utils.js';

/** Where the gateway is mounted; an app is served under `${STUDIO_APP_SITE_PREFIX}/<token>/`. */
export const STUDIO_APP_SITE_PREFIX = '/api/studio/app-site';
// An access is good for this long after its last use (the 主页 left open on an iPad keeps working).
const IDLE_LIFE_MS = 12 * 60 * 60_000;
// …but never longer than this after it was granted.
const MAX_LIFE_MS = 7 * 24 * 60 * 60_000;
const MAX_ACCESSES = 256;
const TOKEN = /^[a-f0-9]{64}$/;
// Attributes whose root-relative URL ("/style.css") must gain the app's prefix to reach it through the gateway.
const URL_ATTRIBUTES = new Set(['src', 'href', 'action', 'poster', 'formaction', 'data']);
type Node = DefaultTreeAdapterMap['node'];

/**
 * The sandbox every app document gets, as an iframe attribute (StudioAppHome) and as a CSP header on every gateway
 * response: no `allow-same-origin`, so an app's code runs in an opaque origin and can never read Studio's storage or
 * call Studio's API with the owner's credentials, even when its address is opened in a tab of its own.
 */
export const STUDIO_APP_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads';

// Rebases a root-relative URL ("/api/notes" → "<prefix>/api/notes"); anything else is returned unchanged.
function rebase(value: string, prefix: string) {
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith(`${prefix}/`) ? `${prefix}${value}` : value;
}

/**
 * Runs before the app's own scripts. Apps written for the root of a domain build root-relative URLs at runtime
 * (fetch, XHR, history, dynamically created elements); those are moved under the app's prefix here. Storage APIs
 * throw in the sandbox's opaque origin, so they are replaced with in-memory stand-ins that last as long as the page.
 */
function bridgeScript(prefix: string) {
  return `(() => {
  const prefix = ${JSON.stringify(prefix)};
  const here = location.protocol + '//' + location.host;
  const rebase = value => {
    if (value == null) return value;
    try {
      const raw = value instanceof Request ? value.url : String(value);
      const url = new URL(raw, location.href);
      if (url.protocol + '//' + url.host !== here || url.pathname.startsWith(prefix + '/') || url.pathname === prefix) return value;
      url.pathname = prefix + url.pathname;
      return value instanceof Request ? new Request(url.href, value) : url.href;
    } catch { return value; }
  };
  const rebaseHtml = html => typeof html === 'string'
    ? html.replace(/(\\s(?:src|href|action|poster)\\s*=\\s*["']?)\\/(?!\\/)/gi, '$1' + prefix + '/') : html;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => originalFetch(rebase(input), init);
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { return open.call(this, method, rebase(url), ...rest); };
  if (window.EventSource) {
    const Source = window.EventSource;
    window.EventSource = class extends Source { constructor(url, options) { super(rebase(url), options); } };
  }
  for (const name of ['pushState', 'replaceState']) {
    const method = history[name];
    history[name] = function (state, title, url) { return method.call(this, state, title, url == null ? url : rebase(url)); };
  }
  const windowOpen = window.open;
  window.open = function (url, ...rest) { return windowOpen.call(this, url == null ? url : rebase(url), ...rest); };
  if (navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => beacon(rebase(url), data);
  }
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    return setAttribute.call(this, name, /^(src|href|action|poster)$/i.test(name) ? rebase(value) : value);
  };
  for (const [Type, property] of [[HTMLImageElement, 'src'], [HTMLScriptElement, 'src'], [HTMLLinkElement, 'href'], [HTMLAnchorElement, 'href'],
    [HTMLMediaElement, 'src'], [HTMLSourceElement, 'src'], [HTMLIFrameElement, 'src'], [HTMLFormElement, 'action']]) {
    const descriptor = Object.getOwnPropertyDescriptor(Type.prototype, property);
    if (!descriptor || !descriptor.set) continue;
    Object.defineProperty(Type.prototype, property, { ...descriptor, set(value) { descriptor.set.call(this, rebase(value)); } });
  }
  for (const [Type, property] of [[Element, 'innerHTML'], [Element, 'outerHTML']]) {
    const descriptor = Object.getOwnPropertyDescriptor(Type.prototype, property);
    if (!descriptor || !descriptor.set) continue;
    Object.defineProperty(Type.prototype, property, { ...descriptor, set(value) { descriptor.set.call(this, rebaseHtml(value)); } });
  }
  const insertAdjacentHTML = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function (position, html) { return insertAdjacentHTML.call(this, position, rebaseHtml(html)); };
  const memoryStorage = () => {
    const items = new Map();
    return {
      get length() { return items.size; },
      key: index => Array.from(items.keys())[index] ?? null,
      getItem: key => (items.has(String(key)) ? items.get(String(key)) : null),
      setItem: (key, value) => { items.set(String(key), String(value)); },
      removeItem: key => { items.delete(String(key)); },
      clear: () => { items.clear(); },
    };
  };
  for (const name of ['localStorage', 'sessionStorage']) {
    try { void window[name]; } catch {
      try { Object.defineProperty(window, name, { value: memoryStorage(), configurable: true }); } catch { /* left as it is */ }
    }
  }
  // Reading navigator.serviceWorker itself throws in the sandbox; apps that register one get a polite refusal instead.
  try {
    const off = () => Promise.reject(new Error('Service workers are off inside Studio'));
    const container = { register: off, getRegistration: () => Promise.resolve(undefined), getRegistrations: () => Promise.resolve([]),
      ready: new Promise(() => {}), controller: null, addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(Navigator.prototype, 'serviceWorker', { get: () => container, configurable: true });
  } catch { /* left as it is */ }
})();`;
}

/** An app document with root-relative URLs moved under the app's prefix and the bridge script first in <head>. */
export function adaptAppHtml(source: string, prefix: string) {
  const document = parse(source);
  let injected = false;
  function walk(node: Node) {
    if ('attrs' in node) {
      for (const attribute of node.attrs) {
        if (URL_ATTRIBUTES.has(attribute.name)) attribute.value = rebase(attribute.value, prefix);
        else if (attribute.name === 'srcset') attribute.value = attribute.value.split(',').map(part => rebase(part.trim(), prefix)).join(', ');
      }
    }
    if (!injected && 'tagName' in node && node.tagName === 'head') {
      const fragment = parse(`<script>${bridgeScript(prefix)}</script>`);
      // parse() wraps the fragment in html/head; the script is the head's only child.
      const head = (fragment.childNodes.find(child => 'tagName' in child && child.tagName === 'html') as DefaultTreeAdapterMap['element'] | undefined)
        ?.childNodes.find(child => 'tagName' in child && child.tagName === 'head') as DefaultTreeAdapterMap['element'] | undefined;
      const script = head?.childNodes[0];
      if (script && 'tagName' in node) {
        script.parentNode = node;
        node.childNodes.unshift(script);
        injected = true;
      }
    }
    if ('childNodes' in node) node.childNodes.forEach(walk);
  }
  walk(document);
  return serialize(document);
}

/** A stylesheet whose root-relative url() and @import paths gain the app's prefix. */
export function adaptAppCss(source: string, prefix: string) {
  return source.replace(/(url\(\s*["']?|@import\s+["'])\/(?!\/)/g, `$1${prefix}/`);
}

/** A JavaScript module whose root-relative static and dynamic imports gain the app's prefix. */
export function adaptAppScript(source: string, prefix: string) {
  return source.replace(/(\bfrom\s*["']|\bimport\s*\(\s*["']|\bimport\s+["'])\/(?!\/)/g, `$1${prefix}/`);
}

/** A redirect inside the app stays inside the app's prefix. */
export function adaptAppLocation(location: string, prefix: string) {
  return rebase(location, prefix);
}

/**
 * Used by the Studio apps routes and gateway router: short-lived capability URLs for one user's app. The token in
 * the path is the whole credential (the sandboxed app sends no cookies), so it is random, bound to one user and one
 * project, expires after twelve idle hours or seven days, and every one of a user's tokens is dropped when they sign
 * out everywhere.
 */
export function createStudioAppGateway({ validUser, now = Date.now }: { validUser: (userId: number) => boolean; now?: () => number }) {
  const access = new Map<string, { userId: number; projectId: string; grantedAt: number; usedAt: number }>();
  const alive = (entry: { grantedAt: number; usedAt: number }) => now() - entry.usedAt < IDLE_LIFE_MS && now() - entry.grantedAt < MAX_LIFE_MS;

  return {
    /** A new address for the user's app; the client loads it in the sandboxed iframe. */
    grant(userId: number, projectId: string) {
      for (const [key, entry] of access) if (!alive(entry)) access.delete(key);
      if (access.size >= MAX_ACCESSES) throw new AppError('应用入口暂时繁忙', { statusCode: 429 });
      const token = randomBytes(32).toString('hex');
      access.set(token, { userId, projectId, grantedAt: now(), usedAt: now() });
      return { token, url: `${STUDIO_APP_SITE_PREFIX}/${token}/` };
    },
    /** The user and project a token opens, refreshing its idle clock; null when it is unknown or expired. */
    resolve(token: string): { userId: number; projectId: string } | null {
      if (!TOKEN.test(token)) return null;
      const entry = access.get(token);
      if (!entry || !alive(entry) || !validUser(entry.userId)) {
        if (entry) access.delete(token);
        return null;
      }
      entry.usedAt = now();
      return { userId: entry.userId, projectId: entry.projectId };
    },
    /** Drops every app address of one user (signing out everywhere); returns how many were still valid. */
    revoke(userId: number) {
      let revoked = 0;
      for (const [key, entry] of access) {
        if (entry.userId !== userId) continue;
        if (alive(entry)) revoked += 1;
        access.delete(key);
      }
      return revoked;
    },
  };
}
