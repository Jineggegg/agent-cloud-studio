import { useEffect } from 'react';

import { useWebSocket } from '@/shared/context/WebSocketContext';

// Joins the open conversation's ids into one comparable value; session ids never contain a NUL.
const SEPARATOR = '\u0000';

/**
 * Used by the workbench shell to tell the server which conversation this page shows (every stretch of a
 * handed-over one) and whether the page is visible (`workbench.presence`). The server sends no notification for a
 * session on screen and counts a finished run as seen once its session is. Reported again after a reconnect, on
 * every visibility change, and cleared when the page leaves the workbench.
 */
export function useWorkbenchPresence(viewedSessionIds: readonly string[]): void {
  const { sendMessage, isConnected } = useWebSocket();
  const viewedKey = viewedSessionIds.join(SEPARATOR);

  useEffect(() => {
    if (isConnected === false || typeof sendMessage !== 'function') return undefined;
    const sessionIds = viewedKey ? viewedKey.split(SEPARATOR) : [];
    const report = () => sendMessage({ type: 'workbench.presence', sessionIds, visible: document.visibilityState === 'visible' });
    // A page being put away (iOS app switch, tab close) is hidden before the socket notices.
    const hide = () => sendMessage({ type: 'workbench.presence', sessionIds, visible: false });
    report();
    document.addEventListener('visibilitychange', report);
    window.addEventListener('pagehide', hide);
    return () => {
      document.removeEventListener('visibilitychange', report);
      window.removeEventListener('pagehide', hide);
      sendMessage({ type: 'workbench.presence', sessionIds: [], visible: false });
    };
  }, [viewedKey, isConnected, sendMessage]);
}
