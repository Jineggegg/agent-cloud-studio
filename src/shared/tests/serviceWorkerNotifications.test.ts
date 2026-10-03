import { beforeAll, describe, expect, test, vi } from 'vitest';

/**
 * Tapping a notification (public/sw.js) opens the page its payload names: an open Studio window is focused and told
 * to navigate in place, otherwise a new window opens there. Only same-origin paths are accepted; anything else opens
 * the home screen.
 */

const ORIGIN = 'https://studio.test';
let workerSource = '';

// Loaded like serviceWorker.test.ts: the frontend program has no Node types, so fs comes through a plain specifier.
beforeAll(async () => {
  const fsModule = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync: (path: string, encoding: 'utf8') => string };
  const testsDir = decodeURIComponent(import.meta.url.replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1')).replace(/\/[^/]*$/, '');
  workerSource = readFileSync(`${testsDir}/../../../public/sw.js`, 'utf8');
});

type FakeWindow = { url: string; focus: () => Promise<FakeWindow>; postMessage: (message: unknown) => void };
type FakeClients = { matchAll: () => Promise<FakeWindow[]>; openWindow: (url: string) => Promise<unknown> };
type NotificationClickEvent = { notification: { data: unknown; close: () => void }; waitUntil: (work: Promise<unknown>) => void };
type WorkerApi = {
  notificationTargetPath: (data: unknown) => string;
  openNotificationTarget: (clients: FakeClients, scope: string, path: string, data: unknown) => Promise<'focused' | 'opened'>;
};

function fakeWindow(url: string): FakeWindow & { messages: unknown[]; focused: number } {
  const window = {
    url,
    messages: [] as unknown[],
    focused: 0,
    focus: async () => { window.focused += 1; return window; },
    postMessage: (message: unknown) => { window.messages.push(message); },
  };
  return window;
}

// Runs sw.js against a fake `self` (scope given) and returns its notification helpers plus a click dispatcher.
function loadWorker(windows: FakeWindow[], scope = `${ORIGIN}/`) {
  const listeners = new Map<string, (event: NotificationClickEvent) => void>();
  const clients = { matchAll: vi.fn(async () => windows), openWindow: vi.fn(async () => null) };
  const self = {
    addEventListener: (type: string, listener: (event: NotificationClickEvent) => void) => { listeners.set(type, listener); },
    skipWaiting: () => {},
    location: { origin: ORIGIN },
    registration: { scope },
    clients,
  };
  const api = new Function('self', 'caches', 'fetch', `${workerSource}\nreturn { notificationTargetPath, openNotificationTarget };`)(self, {}, vi.fn()) as WorkerApi;
  async function click(data: unknown) {
    const work: Promise<unknown>[] = [];
    const close = vi.fn();
    listeners.get('notificationclick')?.({ notification: { data, close }, waitUntil: value => { work.push(value); } });
    await Promise.all(work);
    return { close };
  }
  return { api, clients, click };
}

describe('the page a notification opens', () => {
  test('a same-origin path is kept as written; old payloads naming a session open it', () => {
    const { api } = loadWorker([]);
    expect(api.notificationTargetPath({ url: '/projects/prof?tab=automations' })).toBe('/projects/prof?tab=automations');
    expect(api.notificationTargetPath({ url: '/work/p1/s/s1' })).toBe('/work/p1/s/s1');
    expect(api.notificationTargetPath({ sessionId: 'abc 1' })).toBe('/session/abc%201');
    expect(api.notificationTargetPath({})).toBe('/');
    expect(api.notificationTargetPath(null)).toBe('/');
  });

  test('foreign or tricky URLs fall back to the home screen', () => {
    const { api } = loadWorker([]);
    for (const url of ['https://evil.example/x', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 'projects/x', '/a\nb', 42, `/${'x'.repeat(3000)}`]) {
      expect(api.notificationTargetPath({ url })).toBe('/');
    }
    // A url field always wins over the legacy session id, even when it is rejected.
    expect(api.notificationTargetPath({ url: 'https://evil.example', sessionId: 's1' })).toBe('/');
  });
});

describe('tapping a notification', () => {
  test('an open Studio window is focused and navigates in place', async () => {
    const studio = fakeWindow(`${ORIGIN}/work/p1`);
    const other = fakeWindow('https://elsewhere.test/');
    const { clients, click } = loadWorker([other, studio]);
    const { close } = await click({ url: '/projects/prof?tab=automations', code: 'studio.automation' });
    expect(close).toHaveBeenCalled();
    expect(studio.focused).toBe(1);
    expect(studio.messages).toEqual([{ type: 'notification:navigate', url: '/projects/prof?tab=automations', sessionId: null, provider: null }]);
    expect(other.focused).toBe(0);
    expect(clients.openWindow).not.toHaveBeenCalled();
  });

  test('without a Studio window a new one opens at the page, keeping the app’s path prefix', async () => {
    const { clients, click } = loadWorker([fakeWindow('https://elsewhere.test/')], `${ORIGIN}/ai/`);
    await click({ url: '/work/p1/s/s1', sessionId: 's1', provider: 'codex' });
    expect(clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/ai/work/p1/s/s1`);
  });

  test('a window outside the worker’s scope does not count as Studio', async () => {
    const outside = fakeWindow(`${ORIGIN}/other-app/`);
    const { api, clients } = loadWorker([outside], `${ORIGIN}/ai/`);
    expect(await api.openNotificationTarget(clients, `${ORIGIN}/ai/`, '/', {})).toBe('opened');
    expect(clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/ai/`);
    expect(outside.messages).toEqual([]);
  });

  test('a foreign URL in the payload opens the home screen instead', async () => {
    const studio = fakeWindow(`${ORIGIN}/`);
    const { click } = loadWorker([studio]);
    await click({ url: 'https://evil.example/phish', sessionId: 's1', provider: 'claude' });
    expect(studio.messages).toEqual([{ type: 'notification:navigate', url: '/', sessionId: 's1', provider: 'claude' }]);
  });

  test('a refused focus still navigates the window', async () => {
    const studio = fakeWindow(`${ORIGIN}/`);
    studio.focus = () => Promise.reject(new Error('not allowed'));
    const { click } = loadWorker([studio]);
    await click({ url: '/projects/prof' });
    expect(studio.messages).toHaveLength(1);
  });
});
