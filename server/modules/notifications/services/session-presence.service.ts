/**
 * Which sessions the owner has open and on screen right now, as each signed-in chat socket last reported
 * (`workbench.presence` frames). A socket counts only while its page is visible; closing the socket forgets it.
 *
 * Notifications are never sent for a session in view (the owner is already looking at it), and the Studio
 * workbench activity clears a finished run's "not seen yet" mark once its session is viewed.
 */

type SessionPresence = {
  userKey: string | null;
  sessionIds: ReadonlySet<string>;
  visible: boolean;
};

// Longest list one socket may report: a handed-over conversation is a short chain of sessions.
const MAX_REPORTED_SESSIONS = 32;
const MAX_SESSION_ID_LENGTH = 200;

// Keyed by the socket object itself, so a closed socket's entry goes with forgetSessionPresence.
const presenceByConnection = new Map<object, SessionPresence>();
const viewedListeners = new Set<(sessionIds: string[]) => void>();

function userKeyOf(userId: string | number | null | undefined): string | null {
  return userId === undefined || userId === null ? null : String(userId);
}

/** Session ids from an untrusted frame: strings only, trimmed, bounded, without duplicates. */
function cleanSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id && id.length <= MAX_SESSION_ID_LENGTH) ids.add(id);
    if (ids.size >= MAX_REPORTED_SESSIONS) break;
  }
  return [...ids];
}

/**
 * Records what one socket's page shows: the open conversation's session ids (every stretch of a handed-over
 * one) and whether the page is visible. Observers hear about the sessions that are now in view.
 * Used by the websocket module's chat gateway for `workbench.presence` frames.
 */
export function reportSessionPresence(
  connection: object,
  input: { userId: string | number | null; sessionIds: unknown; visible: unknown },
): void {
  const sessionIds = cleanSessionIds(input.sessionIds);
  const visible = input.visible === true;
  presenceByConnection.set(connection, { userKey: userKeyOf(input.userId), sessionIds: new Set(sessionIds), visible });
  if (!visible || sessionIds.length === 0) return;
  for (const listener of viewedListeners) {
    try {
      listener(sessionIds);
    } catch (error) {
      console.error('[SessionPresence] Observer failed', error instanceof Error ? error.message : error);
    }
  }
}

/** Drops a socket's report. Used by the websocket module's chat gateway when the socket closes. */
export function forgetSessionPresence(connection: object): void {
  presenceByConnection.delete(connection);
}

/**
 * Whether some visible page of the user (any user when `userId` is omitted) shows the session. Used by the
 * notification orchestrator to skip notifications for the session the owner is looking at, and by the Studio
 * workbench activity to decide whether a finished run was seen.
 */
export function isSessionInView(sessionId: string, userId?: string | number | null): boolean {
  if (!sessionId) return false;
  const userKey = userId === undefined ? undefined : userKeyOf(userId);
  for (const presence of presenceByConnection.values()) {
    if (!presence.visible || !presence.sessionIds.has(sessionId)) continue;
    if (userKey === undefined || userKey === null || presence.userKey === null || presence.userKey === userKey) return true;
  }
  return false;
}

/**
 * Observes sessions coming into view (reported open on a visible page). Used by the Studio workbench activity
 * to clear a finished run's "not seen yet" mark. Returns the unsubscribe function.
 */
export function onSessionsViewed(listener: (sessionIds: string[]) => void): () => void {
  viewedListeners.add(listener);
  return () => { viewedListeners.delete(listener); };
}
