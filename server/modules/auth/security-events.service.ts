import type { StudioRequestClient } from '@/shared/types.js';

import type { createAuthSecurityStore } from './auth-security.store.js';
import { maskClientAddress } from './request-client.service.js';

type EventStore = ReturnType<typeof createAuthSecurityStore>['events'];

type SecurityEventType =
  | 'login-failed'
  | 'login-succeeded'
  | 'account-locked'
  | 'lockout-cleared'
  | 'passkey-signin'
  | 'passkey-signin-failed'
  | 'passkey-added'
  | 'passkey-removed'
  | 'sessions-revoked'
  | 'api-keys-revoked'
  | 'step-up-failed';

type SecurityEventInput = {
  type: SecurityEventType;
  /** Who caused it; stored as the door plus a masked address, never the full address. */
  client?: StudioRequestClient;
  /** Short, already-safe text such as "wrong-password" or a passkey's domain; capped at 200 chars. */
  detail?: string;
};

// Kept in their own retention class, so no amount of failed sign-ins can push them out of the log.
const IMPORTANT_EVENTS = new Set<SecurityEventType>([
  'account-locked',
  'lockout-cleared',
  'passkey-added',
  'passkey-removed',
  'sessions-revoked',
  'api-keys-revoked',
]);

// Control characters never reach the log, whatever a caller passes in.
function printable(text: string): string {
  return text.replace(/[\p{Cc}]/gu, '?').slice(0, 200);
}

function view(row: ReturnType<EventStore['recent']>[number]) {
  return { id: row.id, at: row.at, type: row.type, door: row.door, client: row.client, detail: row.detail };
}

/**
 * The security event log behind Settings → 安全: sign-ins, locks, passkey changes and "sign out
 * everywhere". The store keeps the newest 500 important events (locks, lock lifts, passkey changes,
 * revocations) and, separately, the newest 500 others.
 * Used by auth.module, which passes `record` to auth.service and the whole log to
 * account-security.service (which also reads it back for Settings).
 */
export function createSecurityEventLog(dependencies: { store: EventStore; now?: () => number }) {
  const now = dependencies.now ?? Date.now;
  return {
    record(event: SecurityEventInput): void {
      try {
        dependencies.store.append({
          at: new Date(now()).toISOString(),
          type: event.type,
          door: event.client?.door ?? 'direct',
          client: event.client ? maskClientAddress(event.client.address) : 'unknown',
          detail: event.detail === undefined ? null : printable(event.detail),
          important: IMPORTANT_EVENTS.has(event.type) ? 1 : 0,
        });
      } catch (error) {
        // Logging must never turn a sign-in into an error.
        console.warn('[auth] Could not record a security event:', error instanceof Error ? error.message : String(error));
      }
    },

    /** Newest first, both classes mixed, at most `limit` (capped at 100) events. */
    recent(limit = 50) {
      return dependencies.store.recent(Math.max(1, Math.min(limit, 100))).map(view);
    },

    /** Newest important events first (locks, lock lifts, passkey changes, revocations). */
    recentImportant(limit = 20) {
      return dependencies.store.recentImportant(Math.max(1, Math.min(limit, 100))).map(view);
    },
  };
}
