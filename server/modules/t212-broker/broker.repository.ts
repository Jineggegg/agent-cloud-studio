import type Database from 'better-sqlite3';

import type { StudioT212Environment } from '@/shared/types.js';

type ChallengeKind = 'order' | 'register' | 'remove';
type PasskeyRow = {
  id: string; rp_id: string; credential_id: string; public_key: Buffer; counter: number;
  transports: string; label: string | null; created_at: string; last_used_at: string | null;
};
type ChallengeRow = { id: string; kind: ChallengeKind; challenge: string; rp_id: string; origin: string; payload: string; expires_at: number };
type AuditStatus = 'placed' | 'rejected' | 'unknown' | 'refused';
type AuditEntry = {
  previewId: string; env: StudioT212Environment; ticker: string; side: string; type: string; quantity: number;
  limitPrice: number | null; estimatedValue: number; currency: string; method: string; rpId: string;
  passkeyId: string | null; status: AuditStatus; brokerOrderId?: string | null; brokerStatus?: string | null; error?: string | null;
};

/**
 * Used by the broker service and CLI: every table of the broker's own SQLite database (passkeys, hashed
 * enrollment codes, pending WebAuthn challenges, failed-attempt counters and the order audit). The database
 * lives in the broker's 0700 state directory, so Studio's OS user can neither read nor change it. Taking a
 * challenge or an enrollment code deletes it in the same statement, which is what makes both single use.
 */
