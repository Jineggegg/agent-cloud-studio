import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import { reloadIfNewBuild, startFrontendUpdateWatcher } from '@/shared/hooks/useFrontendUpdateWatcher';

/**
 * A page left open across a deploy (the iPad home-screen app) kept running its old bundle against the new
 * server and showed "单笔上限 NaN". The watcher compares the entry bundles named by the served index.html with
 * the ones the page booted with and picks the new build up: by itself when nothing can be lost, else via a toast.
 */

// Shaped like a built index.html: the hashed entry module, its non-blocking stylesheet and the <noscript> copy.
function builtIndexHtml(entry: string, style = 'index-STYLE.css') {
  return `<!doctype html><html><head>
    <script>/* inline theme script */</script>
    <script type="module" crossorigin src="/assets/${entry}"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-react-AAAA.js">
    <link rel="preload" as="style" crossorigin href="/assets/${style}" data-acs-entry-style>
    <noscript><link rel="stylesheet" crossorigin href="/assets/${style}"></noscript>
  </head><body><div id="root"></div></body></html>`;
}

const BOOTED = 'index-OLD.js';

let visibility: DocumentVisibilityState = 'visible';
let served = builtIndexHtml(BOOTED);
let fetchMock: ReturnType<typeof vi.fn>;
const reload = vi.fn();
const notify = vi.fn();
let stop: () => void = () => {};

function htmlResponse(body: string, init: { status?: number; type?: string } = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': init.type ?? 'text/html; charset=utf-8' }),
    text: async () => body,
  } as unknown as Response;
}

// Boots "this page" from a built index.html, as the browser would have.
function bootPage(entry = BOOTED, style?: string) {
  const parsed = new DOMParser().parseFromString(builtIndexHtml(entry, style), 'text/html');
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = '<div id="root"></div>';
}

function start() {
  stop = startFrontendUpdateWatcher({ reload, notify });
}

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

// Lets the check's promise chain (fetch, body, decision) run to the end.
async function settle() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

async function comeBack(awayMs = 60_000) {
  setVisibility('hidden');
  await vi.advanceTimersByTimeAsync(awayMs);
  setVisibility('visible');
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-10-03T08:00:00.000Z'));
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  visibility = 'visible';
  served = builtIndexHtml(BOOTED);
  fetchMock = vi.fn(async () => htmlResponse(served));
  vi.stubGlobal('fetch', fetchMock);
  reload.mockReset();
  notify.mockReset();
  sessionStorage.clear();
  bootPage();
});

