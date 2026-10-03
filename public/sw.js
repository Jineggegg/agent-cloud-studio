// Service Worker for CloudCLI PWA
// Pre-caches only the manifest (needed for PWA install). HTML is never cached, by this worker or
// for it: navigations and fetches of /index.html always go to the network, so a rebuild + refresh
// always picks up the latest build (the page's update check, useFrontendUpdateWatcher, relies on it).
// Hashed /assets/ files are kept after their first successful load; their names change with every
// build, so a cached one can never be stale.
// v3: v2 also stored failed /assets/ answers (a 404 during a deploy), which then stuck for good.
const CACHE_NAME = 'claude-ui-v3';
const urlsToCache = [
  '/manifest.json'
];
// Old builds' assets pile up across deploys; past this many entries the oldest are dropped.
const MAX_CACHED_ASSETS = 300;

async function trimAssetCache(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_CACHED_ASSETS)).map(key => cache.delete(key)));
}

// Install event
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// Fetch event — network-first for everything except hashed assets
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Never intercept API requests or WebSocket upgrades
  if (url.includes('/api/') || url.includes('/ws')) {
    return;
  }

  // Navigation requests (HTML) — always go to network, no caching
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/manifest.json').then(() =>
        new Response('<h1>Offline</h1><p>Please check your connection.</p>', {
          headers: { 'Content-Type': 'text/html' }
        })
      ))
    );
    return;
  }

  // Hashed assets (JS/CSS in /assets/) — cache-first since filenames change per build. Only a
  // complete same-origin success is stored: an error page kept under a bundle's name would break
  // every later launch.
  if (url.includes('/assets/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            const stored = caches.open(CACHE_NAME)
              .then(cache => cache.put(event.request, clone).then(() => trimAssetCache(cache)))
              .catch(() => {});
            try {
              event.waitUntil(stored);
            } catch {
              // The worker's lifetime could not be extended; the store still runs while it lives.
            }
          }
          return response;
        });
      })
    );
    return;
  }

  // Everything else (including the page's own no-store fetch of /index.html) — network-first, and
  // nothing is stored, so the cache fallback can only ever answer with the pre-cached manifest.
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// Activate event — purge old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames =>
      Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

// Push notification event
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'CloudCLI', body: event.data.text() };
  }

  const options = {
    body: payload.body || '',
    // The Studio's logo (public/studio-icon.svg, rendered by scripts/generate-studio-icons.mjs).
    icon: '/icons/studio-192.png?v=57f6ad94',
    badge: '/icons/studio-96.png?v=57f6ad94',
    data: payload.data || {},
    tag: payload.data?.tag || `${payload.data?.sessionId || 'global'}:${payload.data?.code || 'default'}`,
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Agent Cloud Studio', options)
  );
});

// Longest path a notification may open; anything longer is not one of the app's own pages.
const MAX_NOTIFICATION_PATH_LENGTH = 2048;
// Only used to parse a path: a value that resolves to any other origin was not a same-origin path.
const PATH_PARSE_ORIGIN = 'https://studio.invalid';

// The page a notification opens, as an app path ('/projects/x?tab=automations'). Only a same-origin path is accepted
// (the server applies the same rule); an absolute or protocol-relative URL, a backslash trick, control characters or
// a non-string fall back to '/', the home screen. Payloads from before `url` existed name only a session.
function notificationTargetPath(data) {
  const value = data && data.url !== undefined ? data.url
    : data && typeof data.sessionId === 'string' && data.sessionId ? `/session/${encodeURIComponent(data.sessionId)}` : '/';
  if (typeof value !== 'string') return '/';
  const candidate = value.trim();
  // eslint-disable-next-line no-control-regex
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.length > MAX_NOTIFICATION_PATH_LENGTH || /[\u0000-\u001f\u007f\\]/.test(candidate)) {
    return '/';
  }
  try {
    const parsed = new URL(candidate, PATH_PARSE_ORIGIN);
    return parsed.origin === PATH_PARSE_ORIGIN ? `${parsed.pathname}${parsed.search}${parsed.hash}` : '/';
  } catch {
    return '/';
  }
}

// Opens a notification's page. A Studio window that is already open (same origin, inside this worker's scope) is
// focused and told to navigate in place (the app's router handles `notification:navigate`, keeping its state and
// any path prefix); otherwise a new window opens at the page, resolved against the scope so a prefix is kept.
// Resolves with what it did: 'focused' or 'opened'.
async function openNotificationTarget(clients, scope, path, data) {
  const scopeUrl = new URL(scope);
  const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  const studio = windows.find(client => {
    try {
      const url = new URL(client.url);
      return url.origin === scopeUrl.origin && url.pathname.startsWith(scopeUrl.pathname);
    } catch {
      return false;
    }
  });
  if (studio) {
    let target = studio;
    try {
      target = (await studio.focus()) || studio;
    } catch {
      // Focus can be refused (another app is in front); the window still navigates.
    }
    target.postMessage({
      type: 'notification:navigate',
      url: path,
      sessionId: (data && typeof data.sessionId === 'string' && data.sessionId) || null,
      provider: (data && data.provider) || null
    });
    return 'focused';
  }
  await clients.openWindow(new URL(path.slice(1), scopeUrl).href);
  return 'opened';
}

// Notification click event
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(openNotificationTarget(self.clients, self.registration.scope, notificationTargetPath(data), data));
});