export function createBrokerRepository(db: Database.Database) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY, rp_id TEXT NOT NULL, credential_id TEXT NOT NULL UNIQUE, public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0, transports TEXT NOT NULL DEFAULT '[]', label TEXT,
      created_at TEXT NOT NULL, last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS passkeys_rp ON passkeys (rp_id);
    CREATE TABLE IF NOT EXISTS enrollment_codes (code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS challenges (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, challenge TEXT NOT NULL UNIQUE, rp_id TEXT NOT NULL,
      origin TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS failures (bucket TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS failures_bucket_time ON failures (bucket, at);
    CREATE TABLE IF NOT EXISTS order_audit (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT, preview_id TEXT NOT NULL, env TEXT NOT NULL, ticker TEXT NOT NULL,
      side TEXT NOT NULL, type TEXT NOT NULL, quantity REAL NOT NULL, limit_price REAL, estimated_value REAL NOT NULL,
      currency TEXT NOT NULL, method TEXT NOT NULL, rp_id TEXT NOT NULL, passkey_id TEXT, status TEXT NOT NULL,
      broker_order_id TEXT, broker_status TEXT, error TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS order_audit_time ON order_audit (created_at);
  `);

  return {
    passkeys(rpId?: string) {
      return (rpId
        ? db.prepare('SELECT * FROM passkeys WHERE rp_id = ? ORDER BY created_at').all(rpId)
        : db.prepare('SELECT * FROM passkeys ORDER BY rp_id, created_at').all()) as PasskeyRow[];
    },
    passkey(id: string) {
      return db.prepare('SELECT * FROM passkeys WHERE id = ?').get(id) as PasskeyRow | undefined;
    },
    credentialExists(credentialId: string) {
      return Boolean(db.prepare('SELECT 1 FROM passkeys WHERE credential_id = ?').get(credentialId));
    },
    insertPasskey(row: PasskeyRow) {
      db.prepare(`INSERT INTO passkeys (id, rp_id, credential_id, public_key, counter, transports, label, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.rp_id, row.credential_id, row.public_key, row.counter, row.transports, row.label, row.created_at, row.last_used_at);
    },
    // Only moves the counter forwards; the service has already refused a counter that did not increase.
    recordPasskeyUse(id: string, counter: number, at: string) {
      db.prepare('UPDATE passkeys SET counter = MAX(counter, ?), last_used_at = ? WHERE id = ?').run(counter, at, id);
    },
    deletePasskey(id: string) {
      return db.prepare('DELETE FROM passkeys WHERE id = ?').run(id).changes > 0;
    },

    insertEnrollmentCode(codeHash: string, expiresAt: number, createdAt: string) {
      db.prepare('INSERT INTO enrollment_codes (code_hash, expires_at, created_at) VALUES (?, ?, ?)').run(codeHash, expiresAt, createdAt);
    },
    // Whether an unexpired code with this hash exists, without using it up (registration options).
    enrollmentCodeValid(codeHash: string, now: number) {
      return Boolean(db.prepare('SELECT 1 FROM enrollment_codes WHERE code_hash = ? AND expires_at > ?').get(codeHash, now));
    },
    // Deletes the code whether or not it is still valid, and reports whether it was usable: single use either way.
    takeEnrollmentCode(codeHash: string, now: number) {
      const row = db.prepare('DELETE FROM enrollment_codes WHERE code_hash = ? RETURNING expires_at').get(codeHash) as { expires_at: number } | undefined;
      return Boolean(row && row.expires_at > now);
    },
    pruneEnrollmentCodes(now: number) {
      db.prepare('DELETE FROM enrollment_codes WHERE expires_at <= ?').run(now);
    },

    insertChallenge(row: ChallengeRow) {
      db.prepare('INSERT INTO challenges (id, kind, challenge, rp_id, origin, payload, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(row.id, row.kind, row.challenge, row.rp_id, row.origin, row.payload, row.expires_at);
    },
    // Atomic take: the row is gone after the first attempt, so a challenge can never be answered twice.
    takeChallengeById(id: string, kind: ChallengeKind) {
      return db.prepare('DELETE FROM challenges WHERE id = ? AND kind = ? RETURNING *').get(id, kind) as ChallengeRow | undefined;
    },
    takeChallengeByValue(challenge: string, kind: ChallengeKind) {
      return db.prepare('DELETE FROM challenges WHERE challenge = ? AND kind = ? RETURNING *').get(challenge, kind) as ChallengeRow | undefined;
    },
    pruneChallenges(now: number) {
      db.prepare('DELETE FROM challenges WHERE expires_at <= ?').run(now);
    },
    activeChallenges(now: number) {
      return (db.prepare('SELECT COUNT(*) AS count FROM challenges WHERE expires_at > ?').get(now) as { count: number }).count;
    },

    recordFailure(bucket: string, at: number) {
      db.prepare('INSERT INTO failures (bucket, at) VALUES (?, ?)').run(bucket, at);
    },
    failuresSince(bucket: string, since: number) {
      return (db.prepare('SELECT COUNT(*) AS count FROM failures WHERE bucket = ? AND at > ?').get(bucket, since) as { count: number }).count;
    },
    pruneFailures(before: number) {
      db.prepare('DELETE FROM failures WHERE at <= ?').run(before);
    },

    recordAudit(entry: AuditEntry, at: number) {
      db.prepare(`INSERT INTO order_audit (preview_id, env, ticker, side, type, quantity, limit_price, estimated_value, currency, method,
        rp_id, passkey_id, status, broker_order_id, broker_status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        entry.previewId, entry.env, entry.ticker, entry.side, entry.type, entry.quantity, entry.limitPrice, entry.estimatedValue,
        entry.currency, entry.method, entry.rpId, entry.passkeyId, entry.status, entry.brokerOrderId ?? null,
        entry.brokerStatus ?? null, entry.error?.slice(0, 300) ?? null, at,
      );
    },
    // Orders that reached Trading 212 (placed, or possibly placed) since a time, for the hourly limit.
    submittedSince(since: number) {
      return (db.prepare("SELECT COUNT(*) AS count FROM order_audit WHERE status IN ('placed', 'unknown') AND created_at > ?").get(since) as { count: number }).count;
    },
    // Latest identical order whose outcome was unknown, since a time.
    unknownSince(order: { env: string; ticker: string; side: string; quantity: number }, since: number) {
      const row = db.prepare(`SELECT created_at FROM order_audit WHERE env = ? AND ticker = ? AND side = ? AND quantity = ?
        AND status = 'unknown' AND created_at > ? ORDER BY row_id DESC LIMIT 1`).get(order.env, order.ticker, order.side, order.quantity, since) as { created_at: number } | undefined;
      return row?.created_at ?? null;
    },
    audit(limit: number) {
      return db.prepare('SELECT * FROM order_audit ORDER BY row_id DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    },
  };
}
