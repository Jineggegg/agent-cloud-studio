import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type Database from 'better-sqlite3';

import { AppError } from '@/shared/utils.js';
import type { StudioT212PasskeyGate, StudioT212Requester, StudioT212StepUpProblem, StudioT212TrustedOrigin } from '@/shared/types.js';

// A change waiting for its Face ID / Touch ID assertion: the exact values, who asked, where, and the bound challenge.
type Pending<Binding> = {
  binding: Binding; userId: number; sessionId: string; client: string; origin: string; rpId: string; nonce: string;
  challenge: string; issuedAt: number; expiresAt: number; auditRowId: number;
};
// What the hourly budgets count, always for one session and client:
// issued: challenges handed out that were used, replaced by the session's own newer ones, or are still open (expired
// ones never count, so a review left to time out costs nothing);
// refused: refused attempts, except benign ones (an expired or stale review);
// failed: refused attempts that were real challenge failures (bad signature, tampered values), which alone gate
// issuance, so a refusal of any other kind can never stop the owner from asking for Face ID.
type Budget = 'issued' | 'refused' | 'failed';
// What became of an issued challenge: still open, redeemed, left to expire, or replaced by newer ones of the session.
type IssuedOutcome = 'pending' | 'used' | 'expired' | 'replaced';

// The assertion must arrive within a minute of the challenge.
const CHALLENGE_TTL_MS = 60_000;
// Older unanswered challenges of the same session and client are replaced beyond this many.
const MAX_PENDING_PER_REQUESTER = 5;
// Rate limits count audit rows of one rolling hour.
const RATE_WINDOW_MS = 60 * 60_000;
// Refused and issued audit rows kept per session and client (each kind); applied changes are never pruned.
const AUDIT_RETENTION = 100;
// Audit tables are fixed identifiers of this module, never request input; checked anyway because they are interpolated.
const AUDIT_TABLE = /^studio_t212_[a-z_]+$/;
// Who asked and what became of it; added to audit tables created before they existed.
const AUDIT_COLUMNS = ['session_id', 'client', 'code', 'outcome'];

/**
 * Used by the Trading 212 caps service (raising caps) and trading-mode service (adding accounts that may trade),
 * both created by the orders service, to gate a change that widens what can be traded behind Face ID / Touch ID.
 *
 * A challenge is single-use and lives 60 seconds; its bytes are a SHA-256 digest of `tag` (so a challenge for one
 * setting never fits another), the user, the requesting session, origin, RP ID, the exact binding (`encode`: the
 * state the review showed and the new values) and a fresh nonce, so an assertion approves only the change that was
 * reviewed, from the state it was reviewed in. `take` spends a challenge synchronously, before anything else is
 * checked, but only for the session it was issued to: another user's or session's id is ignored rather than spent.
 * `verify` checks the origin, expiry, staleness and binding before the signature, which the passkey gate verifies
 * against the stored credential with user verification required and a counter advance.
 *
 * Budgets, eviction and retention are per session and client (StudioT212Requester), so a stolen session cannot
 * lock the owner out: its refusals never gate issuance, its challenges never evict the owner's, and revoking it
 * ends its share. The caller's audit table (user_id, status, created_at, session_id, client, code, outcome) is the
 * counter, so limits survive a restart; the caller words every refusal for its own setting.
 */
