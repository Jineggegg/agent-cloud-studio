import type { createAuthSecurityStore } from './auth-security.store.js';

type LockoutStore = ReturnType<typeof createAuthSecurityStore>['lockouts'];

type AccountLockoutDependencies = {
  store: LockoutStore;
  /**
   * True for a username that belongs to an account. Only used when making room: rows of real
   * accounts are never evicted, so a flood of made-up names cannot lift the owner's lock.
   */
  isAccount(accountKey: string): boolean;
  now?: () => number;
  /** Most rows kept; unknown usernames beyond it are evicted oldest first. */
  maxTrackedKeys?: number;
};

/** Consecutive wrong passwords that lock password sign-in for the account. */
const LOCKOUT_THRESHOLD = 5;
// The first lock lasts 15 minutes; each further lock in a row doubles, up to a day.
const BASE_LOCK_MS = 15 * 60_000;
const MAX_LOCK_MS = 24 * 60 * 60_000;
// A day after the last lock ended (with no attempt since), the next lock starts at 15 minutes again.
const LEVEL_RESET_AFTER_MS = MAX_LOCK_MS;
// No password comparison takes this long; an attempt older than this never reported its outcome.
const STALE_ATTEMPT_MS = 60_000;
const MAX_ACCOUNT_KEY_LENGTH = 128;
const DEFAULT_MAX_TRACKED_KEYS = 1024;

/**
 * How long the n-th lock in a row lasts: 15 min, 30 min, 1 h, 2 h ... capped at 24 h.
 * Used by this service and by its tests to state the schedule once.
 */
export function lockDurationMs(level: number): number {
  return Math.min(BASE_LOCK_MS * 2 ** Math.max(0, level - 1), MAX_LOCK_MS);
}

// Usernames are matched exactly, like the users table does; the cap keeps keys small.
function accountKeyOf(username: string): string {
  return username.slice(0, MAX_ACCOUNT_KEY_LENGTH);
}

/**
 * Account lockout for password sign-in, persisted through the auth security store so it survives
 * restarts. Every password check for an account (login, the handoff password, the Settings step-up)
 * goes through begin -> compare -> fail | succeed:
 * - `begin` refuses while the account is locked, and also while five attempts are already counted
 *   (parallel guesses cannot all slip past while bcrypt runs); otherwise it counts the attempt.
 * - `fail` locks the account once five attempts in a row failed: 15 min, then 30, 60 ... up to 24 h.
 * - `clear` (any successful sign-in: password, passkey or Tailscale) resets the count and the level.
 * Unknown usernames are tracked exactly like the account, so a lock reveals nothing about which
 * names exist. Used by auth.module, which injects it into auth.service and account-security.service.
 */
export function createAccountLockout(dependencies: AccountLockoutDependencies) {
  const now = dependencies.now ?? Date.now;
  const maxTrackedKeys = dependencies.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
  const { store } = dependencies;

  // Evicts the least recently touched unknown usernames until there is room for one more row.
  function makeRoom() {
    let excess = store.count() - maxTrackedKeys + 1;
    if (excess <= 0) return;
    for (const key of store.oldestKeys(excess + 64)) {
      if (excess <= 0) break;
      if (!dependencies.isAccount(key) && store.remove(key)) excess -= 1;
    }
  }

  // The current row as begin/fail/status should see it (not written back by itself):
  // - five counted attempts that never reported back (the process stopped mid-compare) settle as a
  //   lock that started when the last of them began, so they cannot hold the account forever;
  // - a day without attempts after the last lock ended forgets the count and the level.
  function current(accountKey: string, at: number) {
    let row = store.get(accountKey);
    if (!row) return null;
    if (row.locked_until <= at && row.failures >= LOCKOUT_THRESHOLD && at - row.updated_at > STALE_ATTEMPT_MS) {
      const level = row.level + 1;
      row = { ...row, failures: 0, level, locked_until: row.updated_at + lockDurationMs(level) };
    }
    if (row.locked_until <= at && at - Math.max(row.updated_at, row.locked_until) > LEVEL_RESET_AFTER_MS) {
      return { ...row, failures: 0, level: 0, locked_until: 0 };
    }
    return row;
  }

  return {
    /**
     * Call before comparing a password. Refused while locked (or while the budget is taken by
     * attempts still in flight); `retryAfterMs` is how long until password sign-in reopens.
     */
    begin(username: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
      const at = now();
      const accountKey = accountKeyOf(username);
      const row = current(accountKey, at);
      if (row && row.locked_until > at) {
        return { allowed: false, retryAfterMs: row.locked_until - at };
      }
      if (row && row.failures >= LOCKOUT_THRESHOLD) {
        return { allowed: false, retryAfterMs: lockDurationMs(row.level + 1) };
      }
      if (!row) makeRoom();
      store.save({
        account_key: accountKey,
        failures: (row?.failures ?? 0) + 1,
        level: row?.level ?? 0,
        locked_until: 0,
        updated_at: at,
      });
      return { allowed: true };
    },

    /** Call after a wrong password; returns the lock it applied, if this was the fifth in a row. */
    fail(username: string): { locked: false } | { locked: true; level: number; durationMs: number; lockedUntil: number } {
      const at = now();
      const accountKey = accountKeyOf(username);
      const row = current(accountKey, at);
      if (!row || row.locked_until > at || row.failures < LOCKOUT_THRESHOLD) {
        return { locked: false };
      }
      const level = row.level + 1;
      const durationMs = lockDurationMs(level);
      store.save({ account_key: accountKey, failures: 0, level, locked_until: at + durationMs, updated_at: at });
      return { locked: true, level, durationMs, lockedUntil: at + durationMs };
    },

    /** Call after any successful sign-in; tells whether a lock or counted failures were cleared. */
    clear(username: string): { cleared: boolean; wasLocked: boolean } {
      const accountKey = accountKeyOf(username);
      const row = store.get(accountKey);
      if (!row) return { cleared: false, wasLocked: false };
      store.remove(accountKey);
      return { cleared: true, wasLocked: row.locked_until > now() };
    },

    /** Lock state of one username, for Settings. */
    status(username: string): { locked: boolean; lockedUntil: number | null; failures: number; level: number } {
      const at = now();
      const row = current(accountKeyOf(username), at);
      const locked = Boolean(row && row.locked_until > at);
      return { locked, lockedUntil: locked && row ? row.locked_until : null, failures: row?.failures ?? 0, level: row?.level ?? 0 };
    },
  };
}
