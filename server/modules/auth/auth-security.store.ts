import type Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/index.js';

/**
 * SQLite persistence for the account's sign-in security, in tables the auth module owns:
 * - auth_login_lockouts: consecutive password failures and the lock per typed username, so a lock
 *   survives restarts (unknown usernames get rows too, so a lock never reveals which name exists);
 * - auth_passkeys: WebAuthn sign-in credentials per user and RP ID (separate from the Trading 212
 *   order passkeys, which the Studio module keeps in its own table);
 * - auth_security_events: a bounded log of failed sign-ins, locks, passkey changes and revocations;
 * - auth_session_versions: the per-user token version embedded in every JWT ("sign out everywhere").
 */

type LockoutRow = {
  account_key: string;
  /** Password attempts since the last success or lock, counted before each comparison. */
  failures: number;
  /** How many locks in a row; each one doubles the lock time. */
  level: number;
  /** Epoch milliseconds; 0 or a past time means not locked. */
  locked_until: number;
  updated_at: number;
};

type PasskeyRow = {
  id: string;
  user_id: number;
  rp_id: string;
  credential_id: string;
  public_key: Buffer;
  counter: number;
  transports: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
};

type SecurityEventRow = {
  id: number;
  at: string;
  type: string;
  door: string;
  client: string;
  detail: string | null;
};

// The log keeps the newest events only; a flood of failed logins cannot grow the database.
const MAX_SECURITY_EVENTS = 500;

/**
 * Creates the store on a better-sqlite3 connection, creating its tables when missing.
 * Used by getAuthSecurityStore (production) and by the auth tests on an in-memory database.
 */
export function createAuthSecurityStore(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS auth_login_lockouts (
      account_key TEXT PRIMARY KEY,
      failures INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_login_lockouts_updated ON auth_login_lockouts(updated_at);
    CREATE TABLE IF NOT EXISTS auth_passkeys (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      rp_id TEXT NOT NULL,
      credential_id TEXT NOT NULL UNIQUE,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT NOT NULL DEFAULT '[]',
      label TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_auth_passkeys_user_rp ON auth_passkeys(user_id, rp_id);
    CREATE TABLE IF NOT EXISTS auth_security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      door TEXT NOT NULL,
      client TEXT NOT NULL,
      detail TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_session_versions (
      user_id INTEGER PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 0
    );
  `);

  const statements = {
    lockoutGet: database.prepare('SELECT * FROM auth_login_lockouts WHERE account_key = ?'),
    lockoutUpsert: database.prepare(`
      INSERT INTO auth_login_lockouts (account_key, failures, level, locked_until, updated_at)
      VALUES (@account_key, @failures, @level, @locked_until, @updated_at)
      ON CONFLICT(account_key) DO UPDATE SET
        failures = excluded.failures, level = excluded.level,
        locked_until = excluded.locked_until, updated_at = excluded.updated_at
    `),
    lockoutDelete: database.prepare('DELETE FROM auth_login_lockouts WHERE account_key = ?'),
    lockoutDeleteAll: database.prepare('DELETE FROM auth_login_lockouts'),
    lockoutCount: database.prepare('SELECT COUNT(*) AS count FROM auth_login_lockouts'),
    lockoutOldest: database.prepare('SELECT account_key FROM auth_login_lockouts ORDER BY updated_at ASC LIMIT ?'),
    passkeysForUser: database.prepare('SELECT * FROM auth_passkeys WHERE user_id = ? ORDER BY rp_id, created_at'),
    passkeyByCredential: database.prepare('SELECT * FROM auth_passkeys WHERE credential_id = ?'),
    passkeyById: database.prepare('SELECT * FROM auth_passkeys WHERE id = ? AND user_id = ?'),
    passkeyInsert: database.prepare(`
      INSERT INTO auth_passkeys (id, user_id, rp_id, credential_id, public_key, counter, transports, label, created_at, last_used_at)
      VALUES (@id, @user_id, @rp_id, @credential_id, @public_key, @counter, @transports, @label, @created_at, @last_used_at)
    `),
    passkeyUsage: database.prepare('UPDATE auth_passkeys SET counter = ?, last_used_at = ? WHERE id = ?'),
    passkeyDelete: database.prepare('DELETE FROM auth_passkeys WHERE id = ? AND user_id = ?'),
    eventInsert: database.prepare('INSERT INTO auth_security_events (at, type, door, client, detail) VALUES (?, ?, ?, ?, ?)'),
    eventTrim: database.prepare('DELETE FROM auth_security_events WHERE id <= (SELECT MAX(id) FROM auth_security_events) - ?'),
    eventsRecent: database.prepare('SELECT * FROM auth_security_events ORDER BY id DESC LIMIT ?'),
    versionGet: database.prepare('SELECT version FROM auth_session_versions WHERE user_id = ?'),
    versionBump: database.prepare(`
      INSERT INTO auth_session_versions (user_id, version) VALUES (?, 1)
      ON CONFLICT(user_id) DO UPDATE SET version = version + 1
    `),
  };

  return {
    lockouts: {
      get: (accountKey: string) => statements.lockoutGet.get(accountKey) as LockoutRow | undefined,
      save: (row: LockoutRow) => { statements.lockoutUpsert.run(row); },
      remove: (accountKey: string) => statements.lockoutDelete.run(accountKey).changes > 0,
      removeAll: () => statements.lockoutDeleteAll.run().changes,
      count: () => (statements.lockoutCount.get() as { count: number }).count,
      /** Keys of the least recently touched rows, oldest first, for making room. */
      oldestKeys: (limit: number) => (statements.lockoutOldest.all(limit) as { account_key: string }[]).map((row) => row.account_key),
    },
    passkeys: {
      listForUser: (userId: number) => statements.passkeysForUser.all(userId) as PasskeyRow[],
      findByCredentialId: (credentialId: string) => statements.passkeyByCredential.get(credentialId) as PasskeyRow | undefined,
      findById: (userId: number, id: string) => statements.passkeyById.get(id, userId) as PasskeyRow | undefined,
      insert: (row: PasskeyRow) => { statements.passkeyInsert.run(row); },
      recordUse: (id: string, counter: number, usedAt: string) => { statements.passkeyUsage.run(counter, usedAt, id); },
      remove: (userId: number, id: string) => statements.passkeyDelete.run(id, userId).changes > 0,
    },
    events: {
      append: (event: Omit<SecurityEventRow, 'id'>) => {
        statements.eventInsert.run(event.at, event.type, event.door, event.client, event.detail);
        statements.eventTrim.run(MAX_SECURITY_EVENTS);
      },
      recent: (limit: number) => statements.eventsRecent.all(limit) as SecurityEventRow[],
    },
    sessionVersions: {
      /** 0 until the first "sign out everywhere"; tokens without a version count as 0. */
      current: (userId: number) => (statements.versionGet.get(userId) as { version: number } | undefined)?.version ?? 0,
      bump: (userId: number) => {
        statements.versionBump.run(userId);
        return (statements.versionGet.get(userId) as { version: number }).version;
      },
    },
  };
}

let sharedStore: ReturnType<typeof createAuthSecurityStore> | null = null;

/**
 * The store on the shared database connection, created on first use.
 * Used by auth.module (lockout, passkeys, events, revocation) and auth.middleware (the token
 * version check on every request and WebSocket upgrade), so both see one set of statements.
 */
export function getAuthSecurityStore(): ReturnType<typeof createAuthSecurityStore> {
  sharedStore ??= createAuthSecurityStore(getConnection());
  return sharedStore;
}
