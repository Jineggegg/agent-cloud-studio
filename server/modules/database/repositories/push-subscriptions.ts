/**
 * Push subscriptions repository.
 *
 * Persists browser push subscription endpoints and keys per user.
 */

import { getConnection } from '@/modules/database/connection.js';

// Endpoints removed by "退出所有设备", remembered per user for this long so the user's own
// devices can re-register them silently; anything else counts as a new subscription.
const TOMBSTONE_LIFETIME_MS = 30 * 24 * 60 * 60_000;

// Created on first use: only this repository reads or writes it.
function ensureTombstones(db: ReturnType<typeof getConnection>) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscription_tombstones (
      user_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL,
      removed_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, endpoint)
    )
  `);
}

type PushSubscriptionLookupRow = {
  endpoint: string;
  keys_p256dh: string;
  keys_auth: string;
};

export const pushSubscriptionsDb = {
  /** Upserts a push subscription endpoint for a user. */
  createPushSubscription(
    userId: number,
    endpoint: string,
    keysP256dh: string,
    keysAuth: string
  ): void {
    const db = getConnection();
    db.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id,
         keys_p256dh = excluded.keys_p256dh,
         keys_auth = excluded.keys_auth`
    ).run(userId, endpoint, keysP256dh, keysAuth);
  },

  /** Returns all subscriptions for a user. */
  getPushSubscriptions(userId: number): PushSubscriptionLookupRow[] {
    const db = getConnection();
    return db
      .prepare(
        'SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions WHERE user_id = ?'
      )
      .all(userId) as PushSubscriptionLookupRow[];
  },

  /** Deletes one subscription by endpoint. */
  deletePushSubscription(endpoint: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  },

  /**
   * Deletes all subscriptions for a user and returns how many there were. Used by the server
   * entrypoint when "退出所有设备" also stops Web Push to every device.
   */
  deletePushSubscriptionsForUser(userId: number): number {
    const db = getConnection();
    ensureTombstones(db);
    return db.transaction(() => {
      // Remembered for a while, so the same devices may re-register them without a fuss.
      db.prepare(`
        INSERT INTO push_subscription_tombstones (user_id, endpoint, removed_at)
        SELECT user_id, endpoint, ? FROM push_subscriptions WHERE user_id = ?
        ON CONFLICT(user_id, endpoint) DO UPDATE SET removed_at = excluded.removed_at
      `).run(Date.now(), userId);
      return db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId).changes;
    })();
  },

  /**
   * Whether an endpoint is already this user's: subscribed now, or removed by "退出所有设备"
   * within the last 30 days. Used by the settings module to tell a device re-registering its own
   * subscription from a genuinely new endpoint (which is recorded as a security event).
   */
  isKnownEndpoint(userId: number, endpoint: string): boolean {
    const db = getConnection();
    ensureTombstones(db);
    db.prepare('DELETE FROM push_subscription_tombstones WHERE removed_at < ?').run(Date.now() - TOMBSTONE_LIFETIME_MS);
    return Boolean(
      db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').get(userId, endpoint)
      ?? db.prepare('SELECT 1 FROM push_subscription_tombstones WHERE user_id = ? AND endpoint = ?').get(userId, endpoint),
    );
  },

  // Legacy aliases used by existing services/routes
  saveSubscription(
    userId: number,
    endpoint: string,
    keysP256dh: string,
    keysAuth: string
  ): void {
    pushSubscriptionsDb.createPushSubscription(
      userId,
      endpoint,
      keysP256dh,
      keysAuth
    );
  },
  getSubscriptions(userId: number): PushSubscriptionLookupRow[] {
    return pushSubscriptionsDb.getPushSubscriptions(userId);
  },
  removeSubscription(endpoint: string): void {
    pushSubscriptionsDb.deletePushSubscription(endpoint);
  },
  removeAllForUser(userId: number): void {
    pushSubscriptionsDb.deletePushSubscriptionsForUser(userId);
  },
};

