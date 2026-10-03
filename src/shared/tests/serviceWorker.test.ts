import assert from 'node:assert/strict';

import { beforeAll, test, vi } from 'vitest';

/**
 * public/sw.js must never keep HTML: the page's update check (useFrontendUpdateWatcher) fetches /index.html with
 * `cache: 'no-store'` and a navigation must always reach the server, or a redeployed client is never noticed.
 * Hashed bundles may be kept, but only after a successful load: an error page stored under a bundle's name would
 * break every later launch.
 */

const ORIGIN = 'https://studio.test';
let workerSource = '';

// The frontend program has no Node types, so Node's fs is loaded through a specifier TypeScript does not try to
// resolve, and jsdom's URL cannot resolve against a file: URL, hence the plain path arithmetic (as in
// StudioWidgets.test.tsx).
beforeAll(async () => {
  const fsModule = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync: (path: string, encoding: 'utf8') => string };
  const testsDir = decodeURIComponent(import.meta.url.replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1')).replace(/\/[^/]*$/, '');
  workerSource = readFileSync(`${testsDir}/../../../public/sw.js`, 'utf8');
});

type FakeRequest = { url: string; mode: string; cache: string };
type FakeResponse = { ok: boolean; status: number; type: string; clone: () => FakeResponse };
type FetchEventLike = { request: FakeRequest; respondWith: (answer: Promise<unknown>) => void; waitUntil: (work: Promise<unknown>) => void };

function response(status: number, type = 'basic'): FakeResponse {
  const answer: FakeResponse = { ok: status >= 200 && status < 300, status, type, clone: () => answer };
  return answer;
}

function request(path: string, mode = 'cors', cache = 'default'): FakeRequest {
  return { url: `${ORIGIN}${path}`, mode, cache };
}

// Runs sw.js against fake `self`, `caches` and network, the way the browser would load it.
function loadWorker(network: (request: FakeRequest) => Promise<FakeResponse>) {
  const listeners = new Map<string, (event: FetchEventLike) => void>();
  const stored = new Map<string, FakeResponse>();
  const cache = {
    addAll: async () => {},
    put: async (key: FakeRequest, value: FakeResponse) => { stored.set(key.url, value); },
    keys: async () => [...stored.keys()].map(url => ({ url })),
    delete: async (key: { url: string }) => stored.delete(key.url),
  };
  const caches = {
    open: async () => cache,
    match: async (key: FakeRequest | string) => stored.get(typeof key === 'string' ? `${ORIGIN}${key}` : key.url),
    keys: async () => [],
    delete: async () => true,
  };
  const self = {
    addEventListener: (type: string, listener: (event: FetchEventLike) => void) => { listeners.set(type, listener); },
    skipWaiting: () => {},
    location: { origin: ORIGIN },
  };
  const fetchSpy = vi.fn(network);
  new Function('self', 'caches', 'fetch', workerSource)(self, caches, fetchSpy);

  // Dispatches a fetch event; resolves with whether the worker answered, its answer, after its stores finished.
  async function dispatch(fetchRequest: FakeRequest) {
    // Assigned inside the listener's callback, which TypeScript's narrowing cannot see.
    let answer = null as Promise<unknown> | null;
    const work: Promise<unknown>[] = [];
    listeners.get('fetch')?.({
      request: fetchRequest,
      respondWith: value => { answer = Promise.resolve(value); },
      waitUntil: value => { work.push(value); },
    });
    const value = answer ? await answer : undefined;
    await Promise.all(work);
    return { handled: answer !== null, value };
  }

  return { dispatch, stored, fetchSpy };
}

test('navigations and the page\'s no-store fetch of /index.html always reach the network and are never stored', async () => {
  const worker = loadWorker(async () => response(200));
  const navigation = request('/work/project-1', 'navigate');
  await worker.dispatch(navigation);
  const indexHtml = request('/index.html', 'cors', 'no-store');
  const result = await worker.dispatch(indexHtml);
  assert.equal(result.handled, true);
  assert.equal(worker.fetchSpy.mock.calls[0][0], navigation);
  assert.equal(worker.fetchSpy.mock.calls[1][0], indexHtml, 'the request goes out as made, with cache: no-store');
  assert.equal(worker.stored.size, 0);

  await worker.dispatch(indexHtml);
  assert.equal(worker.fetchSpy.mock.calls.length, 3, 'asked again, never answered from a cache');
});

test('a hashed bundle is kept only after a successful load', async () => {
  let status = 404;
  const worker = loadWorker(async () => response(status));
  const bundle = request('/assets/index-NEW.js');
  assert.equal(((await worker.dispatch(bundle)).value as FakeResponse).status, 404);
  assert.equal(worker.stored.size, 0, 'a 404 during a deploy is not kept under the bundle\'s name');

  status = 200;
  await worker.dispatch(bundle);
  assert.equal(worker.stored.size, 1);
  await worker.dispatch(bundle);
  assert.equal(worker.fetchSpy.mock.calls.length, 2, 'a kept bundle is served without the network');
});

test('API requests are left to the browser', async () => {
  const worker = loadWorker(async () => response(200));
  const result = await worker.dispatch(request('/api/studio/quota'));
  assert.equal(result.handled, false);
  assert.equal(worker.fetchSpy.mock.calls.length, 0);
});