export function createTrading212StepUp<Binding>(deps: {
  database: Database.Database;
  // Audit table of the gated setting, already created by the caller; missing who/outcome columns are added here.
  auditTable: string;
  // Domain separation inside the digest, e.g. 'studio-t212-caps-v2'.
  tag: string;
  // The exact binding an assertion approves, in a canonical order; numbers must be exact (String(), not toFixed()).
  encode: (binding: Binding) => string[];
  // True when the requested values equal the issued ones but the state they were reviewed against has moved on.
  isStale: (issued: Binding, submitted: Binding) => boolean;
  // Refusal codes that never count against a session (expired or stale reviews).
  benignCodes: string[];
  // Refusal codes of real challenge failures (bad signature, tampered values); only these gate issuance.
  failureCodes: string[];
  passkeys: StudioT212PasskeyGate;
  now: () => number;
}) {
  const db = deps.database;
  const now = deps.now;
  if (!AUDIT_TABLE.test(deps.auditTable)) throw new Error(`invalid step-up audit table ${deps.auditTable}`);
  const table = deps.auditTable;
  const pending = new Map<string, Pending<Binding>>();
  const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name));
  for (const column of AUDIT_COLUMNS) if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS ${table}_requester ON ${table} (user_id, session_id, client, status, created_at)`);

  const isoNow = () => new Date(now()).toISOString();
  function digest(binding: Binding, userId: number, sessionId: string, origin: StudioT212TrustedOrigin, nonce: string) {
    const canonical = JSON.stringify([deps.tag, userId, sessionId, origin.origin, origin.rpId, ...deps.encode(binding), nonce]);
    return createHash('sha256').update(canonical).digest();
  }
  function settle(rowId: number, outcome: Exclude<IssuedOutcome, 'pending'>) {
    db.prepare(`UPDATE ${table} SET outcome = ? WHERE row_id = ? AND outcome IS NULL`).run(outcome, rowId);
  }
  function prune() {
    const time = now();
    for (const [id, item] of pending) {
      if (item.expiresAt > time) continue;
      pending.delete(id);
      settle(item.auditRowId, 'expired');
    }
  }
  // The rows a budget counts for this session and client, in the last hour (expired challenges never count, and an
  // issued row left open counts only while its challenge could still be redeemed).
  function budgetFilter(budget: Budget) {
    const codes = (list: string[]) => list.map(() => '?').join(', ') || "''";
    if (budget === 'issued') {
      return {
        sql: `status = 'issued' AND (outcome IN ('used', 'replaced') OR (outcome IS NULL AND created_at > ?))`,
        params: [new Date(now() - CHALLENGE_TTL_MS).toISOString()],
      };
    }
    if (budget === 'failed') return { sql: `status = 'refused' AND code IN (${codes(deps.failureCodes)})`, params: deps.failureCodes };
    return { sql: `status = 'refused' AND (code IS NULL OR code NOT IN (${codes(deps.benignCodes)}))`, params: deps.benignCodes };
  }

  return {
    // The domains where this user has a passkey, and whether `rpId` is one of them.
    passkeyDomains(userId: number, rpId: string) {
      const domains = [...new Set(deps.passkeys.rpIds(userId))];
      return { domains, here: domains.includes(rpId) };
    },

    // Refuses with a 429 (and its wait in details.retryAfterSeconds, sent as Retry-After) once this session and
    // client have `max` rows of `budget` in the last hour; the wait is until the oldest of them leaves the window.
    assertUnderLimit(userId: number, requester: StudioT212Requester, budget: Budget, max: number, code: string, message: (minutes: number) => string) {
      const filter = budgetFilter(budget);
      const recent = db.prepare(`SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM ${table}
        WHERE user_id = ? AND session_id = ? AND client = ? AND created_at > ? AND ${filter.sql}`)
        .get(userId, requester.sessionId, requester.client, new Date(now() - RATE_WINDOW_MS).toISOString(), ...filter.params) as
        { count: number; oldest: string | null };
      if (recent.count < max) return;
      const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(recent.oldest ?? isoNow()) + RATE_WINDOW_MS - now()) / 1000));
      throw new AppError(message(Math.ceil(retryAfterSeconds / 60)), { statusCode: 429, code, details: { retryAfterSeconds } });
    },

    // Keeps the newest refused or issued rows of this session and client, so no other session can flush them.
    trimAudit(userId: number, requester: StudioT212Requester, status: 'refused' | 'issued') {
      db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND session_id = ? AND client = ? AND status = ? AND row_id NOT IN
        (SELECT row_id FROM ${table} WHERE user_id = ? AND session_id = ? AND client = ? AND status = ? ORDER BY row_id DESC LIMIT ?)`)
        .run(userId, requester.sessionId, requester.client, status, userId, requester.sessionId, requester.client, status, AUDIT_RETENTION);
    },

    // What became of an issued challenge, from its audit row: a row left open past the 60 seconds has expired.
    outcome(row: { outcome: string | null; created_at: string }): IssuedOutcome {
      if (row.outcome === 'used' || row.outcome === 'expired' || row.outcome === 'replaced') return row.outcome;
      return Date.parse(row.created_at) + CHALLENGE_TTL_MS > now() ? 'pending' : 'expired';
    },

    // Issues the bound, single-use challenge (its audit row is `auditRowId`) and WebAuthn request options for this
    // domain's passkeys. Only this session's own older challenges are replaced. Everything up to the options call
    // runs synchronously, so the caller's limit check and audit row stay in the same step.
    async issue(userId: number, requester: StudioT212Requester, origin: StudioT212TrustedOrigin, binding: Binding, auditRowId: number) {
      prune();
      const mine = [...pending]
        .filter(([, item]) => item.userId === userId && item.sessionId === requester.sessionId && item.client === requester.client)
        .sort((a, b) => a[1].issuedAt - b[1].issuedAt);
      for (const [id, item] of mine.slice(0, Math.max(0, mine.length - MAX_PENDING_PER_REQUESTER + 1))) {
        pending.delete(id);
        settle(item.auditRowId, 'replaced');
      }
      const nonce = randomBytes(16).toString('hex');
      const bytes = digest(binding, userId, requester.sessionId, origin, nonce);
      // The 60 seconds start when the challenge exists, not when its options have been built.
      const issuedAt = now();
      const authentication = await deps.passkeys.options(userId, origin.rpId, new Uint8Array(bytes), CHALLENGE_TTL_MS);
      const id = randomUUID();
      pending.set(id, {
        binding, userId, sessionId: requester.sessionId, client: requester.client, origin: origin.origin, rpId: origin.rpId,
        nonce, challenge: bytes.toString('base64url'), issuedAt, expiresAt: issuedAt + CHALLENGE_TTL_MS, auditRowId,
      });
      return { challengeId: id, expiresAt: new Date(issuedAt + CHALLENGE_TTL_MS).toISOString(), authentication };
    },

    // Spends a named challenge of this user and session and returns what it was issued for; undefined, with nothing
    // spent, for an unknown id or one that belongs to another user or session.
    take(userId: number, requester: StudioT212Requester, challengeId: string | undefined) {
      const found = challengeId ? pending.get(challengeId) : undefined;
      if (!challengeId || !found || found.userId !== userId || found.sessionId !== requester.sessionId) return undefined;
      pending.delete(challengeId);
      settle(found.auditRowId, found.expiresAt <= now() ? 'expired' : 'used');
      return found;
    },

    // Checks a spent challenge against the request: a trusted origin, within 60 seconds, the origin it was issued to,
    // the state it was reviewed in, exactly the values it was issued for, then the assertion over it. The passkey id,
    // or what is wrong.
    async verify(
      issued: Pending<Binding>, userId: number, requester: StudioT212Requester, origin: StudioT212TrustedOrigin | null,
      binding: Binding, assertion: AuthenticationResponseJSON | undefined,
    ): Promise<{ passkeyId: string; origin: StudioT212TrustedOrigin } | { problem: StudioT212StepUpProblem }> {
      if (!origin) return { problem: 'untrusted-origin' };
      if (now() >= issued.expiresAt) return { problem: 'expired' };
      if (issued.origin !== origin.origin || issued.rpId !== origin.rpId) return { problem: 'wrong-origin' };
      if (deps.isStale(issued.binding, binding)) return { problem: 'stale' };
      // Values other than those shown at Face ID time produce another digest, so the assertion no longer fits.
      const expected = digest(binding, userId, requester.sessionId, origin, issued.nonce).toString('base64url');
      if (expected !== issued.challenge || !assertion) return { problem: 'tampered' };
      const passkeyId = await deps.passkeys.verify(userId, origin.rpId, assertion, expected, origin.origin);
      return passkeyId ? { passkeyId, origin } : { problem: 'passkey-failed' };
    },
  };
}
