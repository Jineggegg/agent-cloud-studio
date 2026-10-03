import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type Database from 'better-sqlite3';

import { AppError } from '@/shared/utils.js';
import type { StudioT212PasskeyGate, StudioT212StepUpProblem, StudioT212TrustedOrigin } from '@/shared/types.js';

// A change waiting for its Face ID / Touch ID assertion: the exact values, who asked, where, and the bound challenge.
type Pending<Binding> = {
  binding: Binding; userId: number; origin: string; rpId: string; nonce: string; challenge: string; issuedAt: number; expiresAt: number;
};
// Audit rows that double as the hourly counters: refused attempts and issued challenges.
type CountedStatus = 'refused' | 'issued';

// The assertion must arrive within a minute of the challenge.
const CHALLENGE_TTL_MS = 60_000;
// Older unanswered challenges of the same user are dropped beyond this many.
const MAX_PENDING_PER_USER = 5;
// Rate limits count audit rows of one rolling hour.
const RATE_WINDOW_MS = 60 * 60_000;
// Refused and issued audit rows kept per user (each kind); applied changes are never pruned.
const AUDIT_RETENTION = 100;
// Audit tables are fixed identifiers of this module, never request input; checked anyway because they are interpolated.
const AUDIT_TABLE = /^studio_t212_[a-z_]+$/;

/**
 * Used by the Trading 212 caps service (raising caps) and trading-mode service (adding accounts that may trade),
 * both created by the orders service, to gate a change that widens what can be traded behind Face ID / Touch ID.
 *
 * A challenge is single-use and lives 60 seconds; its bytes are a SHA-256 digest of `tag` (so a challenge for one
 * setting never fits another), the user, origin, RP ID, the exact new values (`encode`) and a fresh nonce, so an
 * assertion approves only the change that was reviewed. `take` spends a challenge synchronously, before anything
 * else is checked, so a parallel attempt with the same id finds it gone; another user's id is ignored rather than
 * spent, so it cannot be used to burn theirs. `verify` checks the origin, expiry and binding before the signature,
 * which the passkey gate verifies against the stored credential with user verification required and a counter
 * advance. The caller's audit table (with `user_id`, `status` and `created_at` columns) is the hourly rate-limit
 * counter, so limits survive a restart; the caller words every refusal for its own setting.
 */
