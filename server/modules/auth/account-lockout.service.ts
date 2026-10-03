import type { createAuthSecurityStore } from './auth-security.store.js';

type LockoutStore = ReturnType<typeof createAuthSecurityStore>['lockouts'];
type StepUpFailureStore = ReturnType<typeof createAuthSecurityStore>['stepUpFailures'];

/**
 * Which password door a count belongs to. Each scope locks on its own, so a guesser on the public
 * domain never locks the owner out of the other doors:
 * - `public`: password sign-in through the public domain (and anything not proven to be Tailscale);
 * - `tailnet`: password sign-in through Tailscale Serve;
 * - `session`: the password re-entered by an already signed-in session (Settings step-up, handoff
 *   to the public door), a budget per session (the token's session id, as `subject`) that sign-in
 *   locks never block, so a stolen token can only ever lock its own step-ups.
 */
type LockScope = 'public' | 'tailnet' | 'session';

type AccountLockoutDependencies = {
  store: LockoutStore;
  /**
   * True for a username that belongs to an account. Such rows are flagged when saved and never
   * evicted to make room, so a flood of made-up names cannot reset the owner's lock or level.
   */
  isAccount(username: string): boolean;
  now?: () => number;
  /** Most rows kept for usernames that are not accounts; beyond it the least recent are evicted. */
  maxTrackedUnknown?: number;
};

/** Consecutive wrong passwords that lock a scope. */
const LOCKOUT_THRESHOLD = 5;
// The first lock lasts 15 minutes; each further lock in a row doubles, up to a day.
const BASE_LOCK_MS = 15 * 60_000;
const MAX_LOCK_MS = 24 * 60 * 60_000;
// A day after the last lock ended (with no attempt since), the next lock starts at 15 minutes again.
const LEVEL_RESET_AFTER_MS = MAX_LOCK_MS;
// No password comparison takes this long; an attempt older than this never reported its outcome.
const STALE_ATTEMPT_MS = 60_000;
const MAX_USERNAME_LENGTH = 128;
const DEFAULT_MAX_TRACKED_UNKNOWN = 10_000;

/**
 * How long the n-th lock in a row lasts: 15 min, 30 min, 1 h, 2 h ... capped at 24 h.
 * Used by this service and by its tests to state the schedule once.
 */
export function lockDurationMs(level: number): number {
  return Math.min(BASE_LOCK_MS * 2 ** Math.max(0, level - 1), MAX_LOCK_MS);
}

// Usernames are matched exactly, like the users table does; the cap keeps keys small.
function usernameOf(username: string): string {
  return username.slice(0, MAX_USERNAME_LENGTH);
}

/**
 * Account lockout for password checks, persisted through the auth security store so it survives
 * restarts, counted separately per LockScope. Every password check goes through
 * begin -> compare -> fail | clear:
 * - `begin` refuses while the scope is locked, and also while five attempts are already counted
 *   (parallel guesses cannot all slip past while bcrypt runs); otherwise it counts the attempt.
 * - `fail` locks the scope once five attempts in a row failed: 15 min, then 30, 60 ... up to 24 h.
 * - `clear` (a success that proved the owner on that scope) resets the count and the level.
 * Unknown usernames are tracked exactly like the account, so locks and lock levels are the same
 * for real and made-up names; only the cap on tracked made-up names differs, and it evicts by age
 * alone (the least recently relevant row first), never by whether a name exists.
 * Used by auth.module, which injects it into auth.service and account-security.service.
 */
