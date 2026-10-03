import type { IncomingMessage } from 'node:http';

import type { RequestHandler } from 'express';

import type { StudioRequestClient } from '@/shared/types.js';

import { createRateLimiter } from './rate-limiter.service.js';

/**
 * Which budget a request spends:
 * - `public`: the endpoints anyone may call without a session (PUBLIC_ENDPOINTS). Small, because
 *   sign-in needs only a handful of requests and these are what a guesser hammers;
 * - `api`: every other /api route, the signed-in /api/auth/* routes included. Generous: a Studio
 *   page makes many calls while it loads, and a public flood must not stop it loading;
 * - `static`: the web client's files and the page itself;
 * - `upgrade`: WebSocket upgrades (chat, shell, notifications, plugins).
 */
type RequestTier = 'public' | 'api' | 'static' | 'upgrade';

type BucketLimits = { capacity: number; refillPerSecond: number };
type TierLimits = { perClient: BucketLimits; perDoor: BucketLimits };

type RequestGuardDependencies = {
  /**
   * Who sent the request: the auth module's readRequestClient (the public door only behind
   * cloudflared, the tailnet device behind Tailscale Serve, else the socket peer).
   */
  readClient: (request: { headers: IncomingMessage['headers']; socket?: { remoteAddress?: string; localPort?: number } }) => StudioRequestClient;
  now?: () => number;
  /** Overrides for tests; production uses the exported limits below. */
  limits?: Partial<Record<RequestTier, TierLimits>>;
  connectionLimits?: { perClient: number; perDoor: number };
  inFlightLimits?: { perClient: number; perDoor: number };
  maxClients?: number;
  logWarn?: (message: string) => void;
};

type Admission = { allowed: true } | { allowed: false; statusCode: 429; retryAfterSeconds: number; reason: 'rate' | 'connections' };

/**
 * Token-bucket sizes per tier. Each door (cloudflare / tailnet / direct) has its own door bucket,
 * so a flood through the public domain can exhaust only the public door's budget.
 * Used by createRequestGuard (and its tests, to know when a burst runs out).
 */
export const REQUEST_TIER_LIMITS: Record<RequestTier, TierLimits> = {
  public: { perClient: { capacity: 30, refillPerSecond: 0.5 }, perDoor: { capacity: 300, refillPerSecond: 10 } },
  api: { perClient: { capacity: 600, refillPerSecond: 20 }, perDoor: { capacity: 3000, refillPerSecond: 150 } },
  static: { perClient: { capacity: 600, refillPerSecond: 30 }, perDoor: { capacity: 4000, refillPerSecond: 200 } },
  upgrade: { perClient: { capacity: 30, refillPerSecond: 0.5 }, perDoor: { capacity: 200, refillPerSecond: 5 } },
};

/**
 * Open WebSockets allowed at once per client and per door. A Studio tab keeps a few (chat,
 * notifications, one per terminal), so 64 leaves room for several devices behind one address.
 * Used by createRequestGuard and its tests.
 */
export const WEBSOCKET_CONNECTION_LIMITS = { perClient: 64, perDoor: 512 };

/**
 * HTTP requests one client (and one door) may have in progress at once, from the moment its
 * headers are read until the response ends. A page holds a few long ones (event streams, a
 * streaming chat answer) plus a burst while loading; a client trickling bodies or holding
 * responses open cannot take more than its share of the server's connections.
 * Used by createRequestGuard and its tests.
 */
export const IN_FLIGHT_LIMITS = { perClient: 100, perDoor: 800 };

/**
 * The endpoints that answer without a session, in normalized form (see normalizedPath). Everything
 * else under /api, including the signed-in /api/auth/* routes, spends the `api` budget.
 * Used by createRequestGuard and the route-audit test, which probes every one of them.
 */
export const PUBLIC_ENDPOINTS = [
  '/health',
  '/api/auth/status',
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/passkey/options',
  '/api/auth/passkey',
  '/api/auth/tailscale-session',
  '/api/auth/handoff/redeem',
] as const;
const PUBLIC_ENDPOINT_SET = new Set<string>(PUBLIC_ENDPOINTS);

// Express routes case-insensitively and ignores one trailing slash, so "/API/auth/login/" reaches
// the login route: the tier is chosen on the lower-cased path with repeated and trailing slashes
// removed, which can only ever move a request into a stricter tier, never out of it.
function normalizedPath(path: string): string {
  const collapsed = path.toLowerCase().replace(/\/{2,}/g, '/');
  return collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}

function tierOf(path: string): RequestTier {
  const normalized = normalizedPath(path);
  if (PUBLIC_ENDPOINT_SET.has(normalized)) return 'public';
  if (normalized === '/api' || normalized.startsWith('/api/')) return 'api';
  return 'static';
}

const clientKey = (client: StudioRequestClient) => `${client.door} ${client.address}`;

// Counts things held open per key; a key leaves the map when its count drops to zero, so the map
// never holds more keys than there are open things.
function createCounter<K>() {
  const counts = new Map<K, number>();
  return {
    get: (key: K) => counts.get(key) ?? 0,
    add: (key: K) => { counts.set(key, (counts.get(key) ?? 0) + 1); },
    remove: (key: K) => {
      const next = (counts.get(key) ?? 1) - 1;
      if (next > 0) counts.set(key, next);
      else counts.delete(key);
    },
  };
}