export function createTrading212StepUp<Binding>(deps: {
  database: Database.Database;
  // Audit table of the gated setting; its refused and issued rows are counted and pruned here.
  auditTable: string;
  // Domain separation inside the digest, e.g. 'studio-t212-caps-v1'.
  tag: string;
  // The exact values an assertion approves, in a canonical order; numbers must be exact (String(), not toFixed()).
  encode: (binding: Binding) => string[];
  passkeys: StudioT212PasskeyGate;
  now: () => number;
}) {
  const db = deps.database;
  const now = deps.now;
  if (!AUDIT_TABLE.test(deps.auditTable)) throw new Error(`invalid step-up audit table ${deps.auditTable}`);
  const table = deps.auditTable;
  const pending = new Map<string, Pending<Binding>>();

  const isoNow = () => new Date(now()).toISOString();
  function digest(binding: Binding, userId: number, origin: StudioT212TrustedOrigin, nonce: string) {
    const canonical = JSON.stringify([deps.tag, userId, origin.origin, origin.rpId, ...deps.encode(binding), nonce]);
    return createHash('sha256').update(canonical).digest();
  }
  function prune() {
    const time = now();
    for (const [id, item] of pending) if (item.expiresAt <= time) pending.delete(id);
  }

  return {
    // The domains where this user has a passkey, and whether `rpId` is one of them.
    passkeyDomains(userId: number, rpId: string) {
      const domains = [...new Set(deps.passkeys.rpIds(userId))];
      return { domains, here: domains.includes(rpId) };
    },

    // Refuses with a 429 (and its wait in details.retryAfterSeconds, sent as Retry-After) once this user has `max`
    // `status` rows in the last hour; the wait is until the oldest of them leaves the window.
    assertUnderLimit(userId: number, status: CountedStatus, max: number, code: string, message: (minutes: number) => string) {
      const recent = db.prepare(`SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM ${table}
        WHERE user_id = ? AND status = ? AND created_at > ?`).get(userId, status, new Date(now() - RATE_WINDOW_MS).toISOString()) as
        { count: number; oldest: string | null };
      if (recent.count < max) return;
      const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(recent.oldest ?? isoNow()) + RATE_WINDOW_MS - now()) / 1000));
      throw new AppError(message(Math.ceil(retryAfterSeconds / 60)), { statusCode: 429, code, details: { retryAfterSeconds } });
    },

    // Keeps the newest refused or issued rows of this user; the hourly limits keep far fewer than this in their window.
    trimAudit(userId: number, status: CountedStatus) {
      db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND status = ? AND row_id NOT IN
        (SELECT row_id FROM ${table} WHERE user_id = ? AND status = ? ORDER BY row_id DESC LIMIT ?)`)
        .run(userId, status, userId, status, AUDIT_RETENTION);
    },

    // Issues the bound, single-use challenge and its WebAuthn request options for this domain's passkeys. Everything
    // up to the options call runs synchronously, so the caller's limit check and audit row stay in the same step.
    async issue(userId: number, origin: StudioT212TrustedOrigin, binding: Binding) {
      prune();
      const mine = [...pending].filter(([, item]) => item.userId === userId).sort((a, b) => a[1].issuedAt - b[1].issuedAt);
      for (const [id] of mine.slice(0, Math.max(0, mine.length - MAX_PENDING_PER_USER + 1))) pending.delete(id);
      const nonce = randomBytes(16).toString('hex');
      const bytes = digest(binding, userId, origin, nonce);
      // The 60 seconds start when the challenge exists, not when its options have been built.
      const issuedAt = now();
      const authentication = await deps.passkeys.options(userId, origin.rpId, new Uint8Array(bytes), CHALLENGE_TTL_MS);
      const id = randomUUID();
      pending.set(id, {
        binding, userId, origin: origin.origin, rpId: origin.rpId, nonce, challenge: bytes.toString('base64url'),
        issuedAt, expiresAt: issuedAt + CHALLENGE_TTL_MS,
      });
      return { challengeId: id, expiresAt: new Date(issuedAt + CHALLENGE_TTL_MS).toISOString(), authentication };
    },

    // Spends this user's named challenge and returns what it was issued for; undefined (nothing spent) otherwise.
    take(userId: number, challengeId: string | undefined) {
      const found = challengeId ? pending.get(challengeId) : undefined;
      if (!challengeId || !found || found.userId !== userId) return undefined;
      pending.delete(challengeId);
      return found;
    },

    // Checks a spent challenge against the request: a trusted origin, within 60 seconds, the origin it was issued to,
    // exactly the values it was issued for, then the assertion over it. The passkey id, or what is wrong.
    async verify(
      issued: Pending<Binding>, userId: number, origin: StudioT212TrustedOrigin | null, binding: Binding, assertion: AuthenticationResponseJSON | undefined,
    ): Promise<{ passkeyId: string; origin: StudioT212TrustedOrigin } | { problem: StudioT212StepUpProblem }> {
      if (!origin) return { problem: 'untrusted-origin' };
      if (now() >= issued.expiresAt) return { problem: 'expired' };
      if (issued.origin !== origin.origin || issued.rpId !== origin.rpId) return { problem: 'wrong-origin' };
      // Values other than those shown at Face ID time produce another digest, so the assertion no longer fits.
      const expected = digest(binding, userId, origin, issued.nonce).toString('base64url');
      if (expected !== issued.challenge || !assertion) return { problem: 'tampered' };
      const passkeyId = await deps.passkeys.verify(userId, origin.rpId, assertion, expected, origin.origin);
      return passkeyId ? { passkeyId, origin } : { problem: 'passkey-failed' };
    },
  };
}