afterEach(() => {
  stop();
  stop = () => {};
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

test('coming back to a page whose build was replaced reloads it by itself', async () => {
  start();
  served = builtIndexHtml('index-NEW.js');
  await comeBack();
  assert.equal(reload.mock.calls.length, 1);
  assert.equal(notify.mock.calls.length, 0);
  assert.equal(fetchMock.mock.calls.length, 1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  assert.equal(url, '/index.html');
  assert.equal(init.cache, 'no-store', 'neither the HTTP cache nor the service worker may answer');
});

test('nothing happens while the served build is the one this page booted with', async () => {
  start();
  await comeBack();
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  await settle();
  assert.equal(fetchMock.mock.calls.length, 2, 'checked on return and on the five-minute tick');
  assert.equal(reload.mock.calls.length, 0);
  assert.equal(notify.mock.calls.length, 0);
});

test('a stylesheet-only change counts as a new build', async () => {
  start();
  served = builtIndexHtml(BOOTED, 'index-RESTYLED.css');
  await comeBack();
  assert.equal(reload.mock.calls.length, 1);
});

test('with a sheet open or text in a focused field it offers a refresh instead', async () => {
  start();
  served = builtIndexHtml('index-NEW.js');
  const sheet = document.createElement('div');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  document.body.append(sheet);
  await comeBack();
  assert.equal(reload.mock.calls.length, 0);
  assert.equal(notify.mock.calls.length, 1);

  sheet.remove();
  const draft = document.createElement('textarea');
  document.body.append(draft);
  draft.value = '还没发出去的消息';
  draft.focus();
  await comeBack();
  assert.equal(reload.mock.calls.length, 0, 'typed text is never thrown away');
  assert.equal(notify.mock.calls.length, 2, 'offered again each time the page comes back');

  // The toast's 刷新 action loads the new build.
  (notify.mock.calls[1][0] as () => void)();
  assert.equal(reload.mock.calls.length, 1);
});

test('a change found while the page is in use is offered once, never reloaded under the owner', async () => {
  start();
  served = builtIndexHtml('index-NEW.js');
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  await settle();
  assert.equal(notify.mock.calls.length, 1);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  await settle();
  assert.equal(fetchMock.mock.calls.length, 2);
  assert.equal(notify.mock.calls.length, 1, 'the same build is not offered on every tick');
  assert.equal(reload.mock.calls.length, 0);

  // Touched right after coming back: the owner is already busy, so it stays an offer.
  setVisibility('hidden');
  await vi.advanceTimersByTimeAsync(60_000);
  setVisibility('visible');
  window.dispatchEvent(new Event('pointerdown'));
  await settle();
  assert.equal(reload.mock.calls.length, 0);
  assert.equal(notify.mock.calls.length, 2);
});

test('no checks while hidden; the network coming back triggers one', async () => {
  start();
  visibility = 'hidden';
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  window.dispatchEvent(new Event('online'));
  await settle();
  assert.equal(fetchMock.mock.calls.length, 0);

  visibility = 'visible';
  served = builtIndexHtml('index-NEW.js');
  window.dispatchEvent(new Event('online'));
  await settle();
  assert.equal(fetchMock.mock.calls.length, 1);
  assert.equal(notify.mock.calls.length, 1, 'a reconnect alone is not a safe moment to reload');
  assert.equal(reload.mock.calls.length, 0);
});

test('login pages, error answers, failures and timeouts never reload or offer anything', async () => {
  start();
  const answers: (() => Promise<Response>)[] = [
    // A front door's sign-in page instead of the app.
    async () => htmlResponse('<html><body><form action="/cdn-cgi/access/login"></form></body></html>'),
    async () => htmlResponse(builtIndexHtml('index-NEW.js'), { status: 503 }),
    async () => htmlResponse('{"error":"x"}', { type: 'application/json' }),
    async () => { throw new TypeError('Failed to fetch'); },
  ];
  for (const answer of answers) {
    fetchMock.mockImplementationOnce(answer);
    await comeBack();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
  }
  // Never answers: abandoned after ten seconds.
  fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
  await comeBack();
  await vi.advanceTimersByTimeAsync(30_000);
  await settle();
  assert.equal(reload.mock.calls.length, 0);
  assert.equal(notify.mock.calls.length, 0);
});

test('a failed check right after coming back is retried once', async () => {
  start();
  served = builtIndexHtml('index-NEW.js');
  fetchMock.mockImplementationOnce(async () => { throw new TypeError('Load failed'); });
  await comeBack();
  assert.equal(reload.mock.calls.length, 0);
  await vi.advanceTimersByTimeAsync(2_000);
  await settle();
  assert.equal(fetchMock.mock.calls.length, 2);
  assert.equal(reload.mock.calls.length, 1);

  // Still offline on the retry: no further tries until the next trigger.
  fetchMock.mockImplementation(async () => { throw new TypeError('Load failed'); });
  await comeBack();
  await vi.advanceTimersByTimeAsync(9_000);
  await settle();
  assert.equal(fetchMock.mock.calls.length, 4, 'one check and one retry for this return');
});

test('a reload that still booted the old build is not repeated in a loop', async () => {
  start();
  served = builtIndexHtml('index-NEW.js');
  await comeBack();
  assert.equal(reload.mock.calls.length, 1);

  // The "reloaded" page came up with the old bundle again (say, a stale intermediary): it must not loop.
  stop();
  bootPage();
  start();
  await comeBack();
  assert.equal(reload.mock.calls.length, 1);
  assert.equal(notify.mock.calls.length, 1);
});

test('a development page has no hashed entry and starts no checks', async () => {
  document.head.innerHTML = '<script type="module" src="/src/main.tsx"></script>';
  start();
  served = builtIndexHtml('index-NEW.js');
  await comeBack();
  window.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  await settle();
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('stopping removes every trigger', async () => {
  start();
  stop();
  served = builtIndexHtml('index-NEW.js');
  await comeBack();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  await settle();
  assert.equal(fetchMock.mock.calls.length, 0);
});

// The home's refresh button: an explicit tap loads a newer deploy at once, otherwise the data refresh goes ahead.
test('reloadIfNewBuild loads a newer served build at once and says so', async () => {
  served = builtIndexHtml('index-NEW.js');
  const result = reloadIfNewBuild(reload);
  await settle();
  assert.equal(await result, true);
  assert.equal(reload.mock.calls.length, 1);
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  assert.equal(init.cache, 'no-store');
});

test('reloadIfNewBuild leaves the page alone when the build is current or the answer is unusable', async () => {
  assert.equal(await reloadIfNewBuild(reload), false, 'same build');
  fetchMock.mockImplementation(async () => htmlResponse('<html><body>请登录</body></html>'));
  assert.equal(await reloadIfNewBuild(reload), false, 'a page without a hashed entry');
  fetchMock.mockImplementation(async () => { throw new TypeError('offline'); });
  assert.equal(await reloadIfNewBuild(reload), false, 'offline');
  fetchMock.mockImplementation(() => new Promise(() => {}));
  const hanging = reloadIfNewBuild(reload);
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(await hanging, false, 'no answer within ten seconds');
  assert.equal(reload.mock.calls.length, 0);
});

test('reloadIfNewBuild does nothing on a development page', async () => {
  document.head.innerHTML = '<script type="module" src="/src/main.tsx"></script>';
  served = builtIndexHtml('index-NEW.js');
  assert.equal(await reloadIfNewBuild(reload), false);
  assert.equal(fetchMock.mock.calls.length, 0);
});
