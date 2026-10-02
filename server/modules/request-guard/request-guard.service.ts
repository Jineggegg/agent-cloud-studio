import type { IncomingMessage } from 'node:http';

import type { RequestHandler } from 'express';

import type { StudioRequestClient } from '@/shared/types.js';

import { createRateLimiter } from './rate-limiter.service.js';

/**
 * Which budget a request spends:
 * - `public`: the endpoints anyone may call without a session (/api/auth/*, /health). Small,
 *   because sign-in needs only a handful of requests and these are what a guesser hammers;
 * - `api`: every other /api route. Generous: a Studio page makes many calls while it loads;
 * - `static`: the web client's files and the page itself;
 * - `upgrade`: WebSocket upgrades (chat, shell, notifications, plugins).
 */
type RequestTier = 'public' | 'api' | 'static' | 'upgrade';

type BucketLimits = { capacity: number; refillPerSecond: number };
type TierLimits = { perClient: BucketLimits; perDoor: BucketLimits };

type RequestGuardDependencies = {
  /**
   * Who sent the request: the auth module's readRequestClient (CF-Connecting-IP only behind
   * cloudflared on loopback, the tailnet device behind Tailscale Serve, else the socket peer).
   */
  readClient: (request: { headers: IncomingMessage['headers']; socket?: { remoteAddress?: string } }) => StudioRequestClient;
  now?: () => number;
  /** Overrides for tests; production uses REQUEST_TIER_LIMITS and WEBSOCKET_CONNECTION_LIMITS. */
  limits?: Partial<Record<RequestTier, TierLimits>>;
  connectionLimits?: { perClient: number; perDoor: number };
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

// Paths anyone can reach without a session get the small `public` budget.
function tierOf(path: string): RequestTier {
  if (path === '/health' || path === '/api/auth' || path.startsWith('/api/auth/')) return 'public';
  if (path === '/api' || path.startsWith('/api/')) return 'api';
  return 'static';
}

const clientKey = (client: StudioRequestClient) => `${client.door} ${client.address}`;

/**
 * The server's own rate limits and WebSocket connection caps, in front of everything else
 * (Cloudflare Access, authentication, routes):
 * - `middleware` takes a token from the request's tier for its client and door, and answers
 *   429 with Retry-After when either bucket is empty;
 * - `admitUpgrade` does the same for a WebSocket upgrade and also refuses a client (or door)
 *   that already holds its maximum of open WebSockets;
 * - `trackConnection` counts an accepted WebSocket until the returned release runs (on close).
 * Every bucket and counter is in memory and bounded. Used by the server entrypoint.
 */
export function createRequestGuard(dependencies: RequestGuardDependencies) {
  const limits = { ...REQUEST_TIER_LIMITS, ...dependencies.limits };
  const connectionLimits = dependencies.connectionLimits ?? WEBSOCKET_CONNECTION_LIMITS;
  const logWarn = dependencies.logWarn ?? ((message: string) => console.warn(message));
  const limiters = Object.fromEntries(
    (Object.keys(limits) as RequestTier[]).map((tier) => [
      tier,
      createRateLimiter({ ...limits[tier], now: dependencies.now, maxClients: dependencies.maxClients }),
    ]),
  ) as Record<RequestTier, ReturnType<typeof createRateLimiter>>;
  // Open WebSockets per client and per door. A key leaves the map when its count drops to zero,
  // so the map never holds more keys than there are open sockets.
  const openByClient = new Map<string, number>();
  const openByDoor = new Map<StudioRequestClient['door'], number>();
  // One warning per client and tier per minute is enough to see a flood in the log.
  const lastWarnings = new Map<string, number>();
  const now = dependencies.now ?? Date.now;

  function warnOnce(tier: RequestTier, client: StudioRequestClient) {
    const key = `${tier} ${clientKey(client)}`;
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
    logWarn(`[request-guard] Rate limit reached (${tier} tier, ${client.door} door)`);
  }

  const middleware: RequestHandler = (req, res, next) => {
    const tier = tierOf(req.path);
    const client = dependencies.readClient(req);
    const result = limiters[tier].take(client);
    if (result.allowed) {
      next();
      return;
    }
    warnOnce(tier, client);
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    res.setHeader('Cache-Control', 'no-store');
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: '请求太频繁，请稍后再试',
        details: { retryAfterSeconds: result.retryAfterSeconds },
      },
    });
  };

  return {
    middleware,

    /** Checked before any other upgrade check (it is the cheapest); refusals are 429. */
    admitUpgrade(request: IncomingMessage): Admission {
      const client = dependencies.readClient(request);
      if ((openByClient.get(clientKey(client)) ?? 0) >= connectionLimits.perClient
        || (openByDoor.get(client.door) ?? 0) >= connectionLimits.perDoor) {
        warnOnce('upgrade', client);
        return { allowed: false, statusCode: 429, retryAfterSeconds: 30, reason: 'connections' };
      }
      const result = limiters.upgrade.take(client);
      if (!result.allowed) {
        warnOnce('upgrade', client);
        return { allowed: false, statusCode: 429, retryAfterSeconds: result.retryAfterSeconds, reason: 'rate' };
      }
      return { allowed: true };
    },

    /** Counts one open WebSocket of the request's client; call the result once when it closes. */
    trackConnection(request: IncomingMessage): () => void {
      const client = dependencies.readClient(request);
      const key = clientKey(client);
      openByClient.set(key, (openByClient.get(key) ?? 0) + 1);
      openByDoor.set(client.door, (openByDoor.get(client.door) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const clientCount = (openByClient.get(key) ?? 1) - 1;
        if (clientCount > 0) openByClient.set(key, clientCount);
        else openByClient.delete(key);
        const doorCount = (openByDoor.get(client.door) ?? 1) - 1;
        if (doorCount > 0) openByDoor.set(client.door, doorCount);
        else openByDoor.delete(client.door);
      };
    },
  };
}
