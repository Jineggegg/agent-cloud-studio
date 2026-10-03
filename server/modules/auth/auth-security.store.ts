import type Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/index.js';

/**
 * SQLite persistence for the account's sign-in security, in tables the auth module owns:
 * - auth_login_lockouts: consecutive password failures and the lock per scope and typed username
 *   ("public:andrew"), so a lock survives restarts. Unknown usernames get rows too, so a lock never
 *   reveals which name exists; rows of real accounts are flagged and never evicted;
 * - auth_passkeys: WebAuthn sign-in credentials per user and RP ID (separate from the Trading 212
 *   order passkeys, which the Studio module keeps in its own table);
 * - auth_security_events: a bounded log of sign-ins, locks, passkey changes and revocations, in
 *   three retention classes (noise, important changes, successful sign-ins) so a flood of one can
 *   never push out another;
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
  /** 1 for a real account's row, which the cap on tracked usernames never evicts. */
  is_account: number;
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
  /**
   * Retention class: 0 for anonymous noise (failed attempts), 1 for important changes (locks,
   * passkey changes, revocations), 2 for successful sign-ins. Each class keeps its own newest rows.
   */
  important: number;
  /** Rows with the same key within the collapse window are folded into one (see append). */
  collapse_key: string | null;
  /** How many events this row stands for (1 unless folded). */
  repeats: number;
};

// Each class of events keeps its newest rows only; a flood of failed logins cannot grow the
// database, nor push out a lock, a passkey change or the record of a successful sign-in.
const MAX_EVENTS_PER_CLASS = 500;

