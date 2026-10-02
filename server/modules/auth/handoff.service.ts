import { createHash, randomBytes } from 'node:crypto';

import type { StudioIngressId, StudioRequestClient } from '@/shared/types.js';

import { createClientThrottle } from './client-throttle.service.js';

/**
 * One-time codes that move a signed-in browser from one Studio front door to the other
 * (docs/network.md). The two doors are different origins, so their localStorage, and with it the
 * session token, are separate; a code lets the page on the target origin pick up a session without
 * typing the password again.
 *
 * Properties the auth service relies on:
 * - A code is 32 random bytes (base64url, 43 characters) and only its SHA-256 is kept, so a heap or
 *   log dump of the store cannot be replayed.
 * - A code is consumed by the first redemption attempt, successful or not, and expires 60 s after
 *   it was issued.
 * - Each code is bound to one user and to the exact origin of its target door; the auth service
 *   compares that origin with the redeeming request's Origin header.
 * - Redemption is unauthenticated, so attempts are rate limited per client and per door
 *   (client-throttle.service). Requests through Cloudflare are counted by CF-Connecting-IP and
 *   share their own total, so a flood on the public domain can neither block other public clients
 *   beyond that total nor block switches that arrive through the tailnet door. With 256-bit codes
 *   the limit only bounds wasted work, not guessing odds.
 * - Codes live in memory: a restart drops them, which at a 60 s lifetime only means switching again.
 */

/** What a handoff code stands for; the auth service turns it into a session on redemption. */
type HandoffGrant = {
  userId: number;
  username: string;
  target: StudioIngressId;
  /** Exact `URL.origin` of the target door; the redeeming request's Origin must equal it. */
  targetOrigin: string;
  /**
   * The Tailscale claim to carry over, so the new session stays revocable by the allowlist. Only
   * present when the source session had one and the auth service allowed it to move.
   */
  tailscaleSession?: { login: string; node: string };
};

type HandoffStoreOptions = {
  now?: () => number;
  randomCode?: () => string;
  /** Code lifetime; 60 s by default. */
  ttlMs?: number;
  /** Most codes kept at once; issuing beyond it drops the oldest. */
  maxPending?: number;
  /** Redemption attempts one client may make per window. */
  redeemAttemptsPerClient?: number;
  /** Redemption attempts all clients of one door may make together per window. */
  redeemAttemptsPerDoor?: number;
  redeemWindowMs?: number;
};

type HandoffRedemption =
  | { status: 'ok'; grant: HandoffGrant }
  | { status: 'invalid' }
  | { status: 'rate-limited' };

const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * Creates the in-memory store of pending handoff codes.
 * Used by auth.module (composition root), which injects it into the auth service, and by the auth
 * tests with a fake clock.
 */
export function createHandoffCodeStore(options: HandoffStoreOptions = {}) {
  const now = options.now ?? Date.now;
  const randomCode = options.randomCode ?? (() => randomBytes(32).toString('base64url'));
  const ttlMs = options.ttlMs ?? 60_000;
  const maxPending = options.maxPending ?? 16;
  const redemptions = createClientThrottle({
    now,
    windowMs: options.redeemWindowMs ?? 60_000,
    perClient: options.redeemAttemptsPerClient ?? 10,
    perDoor: options.redeemAttemptsPerDoor ?? 30,
  });
  // Keyed by SHA-256 of the code; Map iteration order is insertion order, oldest first.
  const pending = new Map<string, { grant: HandoffGrant; expiresAt: number }>();

  function prune(at: number) {
    for (const [hash, entry] of pending) {
      if (entry.expiresAt <= at) pending.delete(hash);
    }
  }

  return {
    /** Stores a grant and returns its code; the plain code is never kept. */
    issue(grant: HandoffGrant): { code: string; expiresAt: number } {
      const at = now();
      prune(at);
      while (pending.size >= maxPending) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      const code = randomCode();
      const expiresAt = at + ttlMs;
      pending.set(hashCode(code), { grant: { ...grant }, expiresAt });
      return { code, expiresAt };
    },

    /**
     * Consumes a code. Every attempt that is not already refused counts towards the client's and its
     * door's limit, and a known code is deleted even when the caller later refuses it (wrong origin),
     * so a leaked code is burned by its first use.
     */
    redeem(code: unknown, client: StudioRequestClient): HandoffRedemption {
      if (redemptions.isBlocked(client)) {
        return { status: 'rate-limited' };
      }
      redemptions.record(client);
      const at = now();
      prune(at);
      if (typeof code !== 'string' || !CODE_PATTERN.test(code)) {
        return { status: 'invalid' };
      }
      const hash = hashCode(code);
      const entry = pending.get(hash);
      if (!entry) {
        return { status: 'invalid' };
      }
      pending.delete(hash);
      return { status: 'ok', grant: entry.grant };
    },

    /**
     * Drops every pending code of one user. Called after "退出所有设备", so a code issued by a
     * session that was just revoked cannot be redeemed for a fresh one.
     */
    discardForUser(userId: number): number {
      let discarded = 0;
      for (const [hash, entry] of pending) {
        if (entry.grant.userId === userId) {
          pending.delete(hash);
          discarded += 1;
        }
      }
      return discarded;
    },
  };
}