export function createAccountLockout(dependencies: AccountLockoutDependencies) {
  const now = dependencies.now ?? Date.now;
  const maxTrackedUnknown = dependencies.maxTrackedUnknown ?? DEFAULT_MAX_TRACKED_UNKNOWN;
  const { store } = dependencies;
  // "<scope>:<username>", or "<scope>:<username>#<subject>" for one session's own budget.
  const keyOf = (username: string, scope: LockScope, subject?: string) =>
    `${scope}:${usernameOf(username)}${subject ? `#${subject.slice(0, 64)}` : ''}`;

  // Evicts the least recently relevant made-up usernames until there is room for one more row.
  function makeRoom() {
    const excess = store.countUnknown() - maxTrackedUnknown + 1;
    if (excess <= 0) return;
    for (const key of store.oldestUnknownKeys(excess)) store.remove(key);
  }

  // The current row as begin/fail/status should see it (not written back by itself):
  // - five counted attempts that never reported back (the process stopped mid-compare) settle as a
  //   lock that started when the last of them began, so they cannot hold the scope forever;
  // - a day without attempts after the last lock ended forgets the count and the level.
  function current(key: string, at: number) {
    let row = store.get(key);
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
     * attempts still in flight); `retryAfterMs` is how long until the scope reopens.
     */
    begin(username: string, scope: LockScope, subject?: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
      const at = now();
      const key = keyOf(username, scope, subject);
      const row = current(key, at);
      if (row && row.locked_until > at) {
        return { allowed: false, retryAfterMs: row.locked_until - at };
      }
      if (row && row.failures >= LOCKOUT_THRESHOLD) {
        return { allowed: false, retryAfterMs: lockDurationMs(row.level + 1) };
      }
      // One session's step-up budget is not an account's lock: it may be evicted (the per-user
      // StepUpFailureCap still bounds that user), and it says nothing about which names exist.
      const isAccount = !subject && dependencies.isAccount(usernameOf(username)) ? 1 : 0;
      if (!row && !isAccount) makeRoom();
      store.save({
        account_key: key,
        failures: (row?.failures ?? 0) + 1,
        level: row?.level ?? 0,
        locked_until: 0,
        updated_at: at,
        is_account: isAccount,
      });
      return { allowed: true };
    },

    /** Call after a wrong password; returns the lock it applied, if this was the fifth in a row. */
    fail(username: string, scope: LockScope, subject?: string): { locked: false } | { locked: true; level: number; durationMs: number; lockedUntil: number } {
      const at = now();
      const key = keyOf(username, scope, subject);
      const row = current(key, at);
      if (!row || row.locked_until > at || row.failures < LOCKOUT_THRESHOLD) {
        return { locked: false };
      }
      const level = row.level + 1;
      const durationMs = lockDurationMs(level);
      store.save({ ...row, account_key: key, failures: 0, level, locked_until: at + durationMs, updated_at: at });
      return { locked: true, level, durationMs, lockedUntil: at + durationMs };
    },

    /** Call after a success that proved the owner on this scope; tells whether a lock was lifted. */
    clear(username: string, scope: LockScope, subject?: string): { cleared: boolean; wasLocked: boolean } {
      const key = keyOf(username, scope, subject);
      const row = store.get(key);
      if (!row) return { cleared: false, wasLocked: false };
      store.remove(key);
      return { cleared: true, wasLocked: row.locked_until > now() };
    },

    /**
     * Forgets a scope for a user entirely, every session's budget included. Used after a sign-in
     * that proved the owner and after "退出所有设备"; returns how many records went.
     */
    clearScope(username: string, scope: LockScope): number {
      return store.removeFamily(keyOf(username, scope));
    },

    /** Lock state of one username in one scope (and session), for Settings. */
    status(username: string, scope: LockScope, subject?: string): { locked: boolean; lockedUntil: number | null; failures: number; level: number } {
      const at = now();
      const row = current(keyOf(username, scope, subject), at);
      const locked = Boolean(row && row.locked_until > at);
      return { locked, lockedUntil: locked && row ? row.locked_until : null, failures: row?.failures ?? 0, level: row?.level ?? 0 };
    },
  };
}

/** Wrong step-up passwords one user may enter across all sessions per rolling window. */
const STEP_UP_CAP = 20;
const STEP_UP_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The per-user cap on step-up and handoff passwords across every session: 20 attempts that did
 * not succeed per rolling 24 hours, persisted. It sits beside the per-session budget so that
 * minting new sessions (self-handoff) cannot buy more guesses. Sign-ins never reset it; only
 * "退出所有设备" (after it succeeded) and scripts/clear-login-lock.mjs do.
 * Used by auth.module, which injects it into auth.service and account-security.service.
 */
export function createStepUpFailureCap(dependencies: { store: StepUpFailureStore; now?: () => number; max?: number; windowMs?: number }) {
  const now = dependencies.now ?? Date.now;
  const max = dependencies.max ?? STEP_UP_CAP;
  const windowMs = dependencies.windowMs ?? STEP_UP_WINDOW_MS;
  return {
    /** Whether the user may try another step-up password now (counts nothing). */
    check(username: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
      const at = now();
      const { count, oldest } = dependencies.store.countSince(username, at - windowMs);
      return count >= max ? { allowed: false, retryAfterMs: Math.max(1000, (oldest ?? at) + windowMs - at) } : { allowed: true };
    },

    /**
     * Counts one attempt that is about to compare a password (only those count: requests refused
     * by a throttle or lock never reach here). Returns its id, for `succeed` to take back.
     */
    record(username: string): number {
      return dependencies.store.add(username, now());
    },

    /** A correct password does not count. */
    succeed(attemptId: number): void {
      dependencies.store.remove(attemptId);
    },

    /** Forgets the user's attempts ("退出所有设备" or the local script); returns how many. */
    reset(username: string): number {
      return dependencies.store.clearUser(username);
    },
  };
}
