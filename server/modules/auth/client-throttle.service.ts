import type { StudioRequestClient } from '@/shared/types.js';

/**
 * Fixed-window counters keyed by who sent a request (StudioRequestClient), with a second total
 * per door. A client is blocked when either its own count or its door's total reaches the limit,
 * so one noisy client cannot lock out others beyond its own bucket, and traffic through the public
 * tunnel door can never use up the budget of the tailnet door. Counters live in memory only: a
 * restart clears them, which an attacker cannot trigger from outside.
 */

type ClientThrottleOptions = {
  /** Length of each fixed window. */
  windowMs: number;
  /** Events one client (door + address) may record per window. */
  perClient: number;
  /** Events all clients of one door may record together per window. */
  perDoor: number;
  now?: () => number;
  /** Most per-client counters kept; beyond it expired ones, then the oldest, are dropped. */
  maxClients?: number;
};

type WindowCounter = { startedAt: number; count: number };

/**
 * Creates one throttle.
 * Used by auth.service for failed passwords (login and the handoff password share one budget, so
 * neither is an unlimited password oracle) and by handoff.service for code redemptions.
 */
export function createClientThrottle(options: ClientThrottleOptions) {
  const now = options.now ?? Date.now;
  const maxClients = options.maxClients ?? 4096;
  // Door totals are kept apart from the bounded client map, so evicting clients never resets them.
  const doors = new Map<StudioRequestClient['door'], WindowCounter>();
  const clients = new Map<string, WindowCounter>();

  const clientKey = (client: StudioRequestClient) => `${client.door} ${client.address}`;
  const current = (counter: WindowCounter | undefined, at: number) =>
    counter && at - counter.startedAt < options.windowMs ? counter.count : 0;

  function bump<K>(map: Map<K, WindowCounter>, key: K, at: number) {
    const counter = map.get(key);
    if (counter && at - counter.startedAt < options.windowMs) {
      counter.count += 1;
      return;
    }
    map.delete(key);
    map.set(key, { startedAt: at, count: 1 });
  }

  function makeRoomForClient(at: number) {
    if (clients.size < maxClients) return;
    for (const [key, counter] of clients) {
      if (at - counter.startedAt >= options.windowMs) clients.delete(key);
    }
    // Map iteration is insertion order, so the first key is the oldest window.
    while (clients.size >= maxClients) {
      const oldest = clients.keys().next().value;
      if (oldest === undefined) break;
      clients.delete(oldest);
    }
  }

  return {
    /**
     * True when the client or its door used up the window; check before doing the guarded work.
     * With `{ door: false }` only the client's own count matters (see record).
     */
    isBlocked(client: StudioRequestClient, scope: { door?: boolean } = {}): boolean {
      const at = now();
      return current(clients.get(clientKey(client)), at) >= options.perClient
        || (scope.door !== false && current(doors.get(client.door), at) >= options.perDoor);
    },

    /**
     * Counts one event (a wrong password, a redemption attempt) for the client and its door. With
     * `{ door: false }` it counts for the client only, for events that cannot be used to guess
     * anything and so must not let a crowd of clients block a whole door.
     */
    record(client: StudioRequestClient, scope: { door?: boolean } = {}): void {
      const at = now();
      const key = clientKey(client);
      if (!clients.has(key)) makeRoomForClient(at);
      bump(clients, key, at);
      if (scope.door !== false) bump(doors, client.door, at);
    },

    /**
     * Call after a success that was recorded beforehand (callers record before slow work, so
     * parallel attempts cannot all slip past the limit): clears the client's own count and takes
     * that one successful attempt back out of its door's total.
     */
    forgive(client: StudioRequestClient): void {
      clients.delete(clientKey(client));
      const door = doors.get(client.door);
      if (door && door.count > 0 && now() - door.startedAt < options.windowMs) door.count -= 1;
    },
  };
}
