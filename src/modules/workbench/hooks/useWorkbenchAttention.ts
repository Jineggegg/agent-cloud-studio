import { useCallback, useEffect, useRef, useState } from 'react';

import { useBusySessionIdSet } from '@/shared/context/SessionProtectionContext';
import { useWebSocket } from '@/shared/context/WebSocketContext';

// Remembered on this device so a reload keeps the dots; capped so ids of long-gone sessions do not pile up.
const STORAGE_KEY = 'acs-workbench-attention-v1';
const MAX_REMEMBERED = 200;
// Joins the open session's ids into one comparable value; session ids never contain a NUL.
const SEPARATOR = '\u0000';

function readRemembered(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
  } catch {
    return [];
  }
}

function remember(sessionIds: ReadonlySet<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...sessionIds]));
  } catch {
    // Storage unavailable: the dots last this visit.
  }
}

/**
 * Used by the workbench shell for the history's red dots: the sessions that need the owner because a run ended
 * (busy → idle in useBusySessionIdSet) or a `permission_request` frame arrived while another session was open.
 * `viewedSessionIds` are the open session's ids (every stretch of a handed-over conversation): they never get a dot,
 * and opening a session clears its dot. The set is global (every project) and survives a reload.
 */
export function useWorkbenchAttention(viewedSessionIds: readonly string[]): ReadonlySet<string> {
  const busy = useBusySessionIdSet();
  const { subscribe } = useWebSocket();
  // Sessions waiting for the owner, oldest first; mirrored to localStorage.
  const [attention, setAttention] = useState<ReadonlySet<string>>(() => new Set(readRemembered()));
  const viewedKey = viewedSessionIds.join(SEPARATOR);
  // The open session's ids for the websocket handler and the busy diff, which run after the render that set them.
  const viewed = useRef(viewedKey);
  useEffect(() => { viewed.current = viewedKey; }, [viewedKey]);

  // Opening a session clears its dot; adjusted during render, so the open row never shows one.
  const openIds = viewedKey ? viewedKey.split(SEPARATOR) : [];
  if (openIds.some(sessionId => attention.has(sessionId))) {
    setAttention(new Set([...attention].filter(sessionId => !openIds.includes(sessionId))));
  }

  const mark = useCallback((sessionId: string) => {
    if (viewed.current.split(SEPARATOR).includes(sessionId)) return;
    setAttention(previous => (previous.has(sessionId) ? previous : new Set([...previous, sessionId].slice(-MAX_REMEMBERED))));
  }, []);

  // A run that ended (it left the busy set) wants a look.
  const previousBusy = useRef(busy);
  useEffect(() => {
    const before = previousBusy.current;
    previousBusy.current = busy;
    for (const sessionId of before) if (!busy.has(sessionId)) mark(sessionId);
  }, [busy, mark]);

  // A tool waiting for approval (or a question) wants an answer.
  useEffect(() => subscribe(event => {
    if (event.kind === 'permission_request' && typeof event.sessionId === 'string' && event.sessionId) mark(event.sessionId);
  }), [subscribe, mark]);

  useEffect(() => { remember(attention); }, [attention]);

  return attention;
}
