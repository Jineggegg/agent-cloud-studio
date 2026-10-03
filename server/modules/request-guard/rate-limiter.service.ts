import type { StudioRequestClient } from '@/shared/types.js';

/** One token bucket's size: up to `capacity` requests at once, refilled at `refillPerSecond`. */
type BucketLimits = { capacity: number; refillPerSecond: number };

type RateLimiterOptions = {
  /** The bucket of one client (door + address). */
  perClient: BucketLimits;
  /** The bucket all clients of one door share, so one door's flood never drains another door. */
  perDoor: BucketLimits;
  /** Most client buckets kept; the least recently used one is dropped beyond it (LRU). */
  maxClients?: number;
  now?: () => number;
};

type Bucket = { tokens: number; updatedAt: number };

type TakeResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

const DEFAULT_MAX_CLIENTS = 10_000;

// Tokens in the bucket at `at`, refilled since its last update and capped at the capacity.
function tokensAt(bucket: Bucket | undefined, limits: BucketLimits, at: number): number {
  if (!bucket) return limits.capacity;
  const elapsedSeconds = Math.max(0, at - bucket.updatedAt) / 1000;
  return Math.min(limits.capacity, bucket.tokens + elapsedSeconds * limits.refillPerSecond);
}

// Whole seconds until one token is back, at least 1 (a Retry-After of 0 invites a tight loop).
function secondsUntilToken(tokens: number, limits: BucketLimits): number {
  return Math.max(1, Math.ceil((1 - tokens) / limits.refillPerSecond));
}

/**
 * In-memory token buckets keyed by who sent a request (StudioRequestClient): one per client and
 * one per door. A request needs a token from both; when either is empty it is refused with the
 * number of seconds until a token is back. The client buckets form an LRU bounded by
 * `maxClients`, so a flood from many addresses cannot grow memory; a dropped bucket only comes
 * back full, and the door bucket still bounds that door as a whole. A restart refills everything.
 * Used by request-guard.service, one limiter per tier (public endpoints, API, static files,
 * WebSocket upgrades).
 */
export function createRateLimiter(options: RateLimiterOptions) {
  const now = options.now ?? Date.now;
  const maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS;
  const clients = new Map<string, Bucket>();
  const doors = new Map<StudioRequestClient['door'], Bucket>();

  return {
    /** Takes one token for the client and its door, or says how long to wait. */
    take(client: StudioRequestClient): TakeResult {
      const at = now();
      const key = `${client.door} ${client.address}`;
      const clientTokens = tokensAt(clients.get(key), options.perClient, at);
      const doorTokens = tokensAt(doors.get(client.door), options.perDoor, at);

      // A refused request takes nothing, so waiting is enough to get through again.
      const allowed = clientTokens >= 1 && doorTokens >= 1;
      const cost = allowed ? 1 : 0;

      // Re-inserting moves the key to the end, so the first key is always the least recently used.
      clients.delete(key);
      clients.set(key, { tokens: clientTokens - cost, updatedAt: at });
      doors.set(client.door, { tokens: doorTokens - cost, updatedAt: at });
      while (clients.size > maxClients) {
        const leastRecent = clients.keys().next().value;
        if (leastRecent === undefined) break;
        clients.delete(leastRecent);
      }

      if (allowed) return { allowed: true };
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          clientTokens < 1 ? secondsUntilToken(clientTokens, options.perClient) : 0,
          doorTokens < 1 ? secondsUntilToken(doorTokens, options.perDoor) : 0,
        ),
      };
    },

    /** Client buckets currently kept (for the memory bound's tests). */
    trackedClients(): number {
      return clients.size;
    },
  };
}