function sendTooMany(res: Parameters<RequestHandler>[1], retryAfterSeconds: number, code: string, message: string) {
  res.setHeader('Retry-After', String(retryAfterSeconds));
  res.setHeader('Cache-Control', 'no-store');
  res.status(429).json({ success: false, error: { code, message, details: { retryAfterSeconds } } });
}

/**
 * The server's own rate limits and connection caps, in front of everything else (Cloudflare
 * Access, authentication, routes):
 * - `middleware` refuses a client (or door) that already has its maximum of requests in progress,
 *   then takes a token from the request's tier for its client and door, answering 429 with
 *   Retry-After when either bucket is empty;
 * - `admitUpgrade` does the same for a WebSocket upgrade and also refuses a client (or door)
 *   that already holds its maximum of open WebSockets;
 * - `trackConnection` counts an accepted WebSocket until the returned release runs (on close).
 * Every bucket and counter is in memory and bounded. Used by the server entrypoint.
 */
export function createRequestGuard(dependencies: RequestGuardDependencies) {
  const limits = { ...REQUEST_TIER_LIMITS, ...dependencies.limits };
  const connectionLimits = dependencies.connectionLimits ?? WEBSOCKET_CONNECTION_LIMITS;
  const inFlightLimits = dependencies.inFlightLimits ?? IN_FLIGHT_LIMITS;
  const logWarn = dependencies.logWarn ?? ((message: string) => console.warn(message));
  const limiters = Object.fromEntries(
    (Object.keys(limits) as RequestTier[]).map((tier) => [
      tier,
      createRateLimiter({ ...limits[tier], now: dependencies.now, maxClients: dependencies.maxClients }),
    ]),
  ) as Record<RequestTier, ReturnType<typeof createRateLimiter>>;
  const openSocketsByClient = createCounter<string>();
  const openSocketsByDoor = createCounter<StudioRequestClient['door']>();
  const inFlightByClient = createCounter<string>();
  const inFlightByDoor = createCounter<StudioRequestClient['door']>();
  // One warning per client and kind per minute is enough to see a flood in the log.
  const lastWarnings = new Map<string, number>();
  const now = dependencies.now ?? Date.now;

  function warnOnce(kind: string, client: StudioRequestClient) {
    const key = `${kind} ${clientKey(client)}`;
    const at = now();
    const last = lastWarnings.get(key);
    if (last !== undefined && at - last < 60_000) return;
    lastWarnings.delete(key);
    lastWarnings.set(key, at);
    while (lastWarnings.size > 1000) {
      const oldest = lastWarnings.keys().next().value;
      if (oldest === undefined) break;
      lastWarnings.delete(oldest);
    }
    // The door only, never the address: request logs must not collect client addresses.
    logWarn(`[request-guard] Limit reached (${kind}, ${client.door} door)`);
  }

  const middleware: RequestHandler = (req, res, next) => {
    const client = dependencies.readClient(req);
    const key = clientKey(client);
    if (inFlightByClient.get(key) >= inFlightLimits.perClient || inFlightByDoor.get(client.door) >= inFlightLimits.perDoor) {
      warnOnce('in-flight requests', client);
      sendTooMany(res, 5, 'TOO_MANY_REQUESTS_IN_FLIGHT', '同时进行的请求太多，请稍后再试');
      return;
    }
    const tier = tierOf(req.path);
    const result = limiters[tier].take(client);
    if (!result.allowed) {
      warnOnce(`${tier} tier`, client);
      sendTooMany(res, result.retryAfterSeconds, 'RATE_LIMITED', '请求太频繁，请稍后再试');
      return;
    }
    inFlightByClient.add(key);
    inFlightByDoor.add(client.door);
    let released = false;
    // 'close' follows every response, finished or aborted, so the slot is always given back.
    res.once('close', () => {
      if (released) return;
      released = true;
      inFlightByClient.remove(key);
      inFlightByDoor.remove(client.door);
    });
    next();
  };

  return {
    middleware,

    /** Checked before any other upgrade check (it is the cheapest); refusals are 429. */
    admitUpgrade(request: IncomingMessage): Admission {
      const client = dependencies.readClient(request);
      if (openSocketsByClient.get(clientKey(client)) >= connectionLimits.perClient
        || openSocketsByDoor.get(client.door) >= connectionLimits.perDoor) {
        warnOnce('open WebSockets', client);
        return { allowed: false, statusCode: 429, retryAfterSeconds: 30, reason: 'connections' };
      }
      const result = limiters.upgrade.take(client);
      if (!result.allowed) {
        warnOnce('upgrade tier', client);
        return { allowed: false, statusCode: 429, retryAfterSeconds: result.retryAfterSeconds, reason: 'rate' };
      }
      return { allowed: true };
    },

    /** Counts one open WebSocket of the request's client; call the result once when it closes. */
    trackConnection(request: IncomingMessage): () => void {
      const client = dependencies.readClient(request);
      const key = clientKey(client);
      openSocketsByClient.add(key);
      openSocketsByDoor.add(client.door);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        openSocketsByClient.remove(key);
        openSocketsByDoor.remove(client.door);
      };
    },
  };
}