function columnsOf(database: Database.Database, table: string): string[] {
  return (database.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((row) => row.name);
}

/**
 * Brings tables created by earlier builds of this store up to date, inside one transaction:
 * - an auth_login_lockouts table without is_account comes from the first build, whose rows are
 *   all unscoped (one lock per typed name, whatever the name looks like): every row becomes the
 *   public scope's row ("public:" + name, case-sensitively), and rows of usernames that exist in
 *   the users table are flagged. A table that already has is_account is left alone;
 * - auth_security_events gains important (earlier rows count as ordinary events) and the
 *   collapse_key / repeats columns that fold repeated sign-ins into one row.
 * Safe to run on every start: it only touches what is missing.
 */
function migrateSecurityTables(database: Database.Database) {
  database.transaction(() => {
    if (!columnsOf(database, 'auth_login_lockouts').includes('is_account')) {
      database.exec('ALTER TABLE auth_login_lockouts ADD COLUMN is_account INTEGER NOT NULL DEFAULT 0');
      database.exec("UPDATE auth_login_lockouts SET account_key = 'public:' || account_key");
      const hasUsers = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
      if (hasUsers) {
        // substr(…, 8) is the name after "public:"; = compares case-sensitively, like the users table.
        database.exec('UPDATE auth_login_lockouts SET is_account = 1 WHERE substr(account_key, 8) IN (SELECT username FROM users)');
      }
    }
    const eventColumns = columnsOf(database, 'auth_security_events');
    if (!eventColumns.includes('important')) {
      database.exec('ALTER TABLE auth_security_events ADD COLUMN important INTEGER NOT NULL DEFAULT 0');
    }
    if (!eventColumns.includes('collapse_key')) {
      database.exec('ALTER TABLE auth_security_events ADD COLUMN collapse_key TEXT');
    }
    if (!eventColumns.includes('repeats')) {
      database.exec('ALTER TABLE auth_security_events ADD COLUMN repeats INTEGER NOT NULL DEFAULT 1');
    }
  })();
}

/**
 * Creates the store on a better-sqlite3 connection, creating its tables when missing and
 * migrating tables created by earlier builds (migrateSecurityTables).
 * Used by getAuthSecurityStore (production) and by the auth tests on an in-memory database.
 */
export function createAuthSecurityStore(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS auth_login_lockouts (
      account_key TEXT PRIMARY KEY,
      failures INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      is_account INTEGER NOT NULL DEFAULT 0
    );
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
      detail TEXT,
      important INTEGER NOT NULL DEFAULT 0,
      collapse_key TEXT,
      repeats INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS auth_step_up_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_step_up_failures_user ON auth_step_up_failures(username, at);
    CREATE TABLE IF NOT EXISTS auth_session_versions (
      user_id INTEGER PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 0
    );
  `);
  migrateSecurityTables(database);
  // Indexes last: they name columns that older databases only have after the migration.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_auth_login_lockouts_unknown ON auth_login_lockouts(is_account, updated_at);
    CREATE INDEX IF NOT EXISTS idx_auth_security_events_class ON auth_security_events(important, id);
    CREATE INDEX IF NOT EXISTS idx_auth_security_events_collapse ON auth_security_events(collapse_key, id);
  `);

  const statements = {
    lockoutGet: database.prepare('SELECT * FROM auth_login_lockouts WHERE account_key = ?'),
    lockoutUpsert: database.prepare(`
      INSERT INTO auth_login_lockouts (account_key, failures, level, locked_until, updated_at, is_account)
      VALUES (@account_key, @failures, @level, @locked_until, @updated_at, @is_account)
      ON CONFLICT(account_key) DO UPDATE SET
        failures = excluded.failures, level = excluded.level, locked_until = excluded.locked_until,
        updated_at = excluded.updated_at, is_account = excluded.is_account
    `),
    lockoutDelete: database.prepare('DELETE FROM auth_login_lockouts WHERE account_key = ?'),
    lockoutDeleteFamily: database.prepare("DELETE FROM auth_login_lockouts WHERE account_key = ? OR account_key LIKE ? ESCAPE '\\'"),
    lockoutDeleteAll: database.prepare('DELETE FROM auth_login_lockouts'),
    lockoutCountUnknown: database.prepare('SELECT COUNT(*) AS count FROM auth_login_lockouts WHERE is_account = 0'),
    // Least recently relevant first: a row matters until both its last attempt and its lock are past.
    lockoutOldestUnknown: database.prepare(`
      SELECT account_key FROM auth_login_lockouts WHERE is_account = 0
      ORDER BY MAX(updated_at, locked_until) ASC LIMIT ?
    `),
    passkeysForUser: database.prepare('SELECT * FROM auth_passkeys WHERE user_id = ? ORDER BY rp_id, created_at'),
    passkeyByCredential: database.prepare('SELECT * FROM auth_passkeys WHERE credential_id = ?'),
    passkeyById: database.prepare('SELECT * FROM auth_passkeys WHERE id = ? AND user_id = ?'),
    passkeyInsert: database.prepare(`
      INSERT INTO auth_passkeys (id, user_id, rp_id, credential_id, public_key, counter, transports, label, created_at, last_used_at)
      VALUES (@id, @user_id, @rp_id, @credential_id, @public_key, @counter, @transports, @label, @created_at, @last_used_at)
    `),
    passkeyUsage: database.prepare('UPDATE auth_passkeys SET counter = ?, last_used_at = ? WHERE id = ?'),
    passkeyDelete: database.prepare('DELETE FROM auth_passkeys WHERE id = ? AND user_id = ?'),
    eventInsert: database.prepare(`
      INSERT INTO auth_security_events (at, type, door, client, detail, important, collapse_key, repeats)
      VALUES (@at, @type, @door, @client, @detail, @important, @collapse_key, @repeats)
    `),
    eventLastOfKey: database.prepare('SELECT id, repeats FROM auth_security_events WHERE collapse_key = ? AND at >= ? ORDER BY id DESC LIMIT 1'),
    eventDelete: database.prepare('DELETE FROM auth_security_events WHERE id = ?'),
    stepUpInsert: database.prepare('INSERT INTO auth_step_up_failures (username, at) VALUES (?, ?)'),
    stepUpDelete: database.prepare('DELETE FROM auth_step_up_failures WHERE id = ?'),
    stepUpPrune: database.prepare('DELETE FROM auth_step_up_failures WHERE at < ?'),
    stepUpCount: database.prepare('SELECT COUNT(*) AS count, MIN(at) AS oldest FROM auth_step_up_failures WHERE username = ? AND at >= ?'),
    stepUpClearUser: database.prepare('DELETE FROM auth_step_up_failures WHERE username = ?'),
    // Keeps the newest MAX_EVENTS_PER_CLASS rows of one class; a class with fewer rows is untouched.
    eventTrim: database.prepare(`
      DELETE FROM auth_security_events WHERE important = @important AND id < (
        SELECT id FROM auth_security_events WHERE important = @important ORDER BY id DESC LIMIT 1 OFFSET @keep
      )
    `),
    eventsRecent: database.prepare('SELECT * FROM auth_security_events ORDER BY id DESC LIMIT ?'),
    eventsRecentOfClass: database.prepare('SELECT * FROM auth_security_events WHERE important = ? ORDER BY id DESC LIMIT ?'),
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
      /** Removes `key` and every `key#<subject>` row; returns how many were removed. */
      removeFamily: (key: string) => statements.lockoutDeleteFamily.run(key, `${key.replace(/[\\%_]/g, (character) => `\\${character}`)}#%`).changes,
      removeAll: () => statements.lockoutDeleteAll.run().changes,
      /** Rows of usernames that are not accounts; only these count against the cap. */
      countUnknown: () => (statements.lockoutCountUnknown.get() as { count: number }).count,
      /** Keys of the least recently relevant unknown-username rows, oldest first, for making room. */
      oldestUnknownKeys: (limit: number) => (statements.lockoutOldestUnknown.all(limit) as { account_key: string }[])
        .map((row) => row.account_key),
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
      /**
       * Adds an event. With a collapse key, a row with the same key at or after `collapseSince`
       * is replaced by this one carrying its count plus one, so one session (or one device's
       * automatic sign-ins) takes a single row however often it repeats.
       */
      append: (event: Omit<SecurityEventRow, 'id' | 'repeats'>, collapseSince?: string) => {
        database.transaction(() => {
          const previous = event.collapse_key && collapseSince
            ? statements.eventLastOfKey.get(event.collapse_key, collapseSince) as { id: number; repeats: number } | undefined
            : undefined;
          if (previous) statements.eventDelete.run(previous.id);
          statements.eventInsert.run({ ...event, repeats: (previous?.repeats ?? 0) + 1 });
          statements.eventTrim.run({ important: event.important, keep: MAX_EVENTS_PER_CLASS - 1 });
        })();
      },
      /** Newest first, both classes mixed. */
      recent: (limit: number) => statements.eventsRecent.all(limit) as SecurityEventRow[],
      /** Newest events of one retention class first (see SecurityEventRow.important). */
      recentOfClass: (eventClass: number, limit: number) => statements.eventsRecentOfClass.all(eventClass, limit) as SecurityEventRow[],
    },
    stepUpFailures: {
      /** Counts one step-up attempt before the comparison; returns its id so a success can take it back. */
      add: (username: string, at: number) => Number(statements.stepUpInsert.run(username, at).lastInsertRowid),
      remove: (id: number) => { statements.stepUpDelete.run(id); },
      /** Attempts of a user at or after `since`, and the oldest of them (null when none). */
      countSince: (username: string, since: number) => {
        statements.stepUpPrune.run(since);
        const row = statements.stepUpCount.get(username, since) as { count: number; oldest: number | null };
        return { count: row.count, oldest: row.oldest };
      },
      clearUser: (username: string) => statements.stepUpClearUser.run(username).changes,
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
