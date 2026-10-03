import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

// Longest path a notification may open; anything longer is not one of the app's own pages.
const MAX_NOTIFICATION_PATH_LENGTH = 2048;
// Only used to parse a path: a value that resolves to any other origin was not a same-origin path.
const PATH_PARSE_ORIGIN = 'https://studio.invalid';

// What public/sw.js posts when a notification is tapped; older workers sent `urlPath` and a session id only.
type NotificationNavigateMessage = { type?: unknown; url?: unknown; urlPath?: unknown; sessionId?: unknown };

/**
 * The app page a tapped notification names, as a router path: its `url` when that is a same-origin path, else the
 * old `/session/:id` address of a legacy message, else the home screen. The service worker and the server apply the
 * same rule; checking again here keeps a stale worker from steering the router anywhere unexpected.
 */
function notificationNavigationPath(message: NotificationNavigateMessage): string {
  const legacySession = typeof message.sessionId === 'string' && message.sessionId ? `/session/${encodeURIComponent(message.sessionId)}` : '/';
  const value = message.url ?? message.urlPath ?? legacySession;
  if (typeof value !== 'string') return '/';
  const candidate = value.trim();
  // eslint-disable-next-line no-control-regex
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.length > MAX_NOTIFICATION_PATH_LENGTH || /[\u0000-\u001f\u007f\\]/.test(candidate)) {
    return '/';
  }
  try {
    const parsed = new URL(candidate, PATH_PARSE_ORIGIN);
    return parsed.origin === PATH_PARSE_ORIGIN ? `${parsed.pathname}${parsed.search}${parsed.hash}` : '/';
  } catch {
    return '/';
  }
}

/**
 * Used by App inside the router: a notification tapped while Studio is open (public/sw.js focuses this window and
 * posts `notification:navigate`) opens its page here — an automation's project, an agent's session — through the
 * router, so the path prefix and the mounted screens are kept. The only handler of that message in the app.
 */
export function useNotificationNavigation() {
  const navigate = useNavigate();
  useEffect(() => {
    const container = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : null;
    if (!container) return undefined;
    const onMessage = (event: MessageEvent) => {
      const message = event.data as NotificationNavigateMessage | null;
      if (!message || message.type !== 'notification:navigate') return;
      navigate(notificationNavigationPath(message));
    };
    container.addEventListener('message', onMessage);
    return () => container.removeEventListener('message', onMessage);
  }, [navigate]);
}
