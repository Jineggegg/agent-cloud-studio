import type { IncomingMessage } from 'node:http';

import type { VerifyClientCallbackSync } from 'ws';

import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type WebSocketAuthDependencies = {
  isPlatform: boolean;
  /**
   * Verifies the connection token. The upgrade request is passed along so the auth module can
   * check which front door a Tailscale-issued token arrived through.
   */
  authenticateWebSocket: (token: string | null, request: IncomingMessage) => {
    id?: string | number;
    userId?: string | number;
    username?: string;
    [key: string]: unknown;
  } | null;
  /**
   * Optional edge check that runs before the token is looked at: the auth module's Cloudflare
   * Access gate, which refuses upgrades through the public tunnel door without a valid assertion.
   */
  admitEdgeRequest?: (request: IncomingMessage) => Promise<boolean>;
};

type WebSocketVerifyInfo = Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0];

/**
 * Authenticates the token of a websocket upgrade request before the `connection` handler runs.
 */
function verifyWebSocketClient(
  info: WebSocketVerifyInfo,
  dependencies: WebSocketAuthDependencies
): boolean {
  const request = info.req as AuthenticatedWebSocketRequest;
  const upgradeUrl = new URL(request.url ?? '/', 'http://localhost');
  const loggedUrl = new URL(upgradeUrl);
  if (loggedUrl.searchParams.has('token')) {
    loggedUrl.searchParams.set('token', 'REDACTED');
  }

  console.log('WebSocket connection attempt to:', `${loggedUrl.pathname}${loggedUrl.search}`);

  // Platform mode: use the first DB user and skip token checks.
  if (dependencies.isPlatform) {
    const user = dependencies.authenticateWebSocket(null, request);
    if (!user) {
      console.log('[WARN] Platform mode: No user found in database');
      return false;
    }

    request.user = user;
    console.log('[OK] Platform mode WebSocket authenticated for user:', user.username);
    return true;
  }

  // OSS mode: read JWT from query string first, then Authorization header.
  const token =
    upgradeUrl.searchParams.get('token') ??
    request.headers.authorization?.split(' ')[1] ??
    null;

  const user = dependencies.authenticateWebSocket(token, request);
  if (!user) {
    console.log('[WARN] WebSocket authentication failed');
    return false;
  }

  request.user = user;
  console.log('[OK] WebSocket authenticated for user:', user.username);
  return true;
}

/**
 * Used by this module's websocket server as its asynchronous `verifyClient`: runs the optional
 * edge check first (403 on refusal), then the token check (401 on refusal).
 */
export async function verifyWebSocketUpgrade(
  info: WebSocketVerifyInfo,
  dependencies: WebSocketAuthDependencies
): Promise<{ allowed: true } | { allowed: false; statusCode: 401 | 403 }> {
  if (dependencies.admitEdgeRequest && !(await dependencies.admitEdgeRequest(info.req))) {
    console.log('[WARN] WebSocket refused: Cloudflare Access assertion missing or invalid');
    return { allowed: false, statusCode: 403 };
  }
  return verifyWebSocketClient(info, dependencies) ? { allowed: true } : { allowed: false, statusCode: 401 };
}
