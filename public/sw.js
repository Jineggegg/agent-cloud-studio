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
    icon: '/logo-256.png',
    badge: '/logo-128.png',
    data: payload.data || {},
    tag: payload.data?.tag || `${payload.data?.sessionId || 'global'}:${payload.data?.code || 'default'}`,
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Agent Cloud Studio', options)
  );
});

// Notification click event
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const sessionId = event.notification.data?.sessionId;
  const provider = event.notification.data?.provider || null;
  const urlPath = sessionId ? `/session/${sessionId}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          await client.focus();
          client.postMessage({
            type: 'notification:navigate',
            sessionId: sessionId || null,
            provider,
            urlPath
          });
          return;
        }
      }
      return self.clients.openWindow(urlPath);
    })
  );
});
