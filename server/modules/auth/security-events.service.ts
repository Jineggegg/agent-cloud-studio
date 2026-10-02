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
  | 'step-up-failed';

type SecurityEventInput = {
  type: SecurityEventType;
  /** Who caused it; stored as the door plus a masked address, never the full address. */
  client?: StudioRequestClient;
  /** Short, already-safe text such as "wrong-password" or a passkey's domain; capped at 200 chars. */
  detail?: string;
};

// Control characters never reach the log, whatever a caller passes in.
function printable(text: string): string {
  return text.replace(/[\p{Cc}]/gu, '?').slice(0, 200);
}

/**
 * The security event log behind Settings → 安全: failed and successful sign-ins, locks, passkey
 * changes and "sign out everywhere", bounded by the store to the newest 500 events.
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
        });
      } catch (error) {
        // Logging must never turn a sign-in into an error.
        console.warn('[auth] Could not record a security event:', error instanceof Error ? error.message : String(error));
      }
    },

    /** Newest first, at most `limit` (capped at 100) events. */
    recent(limit = 50) {
      return dependencies.store.recent(Math.max(1, Math.min(limit, 100))).map((row) => ({
        id: row.id,
        at: row.at,
        type: row.type,
        door: row.door,
        client: row.client,
        detail: row.detail,
      }));
    },
  };
}
