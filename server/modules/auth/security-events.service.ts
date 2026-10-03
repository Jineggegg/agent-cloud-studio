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
  | 'tailscale-signin'
  | 'handoff-signin'
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
  /**
   * For successful sign-ins: what makes repeats the same (the session id, or the device for
   * Tailscale sign-ins). Repeats from the same client within COLLAPSE_WINDOW_MS fold into one row
   * with a count, so one session cannot push out everybody else's sign-ins.
   */
  collapseOn?: string;
};

// Repeated sign-ins of one session from one client within this window take a single row.
const COLLAPSE_WINDOW_MS = 60 * 60_000;

// Retention classes (auth-security.store): each keeps its own newest 500, so no amount of failed
// attempts can push out an important change or the record of who actually got in.
const NOISE = 0;
const IMPORTANT = 1;
const SIGN_IN = 2;
const EVENT_CLASSES: Partial<Record<SecurityEventType, number>> = {
  'account-locked': IMPORTANT,
  'lockout-cleared': IMPORTANT,
  'passkey-added': IMPORTANT,
  'passkey-removed': IMPORTANT,
  'sessions-revoked': IMPORTANT,
  'api-keys-revoked': IMPORTANT,
  'login-succeeded': SIGN_IN,
  'passkey-signin': SIGN_IN,
  'tailscale-signin': SIGN_IN,
  'handoff-signin': SIGN_IN,
};

// Control characters never reach the log, whatever a caller passes in.
function printable(text: string): string {
  return text.replace(/[\p{Cc}]/gu, '?').slice(0, 200);
}

function view(row: ReturnType<EventStore['recent']>[number]) {
  return { id: row.id, at: row.at, type: row.type, door: row.door, client: row.client, detail: row.detail, repeats: row.repeats ?? 1 };
}

/**
 * The security event log behind Settings → 安全: sign-ins, locks, passkey changes and "sign out
 * everywhere". The store keeps the newest 500 of each class: important changes (locks, lock lifts,
 * passkey changes, revocations), successful sign-ins (password, passkey, Tailscale, handoff), and
 * failed attempts.
 * Used by auth.module, which passes `record` to auth.service and the whole log to
 * account-security.service (which also reads it back for Settings).
 */
export function createSecurityEventLog(dependencies: { store: EventStore; now?: () => number }) {
  const now = dependencies.now ?? Date.now;
  return {
    record(event: SecurityEventInput): void {
      try {
        const at = now();
        const door = event.client?.door ?? 'direct';
        const client = event.client ? maskClientAddress(event.client.address) : 'unknown';
        const collapse = event.collapseOn !== undefined;
        dependencies.store.append({
          at: new Date(at).toISOString(),
          type: event.type,
          door,
          client,
          detail: event.detail === undefined ? null : printable(event.detail),
          important: EVENT_CLASSES[event.type] ?? NOISE,
          // The key holds the masked client only, like the row itself.
          collapse_key: collapse ? `${event.type}|${event.collapseOn?.slice(0, 80)}|${door}|${client}` : null,
        }, collapse ? new Date(at - COLLAPSE_WINDOW_MS).toISOString() : undefined);
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
      return dependencies.store.recentOfClass(IMPORTANT, Math.max(1, Math.min(limit, 100))).map(view);
    },

    /** Newest successful sign-ins first (password, passkey, Tailscale, handoff). */
    recentSignIns(limit = 20) {
      return dependencies.store.recentOfClass(SIGN_IN, Math.max(1, Math.min(limit, 100))).map(view);
    },
  };
}
